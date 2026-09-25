"""Fake slskd + Plex for local development and end-to-end tests.

Run:  MOCK_STAGING=/path/to/staging uvicorn devtools.mock_services:app --port 5031
Then point Library Manager at SLSKD_URL=http://127.0.0.1:5031 and PLEX_URL=http://127.0.0.1:5031.

Searches return a handful of made-up folders at different qualities for any query. "Downloads"
progress over ~10 seconds and write small tagged FLAC/MP3 stand-in files into the staging folder.
"""

import os
import random
import struct
import time
import uuid
from pathlib import Path

from fastapi import FastAPI, Request

app = FastAPI()
STAGING = Path(os.environ.get("MOCK_STAGING", "/tmp/lm-staging"))
STAGING.mkdir(parents=True, exist_ok=True)
DOWNLOAD_SECONDS = float(os.environ.get("MOCK_DOWNLOAD_SECONDS", "10"))
searches: dict[str, dict] = {}
transfers: dict[str, dict] = {}
plex_state = {"refreshing_until": 0.0, "scanned_at": int(time.time()) - 3600, "refresh_calls": []}


def _files(folder: str, n: int, ext: str, **meta) -> list[dict]:
    out = []
    for i in range(1, n + 1):
        f = {"filename": f"{folder}\\{i:02d} - Track {i}.{ext}", "size": random.randint(20, 45) * 1024 * 1024
             if ext == "flac" else random.randint(7, 12) * 1024 * 1024, "extension": ext, "length": 180 + i * 7}
        f.update(meta)
        out.append(f)
    out.append({"filename": f"{folder}\\cover.jpg", "size": 350_000, "extension": "jpg"})
    return out


def _responses(query: str) -> list[dict]:
    title = query.title()
    return [
        {"username": "flac_hoarder", "hasFreeUploadSlot": True, "uploadSpeed": 4_500_000, "queueLength": 0,
         "files": _files(f"Music\\Some Artist\\{title} (2011) [FLAC 24-96]", 10, "flac", bitDepth=24, sampleRate=96000)},
        {"username": "cd_ripper", "hasFreeUploadSlot": True, "uploadSpeed": 900_000, "queueLength": 0,
         "files": _files(f"Rips\\Some Artist - {title} (2011)", 10, "flac", bitDepth=16, sampleRate=44100)},
        {"username": "slow_but_lossless", "hasFreeUploadSlot": False, "uploadSpeed": 120_000, "queueLength": 14,
         "files": _files(f"share\\{title}", 10, "flac", bitDepth=16, sampleRate=44100)},
        {"username": "mp3_person", "hasFreeUploadSlot": True, "uploadSpeed": 8_000_000, "queueLength": 0,
         "files": _files(f"mp3\\Some Artist - {title} [320]", 10, "mp3", bitRate=320)},
        {"username": "v0_fan", "hasFreeUploadSlot": True, "uploadSpeed": 2_000_000, "queueLength": 1,
         "files": _files(f"music\\Some Artist\\{title} [V0]", 9, "mp3", bitRate=245, isVariableBitRate=True)},
        {"username": "lowbit", "hasFreeUploadSlot": True, "uploadSpeed": 3_000_000, "queueLength": 0,
         "files": _files(f"old\\{title}", 10, "mp3", bitRate=128)},
        {"username": "private_guy", "hasFreeUploadSlot": True, "uploadSpeed": 3_000_000, "queueLength": 0,
         "files": [], "lockedFiles": _files(f"locked\\{title}", 10, "flac")},
    ]


# ------------------------------------------------------------------------------------------ slskd

@app.get("/api/v0/server")
def server():
    return {"state": "Connected, LoggedIn", "isConnected": True, "isLoggedIn": True}


@app.post("/api/v0/searches")
async def start_search(req: Request):
    body = await req.json()
    searches[body["id"]] = {"text": body["searchText"], "started": time.time()}
    return {"id": body["id"], "state": "InProgress"}


def _visible(search: dict) -> list[dict]:
    elapsed = time.time() - search["started"]
    all_resp = _responses(search["text"])
    return all_resp[: max(1, min(len(all_resp), int(elapsed * 2)))]


@app.get("/api/v0/searches/{sid}")
def search_state(sid: str):
    s = searches[sid]
    done = s.get("stopped") or time.time() - s["started"] > 4
    return {"id": sid, "isComplete": bool(done), "state": "Completed" if done else "InProgress",
            "responseCount": len(_visible(s))}


@app.get("/api/v0/searches/{sid}/responses")
def search_responses(sid: str):
    return _visible(searches[sid])


@app.put("/api/v0/searches/{sid}")
def stop_search(sid: str):
    searches[sid]["stopped"] = True
    return {}


@app.post("/api/v0/users/{username}/directory")
async def browse(username: str, req: Request):
    body = await req.json()
    directory = body["directory"]
    for r in _responses("x"):
        if r["username"] == username:
            ext = (r["files"] or r["lockedFiles"])[0]["extension"]
            files = _files(directory, 12, ext)
            return [{"name": directory, "fileCount": len(files),
                     "files": [{**f, "filename": f["filename"].rsplit("\\", 1)[1]} for f in files]}]
    return []


@app.post("/api/v0/transfers/downloads/{username}")
async def enqueue(username: str, req: Request):
    for f in await req.json():
        tid = str(uuid.uuid4())
        # Stagger completion by track number so cancelling part-way leaves some files finished.
        name = f["filename"].rsplit("\\", 1)[-1]
        track = int(name[:2]) if name[:2].isdigit() else 1
        transfers[tid] = {"id": tid, "username": username, "filename": f["filename"], "size": f["size"],
                          "requested": time.time(), "duration": DOWNLOAD_SECONDS * (0.3 + 0.15 * track),
                          "cancelled": False, "fail": "fail" in f["filename"].lower()}
    return {}


def _transfer_view(t: dict) -> dict:
    elapsed = time.time() - t["requested"]
    base = {"id": t["id"], "username": t["username"], "filename": t["filename"], "size": t["size"],
            "requestedAt": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(t["requested"]))}
    if t["cancelled"]:
        return {**base, "state": "Completed, Cancelled", "bytesTransferred": 0}
    if elapsed < 1.5:
        return {**base, "state": "Queued, Remotely", "placeInQueue": 2, "bytesTransferred": 0}
    frac = min(1.0, (elapsed - 1.5) / t["duration"])
    if t["fail"] and frac > 0.3:
        return {**base, "state": "Completed, Errored", "exception": "Remote user went offline",
                "bytesTransferred": int(t["size"] * 0.3)}
    if frac >= 1.0:
        _write_file(t)
        return {**base, "state": "Completed, Succeeded", "bytesTransferred": t["size"], "percentComplete": 100}
    return {**base, "state": "InProgress", "bytesTransferred": int(t["size"] * frac),
            "averageSpeed": t["size"] / t["duration"], "percentComplete": frac * 100}


def _write_file(t: dict) -> None:
    parts = t["filename"].split("\\")
    target = STAGING / parts[-2] / parts[-1]
    if target.exists() or t.get("written"):
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    folder = parts[-2]
    if target.suffix == ".flac":
        _flac(target, artist="Some Artist", album=folder.split(" - ")[-1].split(" [")[0].split(" (")[0],
              title=target.stem, tracknumber=target.stem[:2])
    else:
        target.write_bytes(os.urandom(2048))
    t["written"] = True


def _flac(path: Path, **tags: str) -> None:
    packed = (44100 << 44) | (1 << 41) | (15 << 36) | 44100 * 200
    streaminfo = struct.pack(">HH", 4096, 4096) + b"\0" * 6 + packed.to_bytes(8, "big") + b"\0" * 16
    path.write_bytes(b"fLaC" + bytes([0x80]) + len(streaminfo).to_bytes(3, "big") + streaminfo)
    from mutagen.flac import FLAC

    f = FLAC(path)
    for k, v in tags.items():
        f[k] = v
    f.save()


@app.get("/api/v0/transfers/downloads")
def downloads():
    by_user: dict[str, list] = {}
    for t in transfers.values():
        by_user.setdefault(t["username"], []).append(_transfer_view(t))
    return [{"username": u, "directories": [{"directory": "x", "files": fs}]} for u, fs in by_user.items()]


@app.delete("/api/v0/transfers/downloads/{username}/{tid}")
def cancel(username: str, tid: str):
    if tid in transfers:
        transfers[tid]["cancelled"] = True
    return {}


# ------------------------------------------------------------------------------------------- plex

@app.get("/identity")
def identity():
    return {"MediaContainer": {"machineIdentifier": "mock", "version": "1.41.0-mock"}}


@app.get("/library/sections")
def sections():
    refreshing = time.time() < plex_state["refreshing_until"]
    return {"MediaContainer": {"Directory": [
        {"key": "1", "title": "Movies", "type": "movie", "Location": [{"path": "/movies"}]},
        {"key": "3", "title": "Music", "type": "artist", "refreshing": refreshing,
         "scannedAt": plex_state["scanned_at"], "Location": [{"path": "/mnt/usb/Music"}]},
    ]}}


@app.get("/library/sections/{sid}/refresh")
async def refresh(sid: str, req: Request):
    plex_state["refresh_calls"].append(dict(req.query_params))
    plex_state["refreshing_until"] = time.time() + 6
    plex_state["scanned_at"] = int(time.time()) + 6
    return {}


@app.get("/library/sections/{sid}/all")
def all_items(sid: str, type: int = 9):
    if type == 9:
        return {"MediaContainer": {"size": 2, "totalSize": 2, "Metadata": [
            {"title": "OK Computer", "parentTitle": "Radiohead", "leafCount": 12},
            {"title": "Mock Album", "parentTitle": "Some Artist", "leafCount": 4},
        ]}}
    return {"MediaContainer": {"size": 0, "totalSize": {8: 120, 10: 2400}.get(type, 0)}}


@app.get("/_mock/plex-refresh-calls")
def refresh_calls():
    return plex_state["refresh_calls"]

