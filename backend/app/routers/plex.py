from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.auth import current_user
from app.db import get_db
from app.services import plex_ops
from app.services import settings as settings_service
from app.services.plex import PlexClient, PlexError

router = APIRouter(prefix="/api/plex", tags=["plex"], dependencies=[Depends(current_user)])


class ScanBody(BaseModel):
    path: str | None = None  # library virtual path for a targeted scan; None = whole library


class TestBody(BaseModel):
    url: str | None = None
    token: str | None = None  # empty = use the saved token


@router.get("/status")
async def status(db: Session = Depends(get_db)):
    return await plex_ops.status(db)


@router.post("/scan")
async def scan(body: ScanBody, db: Session = Depends(get_db)):
    return await plex_ops.scan(db, body.path)


@router.post("/test")
async def test(body: TestBody, db: Session = Depends(get_db)):
    """Check a Plex URL/token (saved or not yet saved) and list its music libraries."""
    rs = settings_service.load(db)
    url = (body.url or rs.plex_url).rstrip("/")
    token = body.token or rs.plex_token
    try:
        async with PlexClient(url, token) as c:
            ident = await c.identity()
            sections = await c.sections()
    except PlexError as e:
        return {"ok": False, "message": str(e), "sections": []}
    music = [s for s in sections if s["type"] == "artist"]
    return {"ok": True, "message": f"Connected to Plex {ident.get('version', '')}".strip(), "sections": music}
