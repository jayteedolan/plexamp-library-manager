"""Recycle bin on the same drive as the library, so deleting and restoring are instant renames."""

import contextlib
import json
import shutil
import uuid
from datetime import timedelta
from pathlib import Path

from sqlalchemy.orm import Session

from app.config import get_settings
from app.models import TrashItem, utcnow
from app.services import fs


def _item_dir(item_id: str) -> Path:
    return get_settings().trash_root / item_id


def move_to_trash(db: Session, path: Path, commit: bool = True) -> TrashItem:
    """Move an absolute path (already validated to be inside a root) into the trash."""
    fs.check_writable()
    if fs.is_root(path):
        raise fs.FsError(400, "The top-level folders cannot be deleted.")
    original = fs.to_vpath(path)
    size, _ = fs.tree_size(path)
    item = TrashItem(id=str(uuid.uuid4()), name=path.name, original_path=original, is_dir=path.is_dir(),
                     size=size, deleted_at=utcnow())
    holder = _item_dir(item.id)
    holder.mkdir(parents=True)
    shutil.move(str(path), str(holder / path.name))
    # Keep a copy of the metadata next to the item so it survives a lost database.
    with contextlib.suppress(OSError):
        (holder / ".lm-trash.json").write_text(json.dumps({
            "name": item.name, "original_path": original, "deleted_at": item.deleted_at.isoformat(),
        }))
    db.add(item)
    if commit:
        db.commit()
    return item


def delete_paths(db: Session, vpaths: list[str]) -> list[TrashItem]:
    fs.check_writable()
    paths = [fs.resolve(v) for v in vpaths]
    for p in paths:
        if fs.is_root(p):
            raise fs.FsError(400, "The top-level folders cannot be deleted.")
    items = []
    with fs.locks.hold(paths):
        for p in paths:
            items.append(move_to_trash(db, p, commit=False))
    db.commit()
    return items


def list_items(db: Session) -> list[TrashItem]:
    return db.query(TrashItem).order_by(TrashItem.deleted_at.desc()).all()


def restore(db: Session, item_id: str, resolution: str | None = None) -> str:
    fs.check_writable()
    item = db.get(TrashItem, item_id)
    if item is None:
        raise fs.FsError(404, "That item is no longer in the trash.")
    stored = _item_dir(item.id) / item.name
    if not stored.exists():
        db.delete(item)
        db.commit()
        raise fs.FsError(404, "The trashed files are missing; the entry was removed.")
    target = fs.resolve(item.original_path, must_exist=False)
    parent = target.parent
    with fs.locks.hold([parent if parent.exists() else fs.roots()[fs.split_vpath(item.original_path)[0]]]):
        parent.mkdir(parents=True, exist_ok=True)
        if target.exists():
            if resolution == "keep_both":
                target = parent / fs.unique_name(parent, target.name)
            elif resolution == "replace":
                move_to_trash(db, target, commit=False)
            else:
                raise fs.FsError(409, f"Something named '{target.name}' already exists at the original location.",
                                 {"conflict": item.original_path})
        shutil.move(str(stored), str(target))
    shutil.rmtree(_item_dir(item.id), ignore_errors=True)
    db.delete(item)
    db.commit()
    return fs.to_vpath(target)


def purge(db: Session, item_id: str) -> None:
    item = db.get(TrashItem, item_id)
    if item is None:
        return
    fs.check_writable()
    shutil.rmtree(_item_dir(item.id), ignore_errors=True)
    db.delete(item)
    db.commit()


def empty(db: Session) -> int:
    items = list_items(db)
    for item in items:
        purge(db, item.id)
    return len(items)


def purge_older_than(db: Session, days: int) -> int:
    cutoff = utcnow() - timedelta(days=days)
    count = 0
    for item in list_items(db):
        deleted = item.deleted_at if item.deleted_at.tzinfo else item.deleted_at.replace(tzinfo=cutoff.tzinfo)
        if deleted < cutoff:
            purge(db, item.id)
            count += 1
    return count


def total_size(db: Session) -> int:
    return sum(i.size for i in list_items(db))
