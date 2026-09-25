"""Runtime settings editable from the UI, stored in the DB and falling back to environment values."""

from dataclasses import dataclass

from sqlalchemy.orm import Session

from app.config import get_settings
from app.models import Setting

EDITABLE_KEYS = {
    "slskd_url",
    "slskd_api_key",
    "plex_url",
    "plex_token",
    "plex_section_id",
    "plex_library_path",
    "trash_retention_days",
}
SECRET_KEYS = {"slskd_api_key", "plex_token"}


@dataclass
class RuntimeSettings:
    slskd_url: str
    slskd_api_key: str
    plex_url: str
    plex_token: str
    plex_section_id: str
    plex_library_path: str
    trash_retention_days: int


def load(db: Session) -> RuntimeSettings:
    env = get_settings()
    stored = {s.key: s.value for s in db.query(Setting).all()}

    def get(key: str) -> str:
        if key in stored:
            return stored[key]
        return str(getattr(env, key) or "")

    try:
        retention = int(get("trash_retention_days"))
    except ValueError:
        retention = 30
    return RuntimeSettings(
        slskd_url=get("slskd_url").rstrip("/"),
        slskd_api_key=get("slskd_api_key"),
        plex_url=get("plex_url").rstrip("/"),
        plex_token=get("plex_token"),
        plex_section_id=get("plex_section_id"),
        plex_library_path=get("plex_library_path") or str(env.library_root),
        trash_retention_days=max(1, retention),
    )


def save(db: Session, values: dict[str, str | int | None]) -> None:
    for key, value in values.items():
        if key not in EDITABLE_KEYS or value is None:
            continue
        # An empty secret from the UI means "unchanged": secrets are never sent to the browser.
        if key in SECRET_KEYS and value == "":
            continue
        row = db.get(Setting, key)
        if row is None:
            db.add(Setting(key=key, value=str(value)))
        else:
            row.value = str(value)
    db.commit()


def public_view(rs: RuntimeSettings) -> dict:
    return {
        "slskd_url": rs.slskd_url,
        "slskd_api_key_set": bool(rs.slskd_api_key),
        "plex_url": rs.plex_url,
        "plex_token_set": bool(rs.plex_token),
        "plex_section_id": rs.plex_section_id,
        "plex_library_path": rs.plex_library_path,
        "trash_retention_days": rs.trash_retention_days,
    }
