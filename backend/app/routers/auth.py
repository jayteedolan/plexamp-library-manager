from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app import auth
from app.db import get_db
from app.models import AuthSession, User

router = APIRouter(prefix="/api/auth", tags=["auth"])


class Credentials(BaseModel):
    username: str
    password: str


class PasswordChange(BaseModel):
    current_password: str
    new_password: str


def require_csrf(request: Request) -> None:
    if request.headers.get(auth.CSRF_HEADER) != "lm":
        raise HTTPException(403, "Missing CSRF header.")


@router.get("/status")
def status(request: Request, db: Session = Depends(get_db)):
    if not auth.admin_exists(db):
        return {"setup_required": True, "authenticated": False, "username": None}
    try:
        user = auth.current_user(request, db)
    except HTTPException:
        return {"setup_required": False, "authenticated": False, "username": None}
    return {"setup_required": False, "authenticated": True, "username": user.username}


@router.post("/setup", dependencies=[Depends(require_csrf)])
def setup(body: Credentials, response: Response, db: Session = Depends(get_db)):
    if auth.admin_exists(db):
        raise HTTPException(409, "The admin account already exists.")
    auth.validate_new_credentials(body.username, body.password)
    user = User(username=body.username.strip(), password_hash=auth.hash_password(body.password))
    db.add(user)
    db.commit()
    auth.create_session(db, user, response)
    return {"ok": True, "username": user.username}


@router.post("/login", dependencies=[Depends(require_csrf)])
def login(body: Credentials, request: Request, response: Response, db: Session = Depends(get_db)):
    key = request.client.host if request.client else "unknown"
    auth.limiter.check(key)
    user = db.query(User).filter(User.username == body.username.strip()).first()
    if user is None or not auth.verify_password(user.password_hash, body.password):
        auth.limiter.fail(key)
        raise HTTPException(401, "Incorrect username or password.")
    auth.limiter.success(key)
    auth.create_session(db, user, response)
    return {"ok": True, "username": user.username}


@router.post("/logout")
def logout(request: Request, response: Response, db: Session = Depends(get_db),
           _user: User = Depends(auth.current_user)):
    auth.destroy_session(db, request, response)
    return {"ok": True}


@router.post("/password")
def change_password(body: PasswordChange, db: Session = Depends(get_db),
                    user: User = Depends(auth.current_user)):
    if not auth.verify_password(user.password_hash, body.current_password):
        raise HTTPException(400, "Current password is incorrect.")
    auth.validate_new_credentials(user.username, body.new_password)
    user.password_hash = auth.hash_password(body.new_password)
    # Sign out other devices.
    db.query(AuthSession).filter(AuthSession.user_id == user.id).delete()
    db.commit()
    return {"ok": True, "message": "Password changed. Please sign in again."}
