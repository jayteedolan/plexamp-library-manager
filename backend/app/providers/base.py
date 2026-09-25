"""Search source abstraction.

Soulseek is the only source in v1. A later source (for example a lossless streaming-service
downloader) implements this interface, downloads into staging, and reuses the same Downloads and
filing flow. The UI shows one toggle button per registered provider.
"""

from abc import ABC, abstractmethod

from sqlalchemy.orm import Session


class SearchProvider(ABC):
    key: str = ""
    label: str = ""

    def __init__(self, db: Session):
        self.db = db

    @abstractmethod
    async def status(self) -> dict:
        """{'ok': bool, 'message': str} describing whether the source is usable right now."""

    @abstractmethod
    async def start_search(self, query: str) -> str:
        """Start a search and return its id. Results are fetched with `search_results`."""

    @abstractmethod
    async def search_results(self, search_id: str) -> dict:
        """{'complete': bool, 'response_count': int, 'groups': [...]} (see ranking.build_groups)."""

    @abstractmethod
    async def stop_search(self, search_id: str) -> None: ...

    @abstractmethod
    async def browse_folder(self, username: str, directory: str) -> dict | None:
        """A single result group listing every file in the remote folder."""
