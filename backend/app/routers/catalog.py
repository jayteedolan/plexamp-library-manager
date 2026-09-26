from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.auth import current_user
from app.db import get_db
from app.services import catalog

router = APIRouter(prefix="/api/catalog", tags=["catalog"], dependencies=[Depends(current_user)])


@router.get("/status")
async def status(db: Session = Depends(get_db)):
    return await catalog.status(db)


@router.get("/search")
async def search(q: str, db: Session = Depends(get_db)):
    if len(q.strip()) < 2:
        raise HTTPException(400, "Type at least two characters.")
    return await catalog.search(db, q)


@router.get("/album/{album_id}")
async def album(album_id: str, db: Session = Depends(get_db)):
    return await catalog.album(db, album_id)


@router.get("/artist/{artist_id}")
async def artist(artist_id: str, db: Session = Depends(get_db)):
    return await catalog.artist(db, artist_id)


@router.get("/track/{track_id}")
async def track(track_id: str, db: Session = Depends(get_db)):
    return await catalog.track(db, track_id)
