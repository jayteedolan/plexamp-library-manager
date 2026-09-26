import time

import httpx
import pytest
import respx

from app.config import get_settings
from app.services import library_index, ratelimit, spotify
from app.services.tags import suggest_destination
from tests.conftest import make_flac

API = "http://spotify.test/v1"
ACCOUNTS = "http://accounts.test"
ALBUM_ID = "4aawyAB9vmqN3uQ7FjRGTy"
ARTIST_ID = "0TnOYISbd1XYRBk9myaseg"
TRACK_ID = "6rqhFgbbKwnb9MLmUQDhG6"


@pytest.fixture(autouse=True)
def reset_spotify_state():
    spotify._token.update(key=None, value=None, expires=0.0)
    spotify._limiter.cooldown_until = 0.0
    spotify._limiter._next_start = 0.0
    yield


@pytest.fixture
def spotify_env(roots, monkeypatch):
    for k, v in {"SPOTIFY_CLIENT_ID": "cid", "SPOTIFY_CLIENT_SECRET": "secret", "SPOTIFY_MARKET": "US",
                 "SPOTIFY_API_URL": API, "SPOTIFY_ACCOUNTS_URL": ACCOUNTS}.items():
        monkeypatch.setenv(k, v)
    get_settings.cache_clear()
    return roots


def token_route():
    return respx.post(f"{ACCOUNTS}/api/token").mock(
        return_value=httpx.Response(200, json={"access_token": "tok", "expires_in": 3600}))


def album_json(name="hypochondriac", artist="brakence", tracks=3, album_id=ALBUM_ID, group=None, date="2022-12-02"):
    return {
        "id": album_id, "name": name, "album_type": "album", **({"album_group": group} if group else {}),
        "release_date": date, "total_tracks": tracks,
        "artists": [{"name": artist}], "images": [{"url": "big", "width": 640}, {"url": "mid", "width": 300}],
        "tracks": {"items": [{"id": f"t{i}", "name": f"Song {i}", "artists": [{"name": artist}],
                              "track_number": i, "duration_ms": 1000} for i in range(1, tracks + 1)],
                   "next": None},
    }


# ------------------------------------------------------------------------------------- link parsing

@pytest.mark.parametrize("text,expected", [
    (f"https://open.spotify.com/album/{ALBUM_ID}", ("album", ALBUM_ID)),
    (f"https://open.spotify.com/intl-de/track/{TRACK_ID}?si=abc123", ("track", TRACK_ID)),
    (f"open.spotify.com/artist/{ARTIST_ID}", ("artist", ARTIST_ID)),
    (f"  spotify:album:{ALBUM_ID} ", ("album", ALBUM_ID)),
    (f"https://open.spotify.com/embed/track/{TRACK_ID}", ("track", TRACK_ID)),
    ("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M", None),
    ("brakence hypochondriac", None),
])
def test_parse_link(text, expected):
    assert spotify.parse_link(text) == expected


def test_link_detection():
    assert spotify.is_short_link("https://spotify.link/AbC123")
    assert spotify.looks_like_link("https://spotify.link/AbC123")
    assert not spotify.looks_like_link("spotify wrapped")


def test_group_releases_dedupes_and_sorts():
    items = [
        album_json("Old Album", group="album", date="2019-01-01", album_id="a1"),
        album_json("New Album", group="album", date="2023-05-05", album_id="a2"),
        album_json("New Album", group="album", date="2023-05-05", album_id="a3"),  # clean/explicit duplicate
        album_json("Single", group="single", tracks=1, album_id="s1"),
        album_json("Hits", group="compilation", album_id="c1"),
        album_json("Feature", group="appears_on", album_id="x1"),
    ]
    g = spotify.group_releases(items)
    assert [a["id"] for a in g["albums"]] == ["a2", "a1"]
    assert [a["id"] for a in g["singles"]] == ["s1"] and [a["id"] for a in g["compilations"]] == ["c1"]
    assert g["albums"][0]["image"] == "mid"


# ----------------------------------------------------------------------------------- client + limits

@respx.mock
async def test_token_is_cached_across_calls():
    tok = token_route()
    respx.get(f"{API}/artists/{ARTIST_ID}").mock(return_value=httpx.Response(200, json={"id": ARTIST_ID,
                                                                                         "name": "brakence"}))
    async with spotify.SpotifyClient("cid", "secret", api_url=API, accounts_url=ACCOUNTS) as c:
        await c.artist(ARTIST_ID)
        await c.artist(ARTIST_ID)
    assert tok.call_count == 1


@respx.mock
async def test_short_retry_after_waits_then_succeeds():
    token_route()
    route = respx.get(f"{API}/artists/{ARTIST_ID}").mock(side_effect=[
        httpx.Response(429, headers={"Retry-After": "0"}),
        httpx.Response(200, json={"id": ARTIST_ID, "name": "brakence"}),
    ])
    async with spotify.SpotifyClient("cid", "secret", api_url=API, accounts_url=ACCOUNTS) as c:
        assert (await c.artist(ARTIST_ID))["name"] == "brakence"
    assert route.call_count == 2


@respx.mock
async def test_long_retry_after_fails_fast():
    token_route()
    limited = httpx.Response(429, headers={"Retry-After": "120"})
    route = respx.get(f"{API}/artists/{ARTIST_ID}").mock(return_value=limited)
    start = time.monotonic()
    async with spotify.SpotifyClient("cid", "secret", api_url=API, accounts_url=ACCOUNTS) as c:
        with pytest.raises(ratelimit.RateLimited) as e:
            await c.artist(ARTIST_ID)
        # The cooldown is remembered: the next call fails without contacting Spotify again.
        with pytest.raises(ratelimit.RateLimited):
            await c.artist(ARTIST_ID)
    assert e.value.retry_after == 120
    assert route.call_count == 1
    assert time.monotonic() - start < 2


@respx.mock
async def test_bad_credentials_message():
    respx.post(f"{ACCOUNTS}/api/token").mock(return_value=httpx.Response(400, json={"error": "invalid_client"}))
    async with spotify.SpotifyClient("cid", "wrong", api_url=API, accounts_url=ACCOUNTS) as c:
        with pytest.raises(spotify.SpotifyError, match="rejected the Client ID"):
            await c.check()


@respx.mock
async def test_album_follows_track_pages():
    token_route()
    first = album_json(tracks=2)
    first["total_tracks"] = 3
    first["tracks"]["next"] = f"{API}/albums/{ALBUM_ID}/tracks?offset=2"
    respx.get(f"{API}/albums/{ALBUM_ID}").mock(return_value=httpx.Response(200, json=first))
    respx.get(f"{API}/albums/{ALBUM_ID}/tracks").mock(return_value=httpx.Response(200, json={
        "items": [{"id": "t3", "name": "Song 3", "artists": [{"name": "brakence"}], "track_number": 3}], "next": None}))
    async with spotify.SpotifyClient("cid", "secret", api_url=API, accounts_url=ACCOUNTS) as c:
        album = await c.album(ALBUM_ID)
    assert [t["name"] for t in album["tracks"]] == ["Song 1", "Song 2", "Song 3"]


async def test_rate_limiter_spaces_requests():
    limiter = ratelimit.AsyncRateLimiter(min_interval=0.05, max_concurrency=1)
    starts = []
    for _ in range(3):
        async with limiter:
            starts.append(time.monotonic())
    assert starts[2] - starts[0] >= 0.09


# --------------------------------------------------------------------------------------- API routes

@respx.mock
def test_catalog_routes_cache_and_hints(authed, spotify_env):
    roots = spotify_env
    album_dir = roots["library"] / "brakence" / "hypochondriac"
    album_dir.mkdir(parents=True)
    for i in range(3):
        (album_dir / f"{i}.flac").touch()
    idx = library_index.LibraryIndex()
    idx.add("brakence", "hypochondriac", 3)
    library_index.replace(idx)

    token_route()
    album_route = respx.get(f"{API}/albums/{ALBUM_ID}").mock(return_value=httpx.Response(200, json=album_json()))
    respx.get(f"{API}/artists/{ARTIST_ID}").mock(return_value=httpx.Response(200, json={"id": ARTIST_ID,
                                                                                         "name": "brakence"}))
    respx.get(f"{API}/artists/{ARTIST_ID}/albums").mock(return_value=httpx.Response(200, json={
        "items": [album_json(group="album"), album_json("ready or noT", tracks=1, group="single", album_id="s1")],
        "next": None}))

    r = authed.get(f"/api/catalog/album/{ALBUM_ID}")
    assert r.status_code == 200, r.text
    assert r.json()["in_library"] == "full" and len(r.json()["tracks"]) == 3
    # Second visit is served from the cache: no new request to Spotify.
    assert authed.get(f"/api/catalog/album/{ALBUM_ID}").json()["name"] == "hypochondriac"
    assert album_route.call_count == 1

    artist = authed.get(f"/api/catalog/artist/{ARTIST_ID}").json()
    assert artist["name"] == "brakence"
    assert artist["releases"]["albums"][0]["in_library"] == "full"
    assert artist["releases"]["singles"][0]["in_library"] is None

    # Emptying the album folder drops the hint straight away, cache or not.
    for f in album_dir.iterdir():
        f.unlink()
    assert authed.get(f"/api/catalog/album/{ALBUM_ID}").json()["in_library"] is None


@respx.mock
def test_catalog_search_link_and_rate_limit(authed, spotify_env):
    r = authed.get("/api/catalog/search", params={"q": f"https://open.spotify.com/album/{ALBUM_ID}?si=x"})
    assert r.json() == {"link": {"kind": "album", "id": ALBUM_ID}}

    token_route()
    respx.get(f"{API}/search").mock(return_value=httpx.Response(429, headers={"Retry-After": "90"}))
    r = authed.get("/api/catalog/search", params={"q": "brakence"})
    assert r.status_code == 429
    assert r.json()["extra"]["retry_after"] == 91


def test_catalog_status_when_not_configured(authed):
    s = authed.get("/api/catalog/status").json()
    assert s["configured"] is False and s["ok"] is False


@respx.mock
def test_download_hint_used_when_tags_missing(authed, spotify_env):
    roots = spotify_env
    respx.post("http://slskd.test/api/v0/transfers/downloads/u").mock(return_value=httpx.Response(201))
    job = authed.post("/api/downloads", json={
        "username": "u", "directory": "stuff\\x", "files": [{"filename": "stuff\\x\\01.flac", "size": 1}],
        "catalog": {"artist": "brakence", "album": "hypochondriac"}}).json()
    from app.db import session_scope
    from app.models import DownloadFile, DownloadJob

    local = make_flac(roots["staging"] / "x" / "01.flac")  # untagged
    with session_scope() as db:
        db.get(DownloadJob, job["id"]).status = "ready"
        f = db.query(DownloadFile).filter(DownloadFile.job_id == job["id"]).one()
        f.state, f.local_path = "completed", str(local)
    s = authed.get(f"/api/downloads/{job['id']}/suggest").json()
    assert s["source"] == "catalog" and s["path"] == "library/brakence/hypochondriac"


def test_suggest_destination_prefers_tags_over_hint(roots):
    f = make_flac(roots["staging"] / "y" / "1.flac", artist="Tagged Artist", album="Tagged Album")
    s = suggest_destination([f], "x\\y", hint={"artist": "Hint", "album": "Hint Album"})
    assert s["source"] == "tags" and s["path"] == "library/Tagged Artist/Tagged Album"


@respx.mock
async def test_artist_releases_respects_spotify_page_limit():
    """Spotify returns 400 "Invalid limit" above 10 per page for artist albums; page through instead."""
    token_route()

    def artist_albums(request):
        limit = int(request.url.params.get("limit", 20))
        if limit > 10:
            return httpx.Response(400, json={"error": {"status": 400, "message": "Invalid limit"}})
        offset = int(request.url.params.get("offset", 0))
        items = [album_json(f"Album {i}", group="album", album_id=f"a{i:02d}", date=f"20{i:02d}-01-01")
                 for i in range(offset, min(offset + limit, 13))]
        nxt = f"{API}/artists/{ARTIST_ID}/albums?offset={offset + limit}&limit={limit}" if offset + limit < 13 else None
        return httpx.Response(200, json={"items": items, "next": nxt})

    route = respx.get(f"{API}/artists/{ARTIST_ID}/albums").mock(side_effect=artist_albums)
    async with spotify.SpotifyClient("cid", "secret", api_url=API, accounts_url=ACCOUNTS) as c:
        releases = await c.artist_releases(ARTIST_ID)
    assert len(releases["albums"]) == 13 and route.call_count == 2


@respx.mock
async def test_bad_request_shows_spotifys_message():
    token_route()
    respx.get(f"{API}/artists/{ARTIST_ID}").mock(
        return_value=httpx.Response(400, json={"error": {"status": 400, "message": "Invalid limit"}}))
    async with spotify.SpotifyClient("cid", "secret", api_url=API, accounts_url=ACCOUNTS) as c:
        with pytest.raises(spotify.SpotifyError, match="Invalid limit"):
            await c.artist(ARTIST_ID)
