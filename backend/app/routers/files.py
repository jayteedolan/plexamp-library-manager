import asyncio
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app import events
from app.auth import current_user
from app.db import get_db, session_scope
from app.services import fs, trash
from app.services.tags import quality_label, read_audio

router = APIRouter(prefix="/api", tags=["files"], dependencies=[Depends(current_user)])

_ops: dict[str, fs.Operation] = {}


class MkdirBody(BaseModel):
    parent: str
    name: str


class RenameBody(BaseModel):
    path: str
    name: str


class TransferBody(BaseModel):
    sources: list[str]
    destination: str
    mode: str  # copy | move
    resolutions: dict[str, str] = {}


class PathsBody(BaseModel):
    paths: list[str]


def _parent(vpath: str) -> str:
    return vpath.rstrip("/").rsplit("/", 1)[0] if "/" in vpath.rstrip("/") else vpath


def _changed(*paths: str) -> None:
    events.publish("fs", {"paths": sorted(set(paths))})


@router.get("/files")
def list_files(path: str = "library", hidden: bool = False):
    return fs.list_dir(path, show_hidden=hidden)


@router.get("/files/info")
async def info(path: str):
    p = fs.resolve(path)
    data = fs.describe(p)
    if p.is_dir():
        size, count = await asyncio.to_thread(fs.tree_size, p)
        data.update({"size": size, "file_count": count})
    elif data["kind"] == "audio":
        audio = await asyncio.to_thread(read_audio, p)
        if audio:
            audio["quality"] = quality_label(audio["format"], audio["bitrate"], audio["bit_depth"],
                                             audio["sample_rate"])
        data["audio"] = audio
    return data


@router.post("/files/mkdir")
def mkdir(body: MkdirBody):
    entry = fs.mkdir(body.parent, body.name)
    _changed(body.parent)
    return entry


@router.post("/files/rename")
def rename(body: RenameBody):
    entry = fs.rename(body.path, body.name)
    _changed(_parent(body.path))
    return {"old_path": body.path, **entry}


@router.post("/files/delete")
def delete(body: PathsBody, db: Session = Depends(get_db)):
    items = trash.delete_paths(db, body.paths)
    _changed(*[_parent(p) for p in body.paths])
    events.publish("trash", {})
    return {"trashed": [{"id": i.id, "name": i.name, "original_path": i.original_path} for i in items]}


def _run_transfer(op: fs.Operation, dest: Path, srcs: list[Path], mode: str, resolutions: dict) -> None:
    last = [0.0]

    def progress() -> None:
        import time

        now = time.monotonic()
        if now - last[0] > 0.5:
            last[0] = now
            events.publish("op", op.public())

    try:
        with session_scope() as db:
            def trash_existing(p: Path) -> None:
                trash.move_to_trash(db, p, commit=False)

            fs.execute_transfer(dest, srcs, mode, resolutions, op, trash_existing, progress)
    except fs.FsError as e:
        op.error = e.message
    except OSError as e:
        op.error = f"{e.strerror or e}"
    finally:
        op.finished = True
        events.publish("op", op.public())
        events.publish("fs", {"paths": [fs.to_vpath(dest)] + [fs.to_vpath(s.parent) for s in srcs]})
        events.publish("trash", {})


@router.post("/files/transfer")
async def transfer(body: TransferBody):
    fs.check_writable()
    dest, srcs, conflicts = fs.plan_transfer(body.sources, body.destination, body.mode)
    unresolved = [c for c in conflicts if body.resolutions.get(c["name"]) not in ("replace", "keep_both", "skip")]
    if unresolved:
        raise fs.FsError(409, "Some items already exist in the destination.", {"conflicts": unresolved})
    op = fs.Operation(id=str(uuid.uuid4()), kind=body.mode)
    _ops[op.id] = op
    task = asyncio.get_running_loop().run_in_executor(None, _run_transfer, op, dest, srcs, body.mode,
                                                      body.resolutions)
    # Quick operations (renames on the same drive) finish immediately; long copies report progress.
    try:
        await asyncio.wait_for(asyncio.shield(task), timeout=1.5)
    except TimeoutError:
        pass
    _prune_ops()
    return op.public()


def _prune_ops() -> None:
    finished = [k for k, v in _ops.items() if v.finished]
    for k in finished[:-20]:
        _ops.pop(k, None)


@router.get("/ops/{op_id}")
def get_op(op_id: str):
    op = _ops.get(op_id)
    if op is None:
        raise fs.FsError(404, "Unknown operation.")
    return op.public()


@router.post("/ops/{op_id}/cancel")
def cancel_op(op_id: str):
    op = _ops.get(op_id)
    if op is None:
        raise fs.FsError(404, "Unknown operation.")
    op.cancelled = True
    return op.public()
