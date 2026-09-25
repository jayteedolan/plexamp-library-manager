from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.auth import current_user
from app.db import get_db
from app.providers import PROVIDERS
from app.providers.base import SearchProvider

router = APIRouter(prefix="/api/search", tags=["search"], dependencies=[Depends(current_user)])


class SearchBody(BaseModel):
    query: str
    source: str = "soulseek"


class BrowseBody(BaseModel):
    username: str
    directory: str
    source: str = "soulseek"


def provider(source: str, db: Session) -> SearchProvider:
    cls = PROVIDERS.get(source)
    if cls is None:
        raise HTTPException(400, f"Unknown source: {source}")
    return cls(db)


@router.get("/sources")
async def sources(db: Session = Depends(get_db)):
    out = []
    for key, cls in PROVIDERS.items():
        out.append({"key": key, "label": cls.label, **(await cls(db).status())})
    return out


@router.post("")
async def start(body: SearchBody, db: Session = Depends(get_db)):
    query = body.query.strip()
    if len(query) < 2:
        raise HTTPException(400, "Type at least two characters.")
    search_id = await provider(body.source, db).start_search(query)
    return {"id": search_id, "source": body.source, "query": query}


@router.get("/{search_id}")
async def results(search_id: str, source: str = "soulseek", db: Session = Depends(get_db)):
    return await provider(source, db).search_results(search_id)


@router.post("/{search_id}/stop")
async def stop(search_id: str, source: str = "soulseek", db: Session = Depends(get_db)):
    await provider(source, db).stop_search(search_id)
    return {"ok": True}


@router.post("/browse")
async def browse(body: BrowseBody, db: Session = Depends(get_db)):
    group = await provider(body.source, db).browse_folder(body.username, body.directory)
    if group is None:
        raise HTTPException(404, "That folder has no audio files (or the user is offline).")
    return group
