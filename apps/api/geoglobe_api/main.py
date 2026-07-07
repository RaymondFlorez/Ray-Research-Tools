"""FastAPI app exposing the internal Data Service API (ARCHITECTURE §4)."""

from __future__ import annotations

from fastapi import Depends, FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware

from .config import Settings, get_settings
from .models import Catalog, GeoQueryRequest, GeoQueryResponse, SqlQueryRequest, SqlQueryResponse
from .repository import DataRepository, InMemoryRepository, UnsupportedOperation
from .sql_guard import SqlNotAllowed, validate_read_only_sql
from .tiles import InvalidTile, validate_tile

_repo_singleton: DataRepository | None = None


def build_repository(settings: Settings) -> DataRepository:
    if settings.database_url:
        from .postgis import PostgisRepository  # imported lazily so tests need no DB driver

        return PostgisRepository()
    return InMemoryRepository()


def get_repository() -> DataRepository:
    global _repo_singleton
    if _repo_singleton is None:
        _repo_singleton = build_repository(get_settings())
    return _repo_singleton


def create_app(repository: DataRepository | None = None) -> FastAPI:
    app = FastAPI(title="GeoGlobe Data Service", version="0.1.0")
    settings = get_settings()

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["GET", "POST"],
        allow_headers=["*"],
    )

    if repository is not None:
        global _repo_singleton
        _repo_singleton = repository

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/layers/catalog", response_model=Catalog)
    def catalog(repo: DataRepository = Depends(get_repository)) -> Catalog:
        return Catalog(datasets=repo.catalog())

    @app.post("/query/geo", response_model=GeoQueryResponse)
    def query_geo(
        req: GeoQueryRequest,
        repo: DataRepository = Depends(get_repository),
        settings: Settings = Depends(get_settings),
    ) -> GeoQueryResponse:
        if req.limit > settings.max_rows:
            req.limit = settings.max_rows
        try:
            return repo.query_geo(req)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.post("/query/sql", response_model=SqlQueryResponse)
    def query_sql(
        req: SqlQueryRequest,
        repo: DataRepository = Depends(get_repository),
    ) -> SqlQueryResponse:
        try:
            validate_read_only_sql(req.sql)  # reject early with a clear 400
        except SqlNotAllowed as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        try:
            cols, rows = repo.query_sql(req.sql, req.limit)
        except UnsupportedOperation as exc:
            raise HTTPException(status_code=501, detail=str(exc)) from exc
        return SqlQueryResponse(columns=cols, rows=rows)

    @app.get("/tiles/{layer}/{z}/{x}/{y}.mvt")
    def tiles(
        layer: str, z: int, x: int, y: int, repo: DataRepository = Depends(get_repository)
    ) -> Response:
        try:
            validate_tile(z, x, y)  # reject bad coordinates before touching the repo
            data = repo.mvt_tile(layer, z, x, y)
        except InvalidTile as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except UnsupportedOperation as exc:
            raise HTTPException(status_code=501, detail=str(exc)) from exc
        return Response(content=data, media_type="application/vnd.mapbox-vector-tile")

    return app


app = create_app()
