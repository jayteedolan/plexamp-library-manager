"""Single-admin authentication: Argon2 password hash, opaque session cookie, login rate limiting."""

import hashlib
import secrets
import time
from datetime import timedelta

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError
from fastapi import Depends, HTTPException, Request, Response
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import get_db
from app.models import AuthSession, User, utcnow

COOKIE_NAME = "lm_session"
CSRF_HEADER = "x-requested-with"
_hasher = PasswordHasher()


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password_hash: str, password: str) -> bool:
    try:
        return _hasher.verify(password_hash, password)
    except (VerifyMismatchError, InvalidHashError):
        return False


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def admin_exists(db: Session) -> bool:
    return db.query(User.id).first() is not None


def validate_new_credentials(username: str, password: str) -> None:
    if not username.strip() or len(username) > 64:
        raise HTTPException(400, "Username is required (max 64 characters).")
    if len(password) < 10:
        raise HTTPException(400, "Password must be at least 10 characters.")


def create_session(db: Session, user: User, response: Response) -> None:
    settings = get_settings()
    token = secrets.token_urlsafe(32)
    expires = utcnow() + timedelta(days=settings.session_days)
    db.add(AuthSession(token_hash=_token_hash(token), user_id=user.id, expires_at=expires))
    db.commit()
    response.set_cookie(
        COOKIE_NAME,
        token,
        max_age=settings.session_days * 86400,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="strict",
        path="/",
    )


def destroy_session(db: Session, request: Request, response: Response) -> None:
    token = request.cookies.get(COOKIE_NAME)
    if token:
        db.query(AuthSession).filter(AuthSession.token_hash == _token_hash(token)).delete()
        db.commit()
    response.delete_cookie(COOKIE_NAME, path="/")


def current_user(request: Request, db: Session = Depends(get_db)) -> User:
    """Dependency for every protected route. Also enforces the CSRF header on mutating requests."""
    if request.method not in ("GET", "HEAD", "OPTIONS") and request.headers.get(CSRF_HEADER) != "lm":
        raise HTTPException(403, "Missing CSRF header.")
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        raise HTTPException(401, "Not logged in.")
    sess = db.get(AuthSession, _token_hash(token))
    if sess is None:
        raise HTTPException(401, "Session expired.")
    expires = sess.expires_at if sess.expires_at.tzinfo else sess.expires_at.replace(tzinfo=utcnow().tzinfo)
    if expires < utcnow():
        db.delete(sess)
        db.commit()
        raise HTTPException(401, "Session expired.")
    # Sliding expiry: extend when more than a day has passed since the session was last extended.
    settings = get_settings()
    new_expiry = utcnow() + timedelta(days=settings.session_days)
    if (new_expiry - expires) > timedelta(days=1):
        sess.expires_at = new_expiry
        db.commit()
    user = db.get(User, sess.user_id)
    if user is None:
        raise HTTPException(401, "Not logged in.")
    return user


class LoginLimiter:
    """Exponential lockout per client address after repeated failures."""

    def __init__(self, free_attempts: int = 5, base_lockout: float = 30.0, max_lockout: float = 3600.0):
        self.free_attempts = free_attempts
        self.base_lockout = base_lockout
        self.max_lockout = max_lockout
        self._failures: dict[str, tuple[int, float]] = {}

    def check(self, key: str) -> None:
        count, locked_until = self._failures.get(key, (0, 0.0))
        remaining = locked_until - time.monotonic()
        if remaining > 0:
            raise HTTPException(429, f"Too many attempts. Try again in {int(remaining) + 1} seconds.")

    def fail(self, key: str) -> None:
        count, _ = self._failures.get(key, (0, 0.0))
        count += 1
        locked_until = 0.0
        if count >= self.free_attempts:
            lockout = min(self.max_lockout, self.base_lockout * 2 ** (count - self.free_attempts))
            locked_until = time.monotonic() + lockout
        self._failures[key] = (count, locked_until)

    def success(self, key: str) -> None:
        self._failures.pop(key, None)


limiter = LoginLimiter()
