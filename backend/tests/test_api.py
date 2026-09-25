import httpx
import respx

from app.db import session_scope
from app.services import downloads
from tests.conftest import make_flac


def test_setup_login_and_csrf(client):
    assert client.get("/api/auth/status").json()["setup_required"] is True
    assert client.get("/api/files").status_code == 401
    r = client.post("/api/auth/setup", json={"username": "admin", "password": "short"})
    assert r.status_code == 400
    r = client.post("/api/auth/setup", json={"username": "admin", "password": "correct horse battery"})
    assert r.status_code == 200
    again = client.post("/api/auth/setup", json={"username": "x", "password": "correct horse battery"})
    assert again.status_code == 409
    assert client.get("/api/auth/status").json()["authenticated"] is True
    # Missing CSRF header on a mutating request.
    r = client.post("/api/files/mkdir", json={"parent": "library", "name": "x"}, headers={"X-Requested-With": ""})
    assert r.status_code == 403
    client.post("/api/auth/logout")
    assert client.get("/api/files").status_code == 401


def test_login_rate_limit(client):
    from app import auth

    auth.limiter._failures.clear()
    client.post("/api/auth/setup", json={"username": "admin", "password": "correct horse battery"})
    client.post("/api/auth/logout")
    for _ in range(5):
        assert client.post("/api/auth/login", json={"username": "admin", "password": "nope"}).status_code == 401
    r = client.post("/api/auth/login", json={"username": "admin", "password": "correct horse battery"})
    assert r.status_code == 429
    auth.limiter._failures.clear()
    assert client.post("/api/auth/login", json={"username": "admin", "password": "correct horse battery"}).is_success


def test_explorer_endpoints(authed, roots):
    c = authed
    assert c.post("/api/files/mkdir", json={"parent": "library", "name": "Artist"}).is_success
    (roots["staging"] / "a.flac").write_bytes(b"1")
    (roots["library"] / "Artist" / "a.flac").write_bytes(b"22")
    r = c.post("/api/files/transfer", json={"sources": ["staging/a.flac"], "destination": "library/Artist",
                                            "mode": "move"})
    assert r.status_code == 409
    assert r.json()["extra"]["conflicts"][0]["name"] == "a.flac"
    r = c.post("/api/files/transfer", json={"sources": ["staging/a.flac"], "destination": "library/Artist",
                                            "mode": "move", "resolutions": {"a.flac": "replace"}})
    assert r.status_code == 200 and r.json()["finished"] is True, r.text
    assert (roots["library"] / "Artist" / "a.flac").read_bytes() == b"1"
    trash = c.get("/api/trash").json()
    assert len(trash["items"]) == 1  # the replaced file went to the trash
    r = c.post("/api/files/delete", json={"paths": ["library/Artist/a.flac"]})
    assert r.is_success
    assert len(c.get("/api/trash").json()["items"]) == 2
    listing = c.get("/api/files", params={"path": "library/Artist"}).json()
    assert listing["entries"] == []
    assert c.get("/api/files", params={"path": "library/../.."}).status_code == 400


SLSKD = "http://slskd.test/api/v0"


@respx.mock
def test_download_cancel_keep_and_file_flow(authed, roots):
    c = authed
    respx.post(f"{SLSKD}/transfers/downloads/alice").mock(return_value=httpx.Response(201))
    files = [{"filename": "Music\\Artist - Album\\01 One.flac", "size": 100},
             {"filename": "Music\\Artist - Album\\02 Two.flac", "size": 200}]
    job = c.post("/api/downloads", json={"username": "alice", "directory": "Music\\Artist - Album",
                                         "files": files}).json()
    assert job["status"] == "active" and len(job["files"]) == 2

    # slskd finishes the first file; the second is still transferring.
    local = make_flac(roots["staging"] / "Artist - Album" / "01 One.flac", artist="Artist", album="Album")
    size1 = local.stat().st_size
    with session_scope() as db:
        from app.models import DownloadFile

        db.query(DownloadFile).filter(DownloadFile.remote_filename == files[0]["filename"]).update({"size": size1})
    transfers = [
        {"id": "t1", "username": "alice", "filename": files[0]["filename"], "state": "Completed, Succeeded",
         "bytesTransferred": size1, "requestedAt": "2026-01-01T00:00:00"},
        {"id": "t2", "username": "alice", "filename": files[1]["filename"], "state": "InProgress",
         "bytesTransferred": 50, "averageSpeed": 10.0, "requestedAt": "2026-01-01T00:00:00"},
    ]
    with session_scope() as db:
        changed = downloads.apply_transfers(db, transfers)
        assert len(changed) == 1
    job = c.get(f"/api/downloads/{job['id']}").json()
    assert job["counts"]["completed"] == 1 and job["counts"]["downloading"] == 1
    # The folder is still being written to, so the explorer may not touch it.
    with session_scope() as db:
        downloads.refresh_download_locks(db)
    assert c.post("/api/files/rename", json={"path": "staging/Artist - Album", "name": "x"}).status_code == 409

    respx.delete(f"{SLSKD}/transfers/downloads/alice/t2").mock(return_value=httpx.Response(204))
    job = c.post(f"/api/downloads/{job['id']}/cancel").json()
    assert job["status"] == "cancelled"
    job = c.post(f"/api/downloads/{job['id']}/keep").json()
    assert job["status"] == "ready" and job["unfiled_completed"] == 1

    suggestion = c.get(f"/api/downloads/{job['id']}/suggest").json()
    assert suggestion["path"] == "library/Artist/Album" and suggestion["source"] == "tags"

    # An existing album folder with an older copy of track 1: the new file is kept as "(2)".
    make_flac(roots["library"] / "Artist" / "Album" / "01 One.flac")
    plex_refresh = respx.get("http://plex.test/library/sections/3/refresh").mock(return_value=httpx.Response(200))
    respx.get("http://plex.test/library/sections").mock(return_value=httpx.Response(200, json={
        "MediaContainer": {"Directory": [{"key": "3", "title": "Music", "type": "artist", "refreshing": False}]}}))
    respx.get("http://plex.test/library/sections/3/all").mock(return_value=httpx.Response(200, json={
        "MediaContainer": {"Metadata": []}}))
    r = c.post(f"/api/downloads/{job['id']}/file", json={"destination": suggestion["path"]})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["results"][0]["renamed"] is True and body["results"][0]["name"] == "01 One (2).flac"
    assert body["job"]["status"] == "filed"
    assert body["scan"]["started"] is True
    assert plex_refresh.calls.last.request.url.params["path"] == "/mnt/usb/Music/Artist/Album"
    assert not (roots["staging"] / "Artist - Album").exists()  # empty staging folder cleaned up


@respx.mock
def test_cancel_then_discard(authed, roots):
    c = authed
    respx.post(f"{SLSKD}/transfers/downloads/bob").mock(return_value=httpx.Response(201))
    job = c.post("/api/downloads", json={"username": "bob", "directory": "x\\Alb",
                                         "files": [{"filename": "x\\Alb\\1.mp3", "size": 3}]}).json()
    (roots["staging"] / "Alb").mkdir()
    (roots["staging"] / "Alb" / "1.mp3").write_bytes(b"abc")
    with session_scope() as db:
        downloads.apply_transfers(db, [{"id": "t", "username": "bob", "filename": "x\\Alb\\1.mp3",
                                        "state": "Completed, Succeeded", "bytesTransferred": 3}])
    job = c.get(f"/api/downloads/{job['id']}").json()
    assert job["status"] == "ready"
    r = c.post(f"/api/downloads/{job['id']}/discard").json()
    assert r["trashed"] == 1 and r["job"]["status"] == "discarded"
    assert not (roots["staging"] / "Alb").exists()


@respx.mock
def test_search_flow(authed):
    c = authed
    respx.post(f"{SLSKD}/searches").mock(return_value=httpx.Response(200, json={}))
    respx.get(url__regex=rf"{SLSKD}/searches/[^/]+$").mock(return_value=httpx.Response(200, json={
        "isComplete": False, "state": "InProgress", "responseCount": 1}))
    respx.get(url__regex=rf"{SLSKD}/searches/[^/]+/responses").mock(return_value=httpx.Response(200, json=[
        {"username": "u", "hasFreeUploadSlot": True, "uploadSpeed": 100, "queueLength": 0,
         "files": [{"filename": "a\\Album\\1.flac", "size": 10, "bitDepth": 16, "sampleRate": 44100}]}]))
    started = c.post("/api/search", json={"query": "album"}).json()
    res = c.get(f"/api/search/{started['id']}").json()
    assert res["complete"] is False and res["groups"][0]["quality"] == "FLAC 16/44.1"


@respx.mock
def test_slskd_unreachable_is_reported(authed):
    respx.get(f"{SLSKD}/server").mock(side_effect=httpx.ConnectError("boom"))
    status = authed.get("/api/status").json()
    assert status["soulseek"]["ok"] is False and "reach" in status["soulseek"]["message"]
    assert status["storage"]["ok"] is True
