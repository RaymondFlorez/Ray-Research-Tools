"""FastAPI app exposing the internal Data Service API (ARCHITECTURE §4)."""

from __future__ import annotations

from fastapi import Depends, FastAPI, HTTPException, Response, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from .agent.executor import ToolExecutor
from .agent.orchestrator import Orchestrator
from .config import Settings, get_settings
from .models import (
    Catalog,
    GeoQueryRequest,
    GeoQueryResponse,
    RagHitModel,
    RagSearchRequest,
    RagSearchResponse,
    SqlQueryRequest,
    SqlQueryResponse,
)
from .rag import RagService, build_seeded_service
from .repository import DataRepository, InMemoryRepository, UnsupportedOperation

_rag_singleton: RagService | None = None


def get_rag() -> RagService:
    global _rag_singleton
    if _rag_singleton is None:
        _rag_singleton = build_seeded_service()
    return _rag_singleton
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

    @app.post("/rag/search", response_model=RagSearchResponse)
    def rag_search(req: RagSearchRequest, rag: RagService = Depends(get_rag)) -> RagSearchResponse:
        hits = rag.search(req.query, bbox=req.bbox, k=req.k)
        return RagSearchResponse(
            hits=[
                RagHitModel(
                    doc_id=h.doc_id,
                    title=h.title,
                    text=h.text,
                    longitude=h.longitude,
                    latitude=h.latitude,
                    score=h.score,
                )
                for h in hits
            ]
        )

    @app.websocket("/ws/agent")
    async def agent_ws(ws: WebSocket) -> None:
        """Stream the agent loop: receive {query}, emit text/tool_use/patch/done events."""
        await ws.accept()
        settings = get_settings()
        repo = get_repository()
        try:
            from .agent.llm import AnthropicLLMClient

            llm = AnthropicLLMClient(api_key=settings.anthropic_api_key)
        except Exception as exc:  # SDK missing or no credentials
            await ws.send_json({"type": "error", "data": {"message": f"agent unavailable: {exc}"}})
            await ws.close()
            return

        orchestrator = Orchestrator(
            llm=llm,
            executor=ToolExecutor(repo, rag=get_rag()),
            planner_model=settings.agent_planner_model,
            fast_model=settings.agent_fast_model,
            max_turns=settings.agent_max_turns,
        )
        try:
            while True:
                payload = await ws.receive_json()
                query = payload.get("query", "")
                if not query:
                    continue
                for event in orchestrator.run(query):
                    await ws.send_json({"type": event.type, "data": event.data})
        except WebSocketDisconnect:
            return
        except Exception as exc:
            await ws.send_json({"type": "error", "data": {"message": str(exc)}})

    return app


app = create_app()
