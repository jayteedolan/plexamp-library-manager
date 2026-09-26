"""Spotify catalog browsing: cached lookups plus live "already in library" hints.

Raw (trimmed) Spotify data is cached in SQLite so revisiting a page costs no requests. The in-library
hints are computed fresh on every response, since the library changes independently of Spotify.
"""

from collections.abc import Awaitable, Callable
from datetime import timedelta
from typing import Any

from sqlalchemy.orm import Session

from app.config import get_settings
from app.services import cache, library_index
from app.services import settings as settings_service
from app.services.spotify import SpotifyClient, SpotifyError, is_short_link, looks_like_link, parse_link

TTL_ITEM = timedelta(days=7)
TTL_RELEASES = timedelta(days=1)
TTL_SEARCH = timedelta(hours=1)


def client_for(db: Session) -> SpotifyClient:
    rs = settings_service.load(db)
    env = get_settings()
    return SpotifyClient(rs.spotify_client_id, rs.spotify_client_secret, rs.spotify_market,
                         api_url=env.spotify_api_url, accounts_url=env.spotify_accounts_url)


async def _cached(db: Session, key: str, ttl: timedelta, fetch: Callable[[], Awaitable[Any]]) -> Any:
    hit = cache.get(db, key)
    if hit is not None:
        return hit
    value = await fetch()
    cache.put(db, key, value, ttl)
    return value


def _key(db: Session, *parts: str) -> str:
    return ":".join(["spotify", settings_service.load(db).spotify_market, *parts])


def release_hint(artists: list[str], name: str, track_count: int) -> str | None:
    """Library folders are named after the album artist; collaborations may be joined with '&' or ','."""
    idx = library_index.current()
    candidates = [*artists[:1], " & ".join(artists), ", ".join(artists)] if artists else [None]
    for artist in dict.fromkeys(candidates):
        hint = idx.match_release(artist, name, track_count)
        if hint:
            return hint
    return None


def _hint(album: dict) -> dict:
    return {**album, "in_library": release_hint(album["artists"], album["name"], album["total_tracks"])}


async def status(db: Session) -> dict:
    rs = settings_service.load(db)
    if not (rs.spotify_client_id and rs.spotify_client_secret):
        return {"configured": False, "ok": False, "message": "Add your Spotify Client ID and Secret in Settings."}
    try:
        async with client_for(db) as c:
            await c.check()
    except SpotifyError as e:
        return {"configured": True, "ok": False, "message": str(e)}
    return {"configured": True, "ok": True, "message": "Connected to Spotify."}


async def search(db: Session, q: str) -> dict:
    q = q.strip()
    if looks_like_link(q):
        link = parse_link(q)
        if link is None and is_short_link(q):
            async with client_for(db) as c:
                link = await c.resolve_short_link(q)
        if link is None:
            raise SpotifyError("That doesn't look like a Spotify track, album or artist link.")
        return {"link": {"kind": link[0], "id": link[1]}}

    async def fetch():
        async with client_for(db) as c:
            return await c.search(q)

    data = await _cached(db, _key(db, "search", q.lower()), TTL_SEARCH, fetch)
    return {
        "albums": [_hint(a) for a in data["albums"]],
        "artists": data["artists"],
        "tracks": [{**t, "album": _hint(t["album"])} if t.get("album") else t for t in data["tracks"]],
    }


async def album(db: Session, album_id: str) -> dict:
    async def fetch():
        async with client_for(db) as c:
            return await c.album(album_id)

    return _hint(await _cached(db, _key(db, "album", album_id), TTL_ITEM, fetch))


async def artist(db: Session, artist_id: str) -> dict:
    async def fetch_artist():
        async with client_for(db) as c:
            return await c.artist(artist_id)

    async def fetch_releases():
        async with client_for(db) as c:
            return await c.artist_releases(artist_id)

    info = await _cached(db, _key(db, "artist", artist_id), TTL_ITEM, fetch_artist)
    releases = await _cached(db, _key(db, "artist-releases", artist_id), TTL_RELEASES, fetch_releases)
    return {**info, "releases": {k: [_hint(a) for a in v] for k, v in releases.items()}}


async def track(db: Session, track_id: str) -> dict:
    async def fetch():
        async with client_for(db) as c:
            return await c.track(track_id)

    t = await _cached(db, _key(db, "track", track_id), TTL_ITEM, fetch)
    return {**t, "album": _hint(t["album"])} if t.get("album") else t
