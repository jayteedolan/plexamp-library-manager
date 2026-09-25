"""Minimal async client for the slskd REST API (v0)."""

import uuid
from urllib.parse import quote

import httpx


class SlskdError(Exception):
    pass


# slskd transfer states -> our simplified file states
def map_state(state: str | None) -> str:
    s = (state or "").lower()
    if "succeeded" in s:
        return "completed"
    if "cancelled" in s:
        return "cancelled"
    if s.startswith("completed"):  # TimedOut, Errored, Rejected, Aborted
        return "failed"
    if "inprogress" in s.replace(" ", "") or "initializing" in s:
        return "downloading"
    return "queued"  # Requested, Queued (Locally|Remotely)


class SlskdClient:
    def __init__(self, base_url: str, api_key: str, timeout: float = 15.0,
                 transport: httpx.AsyncBaseTransport | None = None):
        if not base_url:
            raise SlskdError("slskd URL is not configured.")
        self._client = httpx.AsyncClient(
            base_url=base_url.rstrip("/") + "/api/v0",
            headers={"X-API-Key": api_key} if api_key else {},
            timeout=timeout,
            transport=transport,
        )

    async def __aenter__(self) -> "SlskdClient":
        return self

    async def __aexit__(self, *exc) -> None:
        await self._client.aclose()

    async def _request(self, method: str, url: str, **kw) -> httpx.Response:
        try:
            r = await self._client.request(method, url, **kw)
        except httpx.HTTPError as e:
            raise SlskdError(f"Cannot reach slskd: {e.__class__.__name__}") from e
        if r.status_code == 401 or r.status_code == 403:
            raise SlskdError("slskd rejected the API key.")
        if r.status_code >= 400:
            raise SlskdError(f"slskd error {r.status_code}: {r.text[:200]}")
        return r

    async def server_state(self) -> dict:
        r = await self._request("GET", "/server")
        return r.json()

    async def start_search(self, text: str, timeout_ms: int = 25000) -> str:
        search_id = str(uuid.uuid4())
        await self._request("POST", "/searches", json={
            "id": search_id,
            "searchText": text,
            "searchTimeout": timeout_ms,
            "responseLimit": 250,
            "fileLimit": 20000,
            "filterResponses": True,
            "minimumResponseFileCount": 1,
        })
        return search_id

    async def search_state(self, search_id: str) -> dict:
        r = await self._request("GET", f"/searches/{search_id}")
        return r.json()

    async def search_responses(self, search_id: str) -> list[dict]:
        r = await self._request("GET", f"/searches/{search_id}/responses")
        return r.json()

    async def stop_search(self, search_id: str) -> None:
        await self._request("PUT", f"/searches/{search_id}")

    async def delete_search(self, search_id: str) -> None:
        await self._request("DELETE", f"/searches/{search_id}")

    async def browse_directory(self, username: str, directory: str) -> list[dict]:
        """Files in one remote folder (search responses often only include the matching files)."""
        r = await self._request("POST", f"/users/{quote(username, safe='')}/directory",
                                json={"directory": directory}, timeout=60.0)
        data = r.json()
        dirs = data if isinstance(data, list) else [data]
        files: list[dict] = []
        for d in dirs:
            base = d.get("name") or directory
            for f in d.get("files") or []:
                name = f.get("filename", "")
                # Browse results carry bare file names; make them full remote paths like search results.
                if "\\" not in name and "/" not in name:
                    f = {**f, "filename": f"{base}\\{name}"}
                files.append(f)
        return files

    async def enqueue(self, username: str, files: list[dict]) -> None:
        await self._request("POST", f"/transfers/downloads/{quote(username, safe='')}",
                            json=[{"filename": f["filename"], "size": f["size"]} for f in files])

    async def downloads(self) -> list[dict]:
        """Flattened list of all download transfers."""
        r = await self._request("GET", "/transfers/downloads")
        out = []
        for user in r.json() or []:
            for d in user.get("directories") or []:
                for f in d.get("files") or []:
                    out.append({**f, "username": f.get("username") or user.get("username")})
        return out

    async def cancel(self, username: str, transfer_id: str, remove: bool = False) -> None:
        await self._request("DELETE", f"/transfers/downloads/{quote(username, safe='')}/{transfer_id}",
                            params={"remove": str(remove).lower()})
