from datetime import UTC, datetime

from sqlalchemy import BigInteger, Boolean, DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


def utcnow() -> datetime:
    return datetime.now(UTC)


class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class AuthSession(Base):
    __tablename__ = "sessions"
    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class Setting(Base):
    __tablename__ = "settings"
    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[str] = mapped_column(Text)


class TrashItem(Base):
    __tablename__ = "trash"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    name: Mapped[str] = mapped_column(Text)
    original_path: Mapped[str] = mapped_column(Text)  # virtual path, e.g. "library/Artist/Album"
    is_dir: Mapped[bool] = mapped_column(Boolean)
    size: Mapped[int] = mapped_column(BigInteger, default=0)
    deleted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class DownloadJob(Base):
    __tablename__ = "download_jobs"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    provider: Mapped[str] = mapped_column(String(32), default="soulseek")
    username: Mapped[str] = mapped_column(String(255))
    remote_folder: Mapped[str] = mapped_column(Text)
    title: Mapped[str] = mapped_column(Text)
    # active | ready | cancelled | filed | failed | discarded
    status: Mapped[str] = mapped_column(String(16), default="active")
    filed_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)

    files: Mapped[list["DownloadFile"]] = relationship(
        back_populates="job", cascade="all, delete-orphan", order_by="DownloadFile.id"
    )


class DownloadFile(Base):
    __tablename__ = "download_files"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    job_id: Mapped[int] = mapped_column(ForeignKey("download_jobs.id", ondelete="CASCADE"))
    remote_filename: Mapped[str] = mapped_column(Text)
    size: Mapped[int] = mapped_column(BigInteger, default=0)
    transfer_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # queued | downloading | completed | failed | cancelled
    state: Mapped[str] = mapped_column(String(16), default="queued")
    remote_state: Mapped[str | None] = mapped_column(String(64), nullable=True)
    place_in_queue: Mapped[int | None] = mapped_column(Integer, nullable=True)
    bytes_transferred: Mapped[int] = mapped_column(BigInteger, default=0)
    speed: Mapped[float] = mapped_column(Float, default=0.0)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    local_path: Mapped[str | None] = mapped_column(Text, nullable=True)  # absolute path in staging
    filed: Mapped[bool] = mapped_column(Boolean, default=False)

    job: Mapped[DownloadJob] = relationship(back_populates="files")
