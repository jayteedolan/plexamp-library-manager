import asyncio
import shutil
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.auth import current_user
from app.config import get_settings
from app.db import get_db
from app.models import DownloadFile, DownloadJob, DownloadJobHint
from app.providers.soulseek import client_for
from app.services import downloads, library_index, plex_ops
from app.services.plex import PlexError
from app.services.tags import suggest_destination

router = APIRouter(prefix="/api/downloads", tags=["downloads"], dependencies=[Depends(current_user)])

FINISHED = ("filed", "discarded", "failed")


class RemoteFile(BaseModel):
    filename: str
    size: int


class CatalogHint(BaseModel):
    artist: str | None = None
    album: str | None = None


class CreateBody(BaseModel):
    username: str
    directory: str
    files: list[RemoteFile]
    title: str | None = None
    catalog: CatalogHint | None = None  # the Spotify release this download was started from


class FileIdsBody(BaseModel):
    file_ids: list[int] | None = None


class FileIntoBody(BaseModel):
    destination: str
    file_ids: list[int] | None = None
    scan: bool = True


def _job(db: Session, job_id: int) -> DownloadJob:
    job = db.get(DownloadJob, job_id)
    if job is None:
        raise HTTPException(404, "Download not found.")
    return job


def _files(job: DownloadJob, ids: list[int] | None) -> list[DownloadFile]:
    return [f for f in job.files if ids is None or f.id in ids]


@router.get("")
def list_jobs(db: Session = Depends(get_db)):
    jobs = db.query(DownloadJob).order_by(DownloadJob.created_at.desc()).all()
    return [downloads.job_view(j) for j in jobs]


@router.post("/space-check")
def space_check(body: CreateBody):
    needed = sum(f.size for f in body.files)
    try:
        free = shutil.disk_usage(get_settings().staging_root).free
    except OSError:
        return {"ok": False, "needed": needed, "free": None, "message": "Staging folder is not available."}
    margin = 1024**3  # keep 1 GB spare
    ok = free - needed > margin
    return {"ok": ok, "needed": needed, "free": free,
            "message": None if ok else "This download would leave less than 1 GB free on the drive."}


@router.post("")
async def create(body: CreateBody, db: Session = Depends(get_db)):
    async with client_for(db) as client:
        job = await downloads.create_job(db, client, body.username, body.directory,
                                         [f.model_dump() for f in body.files], body.title)
    if body.catalog and (body.catalog.artist or body.catalog.album):
        db.add(DownloadJobHint(job_id=job.id, artist=body.catalog.artist, album=body.catalog.album))
        db.commit()
    return downloads.job_view(job)


@router.get("/{job_id}")
def get_job(job_id: int, db: Session = Depends(get_db)):
    return downloads.job_view(_job(db, job_id))


@router.post("/{job_id}/cancel")
async def cancel(job_id: int, db: Session = Depends(get_db)):
    job = _job(db, job_id)
    async with client_for(db) as client:
        await downloads.cancel_job(db, client, job)
    return downloads.job_view(job)


@router.post("/{job_id}/cancel-files")
async def cancel_files(job_id: int, body: FileIdsBody, db: Session = Depends(get_db)):
    job = _job(db, job_id)
    async with client_for(db) as client:
        await downloads.cancel_files(db, client, job, _files(job, body.file_ids))
    downloads.refresh_download_locks(db)
    downloads.publish_job(job)
    return downloads.job_view(job)


@router.post("/{job_id}/keep")
def keep(job_id: int, db: Session = Depends(get_db)):
    job = _job(db, job_id)
    downloads.keep_completed(db, job)
    return downloads.job_view(job)


@router.post("/{job_id}/discard")
def discard(job_id: int, db: Session = Depends(get_db)):
    job = _job(db, job_id)
    if job.status == "active":
        raise HTTPException(409, "Cancel the download first.")
    count = downloads.discard_completed(db, job)
    return {"trashed": count, "job": downloads.job_view(job)}


@router.post("/{job_id}/retry")
async def retry(job_id: int, body: FileIdsBody, db: Session = Depends(get_db)):
    job = _job(db, job_id)
    async with client_for(db) as client:
        await downloads.retry_files(db, client, job, _files(job, body.file_ids))
    return downloads.job_view(job)


@router.get("/{job_id}/suggest")
async def suggest(job_id: int, db: Session = Depends(get_db)):
    job = _job(db, job_id)
    paths = [Path(f.local_path) for f in job.files
             if f.state == "completed" and not f.filed and f.local_path]
    row = db.get(DownloadJobHint, job.id)
    hint = {"artist": row.artist, "album": row.album} if row else None
    return await asyncio.to_thread(suggest_destination, paths, job.remote_folder, library_index.current(), hint)


@router.post("/{job_id}/file")
async def file_into_library(job_id: int, body: FileIntoBody, db: Session = Depends(get_db)):
    job = _job(db, job_id)
    result = await asyncio.to_thread(downloads.file_job, db, job, body.destination, body.file_ids)
    result["scan"] = None
    if body.scan:
        try:
            result["scan"] = await plex_ops.scan(db, result["destination"])
        except PlexError as e:
            result["scan"] = {"started": False, "message": str(e)}
    asyncio.get_running_loop().create_task(plex_ops.rebuild_index_detached())
    return result


@router.delete("/{job_id}")
def remove(job_id: int, db: Session = Depends(get_db)):
    job = _job(db, job_id)
    if job.status == "active":
        raise HTTPException(409, "Cancel the download before removing it.")
    if job.status in ("ready", "cancelled") and any(f.state == "completed" and not f.filed for f in job.files):
        raise HTTPException(409, "File or delete the downloaded files first.")
    db.delete(job)
    db.commit()
    return {"ok": True}


@router.post("/clear-history")
def clear_history(db: Session = Depends(get_db)):
    jobs = db.query(DownloadJob).filter(DownloadJob.status.in_(FINISHED)).all()
    for j in jobs:
        db.delete(j)
    db.commit()
    return {"removed": len(jobs)}

