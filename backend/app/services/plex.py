"""Minimal async client for the Plex Media Server HTTP API."""

import httpx


class PlexError(Exception):
    pass


class PlexClient:
    def __init__(self, base_url: str, token: str, timeout: float = 10.0,
                 transport: httpx.AsyncBaseTransport | None = None):
        if not base_url:
            raise PlexError("Plex URL is not configured.")
        if not token:
            raise PlexError("Plex token is not configured.")
        self._client = httpx.AsyncClient(
            base_url=base_url.rstrip("/"),
            headers={"X-Plex-Token": token, "Accept": "application/json",
                     "X-Plex-Client-Identifier": "plexamp-library-manager", "X-Plex-Product": "Library Manager"},
            timeout=timeout,
            transport=transport,
        )

    async def __aenter__(self) -> "PlexClient":
        return self

    async def __aexit__(self, *exc) -> None:
        await self._client.aclose()

    async def _get(self, url: str, **params) -> dict:
        try:
            r = await self._client.get(url, params=params or None)
        except httpx.HTTPError as e:
            raise PlexError(f"Cannot reach Plex: {e.__class__.__name__}") from e
        if r.status_code == 401:
            raise PlexError("Plex rejected the token.")
        if r.status_code == 404:
            raise PlexError("Plex library section not found.")
        if r.status_code >= 400:
            raise PlexError(f"Plex error {r.status_code}")
        if not r.content:
            return {}
        try:
            return r.json()
        except ValueError:
            return {}

    async def identity(self) -> dict:
        data = await self._get("/identity")
        return data.get("MediaContainer", {})

    async def sections(self) -> list[dict]:
        data = await self._get("/library/sections")
        out = []
        for d in data.get("MediaContainer", {}).get("Directory", []) or []:
            out.append({
                "id": str(d.get("key")),
                "title": d.get("title"),
                "type": d.get("type"),
                "refreshing": bool(d.get("refreshing")),
                "locations": [loc.get("path") for loc in d.get("Location", []) or []],
                "scanned_at": d.get("scannedAt"),
            })
        return out

    async def section(self, section_id: str) -> dict | None:
        for s in await self.sections():
            if s["id"] == str(section_id):
                return s
        return None

    async def refresh(self, section_id: str, path: str | None = None) -> None:
        params = {"path": path} if path else {}
        await self._get(f"/library/sections/{section_id}/refresh", **params)

    async def albums(self, section_id: str) -> list[dict]:
        data = await self._get(f"/library/sections/{section_id}/all", type=9)
        return data.get("MediaContainer", {}).get("Metadata", []) or []

    async def counts(self, section_id: str) -> dict:
        out = {}
        for name, t in (("artists", 8), ("albums", 9), ("tracks", 10)):
            data = await self._get(f"/library/sections/{section_id}/all", type=t,
                                   **{"X-Plex-Container-Start": 0, "X-Plex-Container-Size": 0})
            mc = data.get("MediaContainer", {})
            out[name] = mc.get("totalSize", mc.get("size", 0))
        return out
