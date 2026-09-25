from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app import events
from app.auth import current_user
from app.db import get_db
from app.services import settings as settings_service
from app.services import trash

router = APIRouter(prefix="/api/trash", tags=["trash"], dependencies=[Depends(current_user)])


class RestoreBody(BaseModel):
    resolution: str | None = None  # keep_both | replace


@router.get("")
def list_trash(db: Session = Depends(get_db)):
    items = trash.list_items(db)
    return {
        "retention_days": settings_service.load(db).trash_retention_days,
        "total_size": sum(i.size for i in items),
        "items": [{"id": i.id, "name": i.name, "original_path": i.original_path, "is_dir": i.is_dir,
                   "size": i.size, "deleted_at": i.deleted_at} for i in items],
    }


@router.post("/{item_id}/restore")
def restore(item_id: str, body: RestoreBody, db: Session = Depends(get_db)):
    path = trash.restore(db, item_id, body.resolution)
    events.publish("trash", {})
    events.publish("fs", {"paths": [path.rsplit("/", 1)[0]]})
    return {"restored_to": path}


@router.delete("/{item_id}")
def purge(item_id: str, db: Session = Depends(get_db)):
    trash.purge(db, item_id)
    events.publish("trash", {})
    return {"ok": True}


@router.post("/empty")
def empty(db: Session = Depends(get_db)):
    count = trash.empty(db)
    events.publish("trash", {})
    return {"deleted": count}
