from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app import events
from app.auth import current_user
from app.db import get_db
from app.models import DownloadJob
from app.providers.soulseek import SoulseekProvider
from app.services import fs, library_index, plex_ops, trash
from app.services import settings as settings_service
from app.services.slskd import SlskdClient, SlskdError

router = APIRouter(tags=["system"])
protected = [Depends(current_user)]


class SettingsBody(BaseModel):
    slskd_url: str | None = None
    slskd_api_key: str | None = None
    plex_url: str | None = None
    plex_token: str | None = None
    plex_section_id: str | None = None
    plex_library_path: str | None = None
    trash_retention_days: int | None = None


class SlskdTestBody(BaseModel):
    url: str | None = None
    api_key: str | None = None


@router.get("/healthz")
def healthz():
    return {"ok": True}


@router.get("/api/status", dependencies=protected)
async def status(db: Session = Depends(get_db)):
    jobs = db.query(DownloadJob).filter(DownloadJob.status.in_(("active", "ready", "cancelled"))).all()
    idx = library_index.current()
    return {
        "storage": fs.storage_status(),
        "trash_size": trash.total_size(db),
        "soulseek": await SoulseekProvider(db).status(),
        "downloads": {
            "active": sum(1 for j in jobs if j.status == "active"),
            "ready": sum(1 for j in jobs if j.status == "ready"),
            "awaiting_decision": sum(1 for j in jobs if j.status == "cancelled"),
        },
        "library_index": {"source": idx.source, "albums": len(idx.albums)},
    }


@router.get("/api/events", dependencies=protected)
async def event_stream():
    return StreamingResponse(events.stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.get("/api/settings", dependencies=protected)
def get_settings_view(db: Session = Depends(get_db)):
    return settings_service.public_view(settings_service.load(db))


@router.put("/api/settings", dependencies=protected)
async def put_settings(body: SettingsBody, db: Session = Depends(get_db)):
    settings_service.save(db, body.model_dump())
    await plex_ops.rebuild_index(db)
    return settings_service.public_view(settings_service.load(db))


@router.post("/api/settings/test-slskd", dependencies=protected)
async def test_slskd(body: SlskdTestBody, db: Session = Depends(get_db)):
    rs = settings_service.load(db)
    try:
        async with SlskdClient(body.url or rs.slskd_url, body.api_key or rs.slskd_api_key) as c:
            s = await c.server_state()
    except SlskdError as e:
        return {"ok": False, "message": str(e)}
    if not s.get("isLoggedIn"):
        return {"ok": False, "message": f"Reached slskd, but it is not logged in to Soulseek ({s.get('state')})."}
    return {"ok": True, "message": "Connected; slskd is logged in to Soulseek."}


@router.post("/api/library-index/rebuild", dependencies=protected)
async def rebuild_index(db: Session = Depends(get_db)):
    idx = await plex_ops.rebuild_index(db)
    return {"source": idx.source, "albums": len(idx.albums)}
