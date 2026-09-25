import struct
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.services import fs, library_index


@pytest.fixture
def roots(tmp_path, monkeypatch):
    usb = tmp_path / "usb"
    library = usb / "Music"
    staging = usb / ".lm" / "staging"
    trash = usb / ".lm" / "trash"
    for d in (library, staging, trash):
        d.mkdir(parents=True)
    marker = usb / ".lm" / ".lm-root"
    marker.touch()
    env = {
        "DATA_DIR": str(tmp_path / "data"),
        "LIBRARY_ROOT": str(library),
        "STAGING_ROOT": str(staging),
        "TRASH_ROOT": str(trash),
        "MOUNT_MARKER": str(marker),
        "SLSKD_URL": "http://slskd.test",
        "SLSKD_API_KEY": "key",
        "PLEX_URL": "http://plex.test",
        "PLEX_TOKEN": "tok",
        "PLEX_SECTION_ID": "3",
        "PLEX_LIBRARY_PATH": "/mnt/usb/Music",
        "COOKIE_SECURE": "false",
    }
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    get_settings.cache_clear()
    fs._fs_type_for.cache_clear()
    fs.locks.download_dirs = set()
    library_index.replace(library_index.LibraryIndex())
    yield {"usb": usb, "library": library, "staging": staging, "trash": trash, "marker": marker,
           "data": tmp_path / "data"}
    get_settings.cache_clear()


@pytest.fixture
def db(roots):
    from app.db import init_engine, session_scope

    roots["data"].mkdir(exist_ok=True)
    init_engine(f"sqlite:///{roots['data'] / 'app.db'}")
    with session_scope() as s:
        yield s


@pytest.fixture
def client(roots):
    from app.main import create_app

    app = create_app(start_background=False)
    with TestClient(app, headers={"X-Requested-With": "lm"}) as c:
        yield c


@pytest.fixture
def authed(client):
    r = client.post("/api/auth/setup", json={"username": "admin", "password": "correct horse battery"})
    assert r.status_code == 200, r.text
    return client


def make_flac(path: Path, **tags: str) -> Path:
    """Write a minimal valid FLAC file (STREAMINFO only) and tag it."""
    sample_rate, channels, bps, total = 44100, 2, 16, 44100 * 3
    packed = (sample_rate << 44) | ((channels - 1) << 41) | ((bps - 1) << 36) | total
    streaminfo = struct.pack(">HH", 4096, 4096) + b"\0\0\0" + b"\0\0\0" + packed.to_bytes(8, "big") + b"\0" * 16
    header = bytes([0x80]) + len(streaminfo).to_bytes(3, "big")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"fLaC" + header + streaminfo)
    if tags:
        from mutagen.flac import FLAC

        f = FLAC(path)
        for k, v in tags.items():
            f[k] = v
        f.save()
    return path
