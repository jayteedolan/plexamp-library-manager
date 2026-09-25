"""Environment configuration.

Values here come from environment variables (see `.env.example`). Settings that the user can change
from the UI (Plex/slskd connection details, trash retention) are also stored in the database and take
precedence over the environment; see `app.services.settings`.
"""

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    data_dir: Path = Path("/data")
    library_root: Path = Path("/mnt/usb/Music")
    staging_root: Path = Path("/mnt/usb/.lm/staging")
    trash_root: Path = Path("/mnt/usb/.lm/trash")
    # A file that only exists on the USB drive. When set and missing, every write is refused so we never
    # write into the empty mount-point directory on the SD card while the drive is unplugged.
    mount_marker: Path | None = None

    slskd_url: str = "http://localhost:5030"
    slskd_api_key: str = ""
    # Where slskd writes finished downloads, as seen by slskd. Only used to map slskd paths; normally
    # the same directory as staging_root.
    slskd_downloads_dir: str = ""

    plex_url: str = "http://host.docker.internal:32400"
    plex_token: str = ""
    plex_section_id: str = ""
    # The library root as Plex sees it (for targeted scans). Defaults to library_root.
    plex_library_path: str = ""

    trash_retention_days: int = 30
    session_days: int = 30
    cookie_secure: bool = True
    disk_warning_percent: int = 90
    static_dir: Path | None = None
    poll_interval_seconds: float = 2.0

    @property
    def db_path(self) -> Path:
        return self.data_dir / "app.db"


@lru_cache
def get_settings() -> Settings:
    return Settings()
