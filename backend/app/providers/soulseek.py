from app.providers.base import SearchProvider
from app.services import library_index, ranking
from app.services import settings as settings_service
from app.services.ratelimit import AsyncRateLimiter
from app.services.slskd import SlskdClient, SlskdError

# Soulseek drops the connection when searches are fired in bursts, and "Find on Soulseek" makes quick
# repeat searches easy, so search starts are serialized and spaced out.
search_limiter = AsyncRateLimiter(min_interval=3.0, max_concurrency=1)


def client_for(db, timeout: float = 15.0) -> SlskdClient:
    rs = settings_service.load(db)
    return SlskdClient(rs.slskd_url, rs.slskd_api_key, timeout=timeout)


class SoulseekProvider(SearchProvider):
    key = "soulseek"
    label = "Soulseek"

    async def status(self) -> dict:
        try:
            async with client_for(self.db, timeout=4.0) as c:
                s = await c.server_state()
        except SlskdError as e:
            return {"ok": False, "message": str(e)}
        if not s.get("isConnected"):
            return {"ok": False, "message": f"slskd is not connected to Soulseek ({s.get('state', 'unknown')})."}
        if not s.get("isLoggedIn"):
            return {"ok": False, "message": "slskd is connected but not logged in to Soulseek."}
        return {"ok": True, "message": "Connected to Soulseek."}

    async def start_search(self, query: str) -> str:
        async with search_limiter, client_for(self.db) as c:
            return await c.start_search(query)

    async def search_results(self, search_id: str) -> dict:
        async with client_for(self.db) as c:
            state = await c.search_state(search_id)
            responses = await c.search_responses(search_id)
        groups = ranking.build_groups(responses, library_index.current())
        return {
            "complete": bool(state.get("isComplete")),
            "state": state.get("state"),
            "response_count": state.get("responseCount", len(responses)),
            "groups": groups,
        }

    async def stop_search(self, search_id: str) -> None:
        async with client_for(self.db) as c:
            await c.stop_search(search_id)

    async def browse_folder(self, username: str, directory: str) -> dict | None:
        async with client_for(self.db) as c:
            files = await c.browse_directory(username, directory)
        groups = ranking.build_groups(
            [{"username": username, "files": files, "hasFreeUploadSlot": True}], library_index.current()
        )
        return groups[0] if groups else None
