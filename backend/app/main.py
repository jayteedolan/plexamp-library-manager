import asyncio
import contextlib
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app import events
from app.config import get_settings
from app.db import init_engine, session_scope
from app.providers.soulseek import client_for
from app.routers import auth, downloads, files, plex, search, system, trash
from app.services import downloads as downloads_service
from app.services import fs, plex_ops
from app.services import settings as settings_service
from app.services import trash as trash_service
from app.services.plex import PlexError
from app.services.slskd import SlskdError

log = logging.getLogger("library-manager")


async def _periodic(name: str, interval: float, fn, stop: asyncio.Event, initial_delay: float = 5.0) -> None:
    with contextlib.suppress(TimeoutError):
        await asyncio.wait_for(stop.wait(), timeout=initial_delay)
    while not stop.is_set():
        try:
            await fn()
        except Exception:
            log.exception("%s failed", name)
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(stop.wait(), timeout=interval)


async def _purge_trash() -> None:
    if not fs.storage_status()["ok"]:
        return
    with session_scope() as db:
        days = settings_service.load(db).trash_retention_days
        count = await asyncio.to_thread(trash_service.purge_older_than, db, days)
    if count:
        log.info("purged %d expired trash item(s)", count)
        events.publish("trash", {})


async def _rebuild_index() -> None:
    await plex_ops.rebuild_index_detached()


def create_app(start_background: bool = True) -> FastAPI:
    settings = get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        os.umask(0o002)
        settings.data_dir.mkdir(parents=True, exist_ok=True)
        init_engine(f"sqlite:///{settings.db_path}")
        events.bind_loop(asyncio.get_running_loop())
        with session_scope() as db:
            downloads_service.refresh_download_locks(db)
        stop = asyncio.Event()
        tasks = []
        if start_background:
            tasks = [
                asyncio.create_task(downloads_service.poller(session_scope, client_for, stop)),
                asyncio.create_task(_periodic("trash purge", 6 * 3600, _purge_trash, stop, 30)),
                asyncio.create_task(_periodic("library index", 6 * 3600, _rebuild_index, stop, 3)),
            ]
        yield
        stop.set()
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    app = FastAPI(title="Plex Library Manager", lifespan=lifespan, docs_url=None, redoc_url=None)

    @app.exception_handler(fs.FsError)
    async def fs_error(_request: Request, exc: fs.FsError):
        return JSONResponse({"detail": exc.message, "extra": exc.detail}, status_code=exc.status)

    @app.exception_handler(SlskdError)
    async def slskd_error(_request: Request, exc: SlskdError):
        return JSONResponse({"detail": str(exc)}, status_code=502)

    @app.exception_handler(PlexError)
    async def plex_error(_request: Request, exc: PlexError):
        return JSONResponse({"detail": str(exc)}, status_code=502)

    @app.exception_handler(PermissionError)
    async def permission_error(_request: Request, exc: PermissionError):
        return JSONResponse({"detail": f"Permission denied: {exc.filename or ''}. Check folder ownership "
                                       "(see docs/SETUP.md)."}, status_code=500)

    @app.exception_handler(OSError)
    async def os_error(_request: Request, exc: OSError):
        return JSONResponse({"detail": f"Filesystem error: {exc.strerror or exc}"}, status_code=500)

    for r in (auth, files, trash, plex, search, downloads, system):
        app.include_router(r.router)

    static_dir = settings.static_dir or Path(__file__).resolve().parent.parent / "static"
    if static_dir.is_dir():
        assets = static_dir / "assets"
        if assets.is_dir():
            app.mount("/assets", StaticFiles(directory=assets), name="assets")

        @app.get("/{full_path:path}", include_in_schema=False)
        async def spa(full_path: str):
            if full_path.startswith("api/"):
                return JSONResponse({"detail": "Not found"}, status_code=404)
            candidate = (static_dir / full_path).resolve()
            if full_path and candidate.is_file() and static_dir.resolve() in candidate.parents:
                return FileResponse(candidate)
            return FileResponse(static_dir / "index.html", headers={"Cache-Control": "no-cache"})

    return app


logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
app = create_app()
