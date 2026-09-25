"""Plex scan helpers and library-index rebuilding shared by several routers."""

import asyncio
import logging
from pathlib import PurePosixPath

from sqlalchemy.orm import Session

from app.config import get_settings
from app.services import fs, library_index
from app.services import settings as settings_service
from app.services.plex import PlexClient, PlexError

log = logging.getLogger(__name__)
_state = {"last_refreshing": False, "last_scan_requested": None, "last_scan_path": None}


def plex_path_for(vpath: str | None, plex_library_path: str) -> str | None:
    """Map a library virtual path onto the folder path Plex sees."""
    if not vpath:
        return None
    key, rest = fs.split_vpath(vpath)
    if key != "library":
        return None
    return str(PurePosixPath(plex_library_path).joinpath(*rest))


def client(db: Session) -> PlexClient:
    rs = settings_service.load(db)
    return PlexClient(rs.plex_url, rs.plex_token)


async def scan(db: Session, vpath: str | None = None) -> dict:
    rs = settings_service.load(db)
    if not rs.plex_section_id:
        raise PlexError("Choose your Plex music library in Settings first.")
    path = plex_path_for(vpath, rs.plex_library_path)
    async with PlexClient(rs.plex_url, rs.plex_token) as c:
        section = await c.section(rs.plex_section_id)
        if section is None:
            raise PlexError("The configured Plex library no longer exists. Pick it again in Settings.")
        if section["refreshing"] and not path:
            return {"started": False, "message": "Plex is already scanning this library."}
        await c.refresh(rs.plex_section_id, path)
    from app.models import utcnow

    _state["last_scan_requested"] = utcnow()
    _state["last_scan_path"] = vpath or "library"
    return {"started": True, "message": f"Scanning {'folder' if path else 'library'}…", "path": path}


async def status(db: Session) -> dict:
    rs = settings_service.load(db)
    base = {"configured": bool(rs.plex_url and rs.plex_token and rs.plex_section_id),
            "last_scan_requested": _state["last_scan_requested"], "last_scan_path": _state["last_scan_path"]}
    if not (rs.plex_url and rs.plex_token):
        return {**base, "ok": False, "message": "Plex is not configured yet."}
    try:
        async with PlexClient(rs.plex_url, rs.plex_token) as c:
            ident = await c.identity()
            section = await c.section(rs.plex_section_id) if rs.plex_section_id else None
            counts = await c.counts(rs.plex_section_id) if section else None
    except PlexError as e:
        return {**base, "ok": False, "message": str(e)}
    refreshing = bool(section and section["refreshing"])
    if _state["last_refreshing"] and not refreshing:
        # A scan just finished: refresh the "already in library" index in the background.
        asyncio.get_running_loop().create_task(rebuild_index_detached())
    _state["last_refreshing"] = refreshing
    return {
        **base,
        "ok": section is not None,
        "message": "Connected." if section else "Connected, but no music library is selected.",
        "version": ident.get("version"),
        "section": section,
        "refreshing": refreshing,
        "counts": counts,
    }


async def rebuild_index(db: Session) -> library_index.LibraryIndex:
    rs = settings_service.load(db)
    idx = None
    if rs.plex_url and rs.plex_token and rs.plex_section_id:
        try:
            async with PlexClient(rs.plex_url, rs.plex_token) as c:
                idx = library_index.build_from_plex(await c.albums(rs.plex_section_id))
        except PlexError as e:
            log.info("Plex index unavailable (%s); using the folder tree", e)
    if idx is None or not idx.albums:
        idx = await asyncio.to_thread(library_index.build_from_filesystem, get_settings().library_root)
    library_index.replace(idx)
    return idx


async def rebuild_index_detached() -> None:
    from app.db import session_scope

    try:
        with session_scope() as db:
            await rebuild_index(db)
    except Exception:
        log.exception("library index rebuild failed")
