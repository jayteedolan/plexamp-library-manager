"""Download jobs: one per "download these files from this user's folder" action.

Jobs live in SQLite and are mapped onto slskd transfers. A background poller keeps them in sync and
pushes progress over SSE. Jobs keep going when no browser is open and are reconciled after restarts.
"""

import asyncio
import contextlib
import logging
import os
import shutil
import time
from datetime import timedelta
from pathlib import Path

from sqlalchemy.orm import Session

from app import events
from app.config import get_settings
from app.models import DownloadFile, DownloadJob, utcnow
from app.services import fs, trash
from app.services.ranking import split_remote
from app.services.slskd import SlskdClient, SlskdError, map_state

log = logging.getLogger(__name__)
TERMINAL = {"completed", "failed", "cancelled"}
# How long a queued file may be missing from slskd's transfer list before we call it failed.
MISSING_GRACE = timedelta(seconds=90)


def _folder_name(remote_folder: str) -> str:
    parts = [p for p in remote_folder.replace("\\", "/").split("/") if p]
    return parts[-1] if parts else "download"


def expected_dir(job: DownloadJob) -> Path:
    """slskd saves to <downloads>/<remote folder name>/<file name>."""
    return get_settings().staging_root / _folder_name(job.remote_folder)


def job_view(job: DownloadJob) -> dict:
    files = [file_view(f) for f in job.files]
    total = sum(f.size for f in job.files if f.state != "cancelled") or 0
    done = sum(min(f.bytes_transferred, f.size) for f in job.files if f.state != "cancelled")
    speed = sum(f.speed for f in job.files if f.state == "downloading")
    counts = {s: sum(1 for f in job.files if f.state == s) for s in ("queued", "downloading", "completed",
                                                                    "failed", "cancelled")}
    return {
        "id": job.id,
        "provider": job.provider,
        "username": job.username,
        "remote_folder": job.remote_folder,
        "title": job.title,
        "status": job.status,
        "filed_path": job.filed_path,
        "created_at": job.created_at,
        "updated_at": job.updated_at,
        "total_bytes": total,
        "done_bytes": done,
        "speed": speed,
        "eta_seconds": int((total - done) / speed) if speed > 0 else None,
        "counts": counts,
        "unfiled_completed": sum(1 for f in job.files if f.state == "completed" and not f.filed),
        "files": files,
    }


def file_view(f: DownloadFile) -> dict:
    _, name = split_remote(f.remote_filename)
    return {
        "id": f.id,
        "name": name,
        "size": f.size,
        "state": f.state,
        "remote_state": f.remote_state,
        "place_in_queue": f.place_in_queue,
        "bytes_transferred": f.bytes_transferred,
        "speed": f.speed,
        "error": f.error,
        "filed": f.filed,
        "local_path": fs.to_vpath(Path(f.local_path)) if f.local_path and Path(f.local_path).exists() else None,
    }


def publish_job(job: DownloadJob) -> None:
    events.publish("download", job_view(job))


def refresh_download_locks(db: Session) -> None:
    """Folders still being written by slskd are locked against explorer operations."""
    active = db.query(DownloadJob).filter(DownloadJob.status == "active").all()
    fs.locks.download_dirs = {expected_dir(j).resolve() for j in active}


def update_job_status(job: DownloadJob) -> None:
    if job.status not in ("active",):
        return
    states = {f.state for f in job.files}
    if states and states <= TERMINAL:
        job.status = "ready" if "completed" in states else "failed"


def _locate_local(job: DownloadJob, f: DownloadFile) -> Path | None:
    _, name = split_remote(f.remote_filename)
    candidate = expected_dir(job) / name
    if candidate.is_file():
        return candidate
    # slskd may have appended a suffix (e.g. "_638...") when a same-named file existed; look nearby.
    staging = get_settings().staging_root
    stem = os.path.splitext(name)[0]
    for dirpath, dirnames, files in os.walk(staging):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for fn in files:
            if fn == name or (fn.startswith(stem) and fn.endswith(os.path.splitext(name)[1])):
                p = Path(dirpath) / fn
                with contextlib.suppress(OSError):
                    if p.stat().st_size == f.size:
                        return p
    return None


async def create_job(db: Session, client: SlskdClient, username: str, directory: str,
                     files: list[dict], title: str | None = None) -> DownloadJob:
    if not files:
        raise fs.FsError(400, "Select at least one file.")
    fs.check_writable()
    await client.enqueue(username, files)
    job = DownloadJob(username=username, remote_folder=directory, title=title or _folder_name(directory),
                      status="active")
    for f in files:
        job.files.append(DownloadFile(remote_filename=f["filename"], size=int(f.get("size") or 0)))
    db.add(job)
    db.commit()
    refresh_download_locks(db)
    publish_job(job)
    return job


def apply_transfers(db: Session, transfers: list[dict]) -> list[DownloadJob]:
    """Sync active jobs with slskd's transfer list. Returns jobs that changed."""
    by_id = {str(t.get("id")): t for t in transfers if t.get("id")}
    by_name: dict[tuple[str, str], dict] = {}
    for t in sorted(transfers, key=lambda t: t.get("requestedAt") or ""):
        by_name[(t.get("username", ""), t.get("filename", ""))] = t

    changed = []
    now = utcnow()
    jobs = db.query(DownloadJob).filter(DownloadJob.status == "active").all()
    for job in jobs:
        dirty = False
        for f in job.files:
            if f.state in TERMINAL:
                continue
            t = by_id.get(f.transfer_id or "") or by_name.get((job.username, f.remote_filename))
            if t is None:
                created = job.updated_at if job.updated_at.tzinfo else job.updated_at.replace(tzinfo=now.tzinfo)
                if now - created > MISSING_GRACE:
                    local = _locate_local(job, f)
                    if local is not None:
                        f.state, f.local_path, f.bytes_transferred = "completed", str(local), f.size
                    else:
                        f.state, f.error = "failed", "Transfer disappeared from slskd."
                    dirty = True
                continue
            new_state = map_state(t.get("state"))
            values = {
                "transfer_id": str(t.get("id")),
                "remote_state": t.get("state"),
                "place_in_queue": t.get("placeInQueue"),
                "bytes_transferred": int(t.get("bytesTransferred") or 0),
                "speed": float(t.get("averageSpeed") or 0) if new_state == "downloading" else 0.0,
                "state": new_state,
                "error": (t.get("exception") or t.get("state")) if new_state == "failed" else None,
            }
            if new_state == "completed":
                values["bytes_transferred"] = f.size
                local = _locate_local(job, f)
                values["local_path"] = str(local) if local else None
            for k, v in values.items():
                if getattr(f, k) != v:
                    setattr(f, k, v)
                    dirty = True
        if dirty:
            update_job_status(job)
            job.updated_at = now
            changed.append(job)
    db.commit()
    return changed


async def poll_once(db: Session, client: SlskdClient) -> None:
    if not db.query(DownloadJob.id).filter(DownloadJob.status == "active").first():
        return
    transfers = await client.downloads()
    changed = apply_transfers(db, transfers)
    if changed:
        refresh_download_locks(db)
    for job in changed:
        publish_job(job)


def _remove_incomplete(job: DownloadJob, f: DownloadFile) -> None:
    """Remove slskd's partial file for a cancelled transfer if it lives under staging/.incomplete."""
    _, name = split_remote(f.remote_filename)
    inc = get_settings().staging_root / ".incomplete"
    if not inc.is_dir():
        return
    for dirpath, _dirs, files in os.walk(inc):
        for fn in files:
            if fn == name:
                with contextlib.suppress(OSError):
                    (Path(dirpath) / fn).unlink()


async def cancel_files(db: Session, client: SlskdClient, job: DownloadJob, files: list[DownloadFile]) -> None:
    for f in files:
        if f.state in TERMINAL:
            continue
        if f.transfer_id:
            with contextlib.suppress(SlskdError):
                await client.cancel(job.username, f.transfer_id, remove=True)
        f.state, f.speed, f.error = "cancelled", 0.0, None
        _remove_incomplete(job, f)
    update_job_status(job)
    job.updated_at = utcnow()
    db.commit()


async def cancel_job(db: Session, client: SlskdClient, job: DownloadJob) -> None:
    await cancel_files(db, client, job, list(job.files))
    job.status = "cancelled"  # waits for the user's keep/delete decision
    db.commit()
    refresh_download_locks(db)
    publish_job(job)


def keep_completed(db: Session, job: DownloadJob) -> None:
    has_files = any(f.state == "completed" and not f.filed for f in job.files)
    job.status = "ready" if has_files else "discarded"
    db.commit()
    publish_job(job)


def discard_completed(db: Session, job: DownloadJob) -> int:
    """Send this job's downloaded (unfiled) files to the trash."""
    count = 0
    for f in job.files:
        if f.state == "completed" and not f.filed and f.local_path and Path(f.local_path).exists():
            trash.move_to_trash(db, Path(f.local_path), commit=False)
            f.local_path = None
            count += 1
    job.status = "discarded"
    db.commit()
    _cleanup_empty_dirs(expected_dir(job))
    publish_job(job)
    return count


async def retry_files(db: Session, client: SlskdClient, job: DownloadJob, files: list[DownloadFile]) -> None:
    targets = [f for f in files if f.state in ("failed", "cancelled")]
    if not targets:
        return
    fs.check_writable()
    await client.enqueue(job.username, [{"filename": f.remote_filename, "size": f.size} for f in targets])
    for f in targets:
        f.state, f.error, f.transfer_id, f.bytes_transferred, f.speed = "queued", None, None, 0, 0.0
    job.status = "active"
    job.updated_at = utcnow()
    db.commit()
    refresh_download_locks(db)
    publish_job(job)


def _cleanup_empty_dirs(start: Path) -> None:
    staging = get_settings().staging_root.resolve()
    d = start
    while d.exists() and d.resolve() != staging and staging in d.resolve().parents:
        try:
            leftovers = [p for p in d.iterdir() if not fs.is_hidden(p.name)]
        except OSError:
            return
        if leftovers:
            return
        shutil.rmtree(d, ignore_errors=True)
        d = d.parent


def file_job(db: Session, job: DownloadJob, dest_vpath: str, file_ids: list[int] | None) -> dict:
    """Move completed files into a library folder (created if needed). Name clashes get ' (2)'."""
    if job.status == "active":
        raise fs.FsError(409, "This download is still in progress.")
    fs.check_writable()
    key, _ = fs.split_vpath(dest_vpath)
    if key != "library":
        raise fs.FsError(400, "Choose a folder inside the library.")
    dest = fs.resolve(dest_vpath, must_exist=False)
    if not dest.exists():
        dest = fs.makedirs(dest_vpath)
    if not dest.is_dir():
        raise fs.FsError(400, "Destination is not a folder.")

    selected = [f for f in job.files if f.state == "completed" and not f.filed
                and (file_ids is None or f.id in file_ids)]
    results = []
    with fs.locks.hold([dest]):
        for f in selected:
            if not f.local_path or not Path(f.local_path).exists():
                results.append({"id": f.id, "status": "missing"})
                continue
            src = Path(f.local_path)
            name = fs.unique_name(dest, src.name)
            target = dest / name
            shutil.move(str(src), str(target))
            f.filed = True
            f.local_path = str(target)
            results.append({"id": f.id, "status": "filed", "name": name, "renamed": name != src.name})
    remaining = [f for f in job.files if f.state == "completed" and not f.filed]
    if not remaining:
        job.status = "filed"
    job.filed_path = fs.to_vpath(dest)
    job.updated_at = utcnow()
    db.commit()
    _cleanup_empty_dirs(expected_dir(job))
    publish_job(job)
    events.publish("fs", {"paths": [fs.to_vpath(dest), "staging"]})
    return {"destination": fs.to_vpath(dest), "results": results, "job": job_view(job)}


async def poller(get_session, client_factory, stop: asyncio.Event) -> None:
    """Background loop; backs off while slskd is unreachable."""
    interval = get_settings().poll_interval_seconds
    delay = interval
    last_error = 0.0
    while not stop.is_set():
        try:
            with get_session() as db:
                client = client_factory(db)
                async with client:
                    await poll_once(db, client)
            delay = interval
        except SlskdError as e:
            if time.monotonic() - last_error > 60:
                log.warning("download poll failed: %s", e)
                last_error = time.monotonic()
            delay = min(delay * 2, 30)
        except Exception:
            log.exception("download poller crashed; continuing")
            delay = min(delay * 2, 30)
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(stop.wait(), timeout=delay)
