"""Small JSON cache in SQLite for third-party API responses."""

import json
from datetime import timedelta
from typing import Any

from sqlalchemy.orm import Session

from app.models import CacheEntry, utcnow


def get(db: Session, key: str) -> Any | None:
    row = db.get(CacheEntry, key)
    if row is None:
        return None
    expires = row.expires_at if row.expires_at.tzinfo else row.expires_at.replace(tzinfo=utcnow().tzinfo)
    if expires < utcnow():
        return None
    return json.loads(row.value)


def put(db: Session, key: str, value: Any, ttl: timedelta) -> None:
    row = db.get(CacheEntry, key)
    payload = json.dumps(value)
    expires = utcnow() + ttl
    if row is None:
        db.add(CacheEntry(key=key, value=payload, expires_at=expires))
    else:
        row.value, row.expires_at = payload, expires
    db.commit()


def purge_expired(db: Session) -> int:
    count = db.query(CacheEntry).filter(CacheEntry.expires_at < utcnow()).delete()
    db.commit()
    return count
