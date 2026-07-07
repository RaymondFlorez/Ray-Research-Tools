"""RAG subsystem: geo-tagged retrieval (ARCHITECTURE §6.2, §7)."""

from .service import RagService, build_seeded_service
from .store import RagHit

__all__ = ["RagService", "build_seeded_service", "RagHit"]
