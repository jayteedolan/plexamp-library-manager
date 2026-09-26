"""Spotify Web API client (official API, client-credentials flow) for catalog browsing.

Only metadata: search, albums, artists and their releases, tracks. Downloads still come from Soulseek.
Responses are trimmed to what the UI shows. Nothing here needs per-track lookups (no ISRCs), so an
album or artist page costs one or two requests.
"""

import re
import time

import httpx

from app.services.library_index import normalize
from app.services.ratelimit import AsyncRateLimiter, RateLimited, request_with_backoff

SERVICE = "Spotify"
_ID = r"([A-Za-z0-9]{22})"
_URL_RE = re.compile(
    r"(?:https?://)?open\.spotify\.com/(?:intl-[a-zA-Z-]+/)?(?:embed/)?(track|album|artist)/" + _ID
)
_URI_RE = re.compile(r"spotify:(track|album|artist):" + _ID)
_SHORT_RE = re.compile(r"(?:https?://)?spotify\.link/[A-Za-z0-9]+")

# Shared by every client instance: at most 2 requests in flight, starts at least 100ms apart, and a
# common cooldown after a 429.
_limiter = AsyncRateLimiter(min_interval=0.1, max_concurrency=2)
_token: dict = {"key": None, "value": None, "expires": 0.0}


class SpotifyError(Exception):
    pass


def parse_link(text: str) -> tuple[str, str] | None:
    """(kind, id) for an open.spotify.com URL or spotify: URI anywhere in `text`, else None."""
    text = text.strip()
    for rx in (_URL_RE, _URI_RE):
        m = rx.search(text)
        if m:
            return m.group(1), m.group(2)
    return None


def is_short_link(text: str) -> bool:
    return bool(_SHORT_RE.search(text.strip()))


def looks_like_link(text: str) -> bool:
    t = text.strip().lower()
    return "spotify.com/" in t or t.startswith("spotify:") or "spotify.link/" in t


# ------------------------------------------------------------------------------------------ trimming

def _image(images: list[dict] | None) -> str | None:
    if not images:
        return None
    # Images come largest first; take the one closest to 300px for cards.
    best = min(images, key=lambda i: abs((i.get("width") or 300) - 300))
    return best.get("url")


def _year(release_date: str | None) -> str | None:
    return release_date[:4] if release_date else None


def album_summary(a: dict) -> dict:
    artists = [x.get("name", "") for x in a.get("artists") or []]
    return {
        "id": a.get("id"),
        "name": a.get("name", ""),
        "artists": artists,
        "artist": ", ".join(artists),
        "type": a.get("album_group") or a.get("album_type") or "album",
        "release_date": a.get("release_date"),
        "year": _year(a.get("release_date")),
        "total_tracks": a.get("total_tracks") or 0,
        "image": _image(a.get("images")),
        "url": (a.get("external_urls") or {}).get("spotify"),
    }


def artist_summary(a: dict) -> dict:
    return {
        "id": a.get("id"),
        "name": a.get("name", ""),
        "image": _image(a.get("images")),
        "genres": (a.get("genres") or [])[:3],
        "url": (a.get("external_urls") or {}).get("spotify"),
    }


def track_summary(t: dict, include_album: bool = True) -> dict:
    artists = [x.get("name", "") for x in t.get("artists") or []]
    out = {
        "id": t.get("id"),
        "name": t.get("name", ""),
        "artists": artists,
        "artist": ", ".join(artists),
        "track_number": t.get("track_number"),
        "disc_number": t.get("disc_number") or 1,
        "duration_ms": t.get("duration_ms"),
        "explicit": bool(t.get("explicit")),
    }
    if include_album and t.get("album"):
        out["album"] = album_summary(t["album"])
    return out


def group_releases(items: list[dict]) -> dict:
    """Split artist releases into albums / singles / compilations, dropping duplicates, newest first.

    Spotify often lists the same release more than once (explicit and clean versions, regional
    re-issues); those share a normalized name, type and track count.
    """
    groups: dict[str, list[dict]] = {"album": [], "single": [], "compilation": []}
    seen: set[tuple] = set()
    for raw in items:
        a = album_summary(raw)
        if a["type"] not in groups:
            continue  # "appears_on" is excluded by the request, but be safe
        key = (normalize(a["name"]), a["type"], a["total_tracks"])
        if key in seen:
            continue
        seen.add(key)
        groups[a["type"]].append(a)
    for releases in groups.values():
        releases.sort(key=lambda r: r["release_date"] or "", reverse=True)
    return {"albums": groups["album"], "singles": groups["single"], "compilations": groups["compilation"]}


# -------------------------------------------------------------------------------------------- client

class SpotifyClient:
    def __init__(self, client_id: str, client_secret: str, market: str = "US",
                 api_url: str = "https://api.spotify.com/v1", accounts_url: str = "https://accounts.spotify.com",
                 transport: httpx.AsyncBaseTransport | None = None):
        if not client_id or not client_secret:
            raise SpotifyError("Spotify isn't set up yet. Add your Client ID and Secret in Settings.")
        self.client_id = client_id
        self.client_secret = client_secret
        self.market = market
        self.api_url = api_url.rstrip("/")
        self.accounts_url = accounts_url.rstrip("/")
        self._client = httpx.AsyncClient(timeout=10.0, transport=transport)

    async def __aenter__(self) -> "SpotifyClient":
        return self

    async def __aexit__(self, *exc) -> None:
        await self._client.aclose()

    async def _access_token(self, force: bool = False) -> str:
        cache_key = (self.client_id, self.client_secret, self.accounts_url)
        if not force and _token["key"] == cache_key and _token["value"] and time.monotonic() < _token["expires"]:
            return _token["value"]
        r = await request_with_backoff(
            self._client, _limiter, SERVICE, "POST", f"{self.accounts_url}/api/token",
            data={"grant_type": "client_credentials"}, auth=(self.client_id, self.client_secret),
        )
        if r.status_code in (400, 401):
            raise SpotifyError("Spotify rejected the Client ID/Secret. Check them in Settings.")
        if r.status_code >= 400:
            raise SpotifyError(f"Spotify login failed ({r.status_code}).")
        data = r.json()
        _token.update(key=cache_key, value=data["access_token"],
                      expires=time.monotonic() + max(60, int(data.get("expires_in", 3600)) - 60))
        return _token["value"]

    async def _get(self, path_or_url: str, params: dict | None = None) -> dict:
        url = path_or_url if path_or_url.startswith("http") else f"{self.api_url}{path_or_url}"
        for attempt in range(2):
            token = await self._access_token(force=attempt > 0)
            r = await request_with_backoff(self._client, _limiter, SERVICE, "GET", url, params=params,
                                           headers={"Authorization": f"Bearer {token}"})
            if r.status_code == 401 and attempt == 0:
                continue  # token expired or revoked early: refresh once
            if r.status_code in (400, 404):
                raise SpotifyError("Spotify couldn't find that item.")
            if r.status_code >= 400:
                raise SpotifyError(f"Spotify error {r.status_code}.")
            return r.json()
        raise SpotifyError("Spotify rejected the access token.")

    async def check(self) -> None:
        await self._access_token(force=True)

    async def search(self, q: str, limit: int = 10) -> dict:
        data = await self._get("/search", {"q": q, "type": "album,artist,track", "limit": limit,
                                           "market": self.market})
        return {
            "albums": [album_summary(a) for a in (data.get("albums") or {}).get("items") or [] if a],
            "artists": [artist_summary(a) for a in (data.get("artists") or {}).get("items") or [] if a],
            "tracks": [track_summary(t) for t in (data.get("tracks") or {}).get("items") or [] if t],
        }

    async def album(self, album_id: str) -> dict:
        data = await self._get(f"/albums/{album_id}", {"market": self.market})
        page = data.get("tracks") or {}
        items = list(page.get("items") or [])
        nxt = page.get("next")
        while nxt:
            page = await self._get(nxt)
            items.extend(page.get("items") or [])
            nxt = page.get("next")
        out = album_summary(data)
        out["label"] = data.get("label")
        out["tracks"] = [track_summary(t, include_album=False) for t in items if t]
        return out

    async def artist(self, artist_id: str) -> dict:
        return artist_summary(await self._get(f"/artists/{artist_id}"))

    async def artist_releases(self, artist_id: str) -> dict:
        # Follow `next` links rather than assuming a page size; Spotify has changed limits before.
        page = await self._get(f"/artists/{artist_id}/albums",
                               {"include_groups": "album,single,compilation", "market": self.market, "limit": 50})
        items = list(page.get("items") or [])
        nxt = page.get("next")
        while nxt and len(items) < 500:
            page = await self._get(nxt)
            items.extend(page.get("items") or [])
            nxt = page.get("next")
        return group_releases(items)

    async def track(self, track_id: str) -> dict:
        return track_summary(await self._get(f"/tracks/{track_id}", {"market": self.market}))

    async def resolve_short_link(self, url: str) -> tuple[str, str] | None:
        """spotify.link/… short links redirect (sometimes via an HTML page) to open.spotify.com."""
        if not url.startswith("http"):
            url = "https://" + url
        try:
            async with _limiter:
                r = await self._client.get(url, follow_redirects=True)
        except httpx.HTTPError as e:
            raise SpotifyError(f"Couldn't open that link ({e.__class__.__name__}).") from e
        return parse_link(str(r.url)) or parse_link(r.text[:20000])


__all__ = ["SpotifyClient", "SpotifyError", "RateLimited", "parse_link", "is_short_link", "looks_like_link",
           "group_releases"]
