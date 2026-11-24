import os
import sqlite3
from contextlib import closing
from pathlib import Path

from backend.auth import hash_password, verify_password

DB_PATH = Path("janus.sqlite3")


def connect():
    db = sqlite3.connect(DB_PATH, timeout=10)
    db.row_factory = sqlite3.Row
    return db


def initialize_users():
    """Create the user table if it does not exist."""
    with connect() as db:
        db.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                is_admin INTEGER NOT NULL DEFAULT 0
            )
        """)


def get_user(username: str):
    """Find a user by username."""
    with connect() as db:
        row = db.execute(
            "SELECT * FROM users WHERE username = ?",
            (username,),
        ).fetchone()

    return dict(row) if row else None


def list_usernames():
    with connect() as db:
        rows = db.execute("SELECT username FROM users WHERE is_admin = 0 ORDER BY username").fetchall()
    return [row["username"] for row in rows]


def create_user(username: str, password: str, is_admin=False):
    """Create a user with a hashed password."""
    if not username.strip() or len(password) < 8:
        raise ValueError("Username required and password must be 8+ characters")

    hashed = hash_password(password)

    with connect() as db:
        cursor = db.execute(
            """
            INSERT INTO users (username, password_hash, is_admin)
            VALUES (?, ?, ?)
            """,
            (username, hashed, int(is_admin)),
        )

        user_id = cursor.lastrowid

    return {
        "id": user_id,
        "username": username,
        "is_admin": bool(is_admin),
    }


def authenticate_user(username: str, password: str):
    """Check credentials against the database."""
    user = get_user(username)

    if not user:
        return None

    if not verify_password(password, user["password_hash"]):
        return None

    return user

def bootstrap_admin():
    """Create the first administrator from environment variables."""
    initialize_users()

    with connect() as db:
        existing_admin = db.execute(
            "SELECT id FROM users WHERE is_admin = 1 LIMIT 1"
        ).fetchone()

    if existing_admin:
        return

    username = os.getenv("JANUS_ADMIN_USER")
    password = os.getenv("JANUS_ADMIN_PASSWORD")

    if not username or not password:
        raise RuntimeError(
            "No admin exists. Set JANUS_ADMIN_USER and "
            "JANUS_ADMIN_PASSWORD before starting Janus."
        )

    create_user(username, password, is_admin=True)


def migrate_auth_database():
    """Copy the old auth tables once, leaving the original database intact."""
    legacy = Path(__file__).resolve().parents[1] / "janus_auth.db"
    if not legacy.is_file():
        return

    with closing(connect()) as db, db:
        db.execute("ATTACH DATABASE ? AS legacy", (str(legacy),))
        db.execute("BEGIN IMMEDIATE")
        db.execute("CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY)")
        if db.execute("SELECT 1 FROM migrations WHERE name = 'auth_database'").fetchone():
            return
        for table in ("users", "device_permissions", "alert_rules"):
            exists = db.execute(
                "SELECT 1 FROM legacy.sqlite_master WHERE type = 'table' AND name = ?", (table,)
            ).fetchone()
            if exists:
                db.execute(f"INSERT INTO main.{table} SELECT * FROM legacy.{table}")
        db.execute("INSERT INTO migrations VALUES ('auth_database')")
