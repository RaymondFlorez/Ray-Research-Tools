import pytest
from fastapi.testclient import TestClient

from geoglobe_api.main import create_app
from geoglobe_api.repository import InMemoryRepository


@pytest.fixture
def client() -> TestClient:
    app = create_app(repository=InMemoryRepository())
    return TestClient(app)
