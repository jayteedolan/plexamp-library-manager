"""Maintenance commands, run inside the container:

    docker compose exec app python -m app.cli reset-password
"""

import getpass
import sys

from app import auth
from app.config import get_settings
from app.db import init_engine, session_scope
from app.models import AuthSession, User


def reset_password() -> int:
    settings = get_settings()
    init_engine(f"sqlite:///{settings.db_path}")
    with session_scope() as db:
        user = db.query(User).first()
        if user is None:
            print("No admin account exists yet; open the web UI to create one.")
            return 1
        pw = getpass.getpass(f"New password for '{user.username}': ")
        if pw != getpass.getpass("Repeat: "):
            print("Passwords do not match.")
            return 1
        auth.validate_new_credentials(user.username, pw)
        user.password_hash = auth.hash_password(pw)
        db.query(AuthSession).delete()
    print("Password updated; all devices have been signed out.")
    return 0


def main(argv: list[str]) -> int:
    if argv[:1] == ["reset-password"]:
        return reset_password()
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
