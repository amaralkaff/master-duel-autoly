"""SQLite session persistence for auto-solo progress.

Tracks which chapters have been completed/skipped per Steam user,
so the bot can resume from where it left off after a crash.
"""

from __future__ import annotations

import os
import sqlite3

_DB_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "data",
)
_DB_PATH = os.path.join(_DB_DIR, "sessions.db")

# Game's LocalData folder (contains per-user subfolders)
_LOCAL_DATA = os.path.join(
    os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"),
    "Steam", "steamapps", "common",
    "Yu-Gi-Oh!  Master Duel", "LocalData",
)


def detect_steam_user() -> str:
    """Detect the Steam user ID from the game's LocalData folder.

    Returns the folder name (e.g. '1c48200c') or 'default' if not found.
    """
    try:
        entries = [
            e for e in os.listdir(_LOCAL_DATA)
            if os.path.isdir(os.path.join(_LOCAL_DATA, e))
        ]
        if entries:
            return entries[0]
    except OSError:
        pass
    return "default"


class SessionDB:
    """SQLite store for per-user chapter completion progress."""

    def __init__(self, user_id: str | None = None) -> None:
        self.user_id = user_id or detect_steam_user()
        os.makedirs(_DB_DIR, exist_ok=True)
        self._conn = sqlite3.connect(_DB_PATH, check_same_thread=False)
        self._create_tables()

    def _create_tables(self) -> None:
        self._conn.execute("""
            CREATE TABLE IF NOT EXISTS chapter_progress (
                user_id    TEXT    NOT NULL,
                chapter_id INTEGER NOT NULL,
                status     TEXT    NOT NULL,
                timestamp  TEXT    DEFAULT (datetime('now')),
                PRIMARY KEY (user_id, chapter_id)
            )
        """)
        self._conn.commit()

    def get_completed(self) -> set[int]:
        """Return set of chapter IDs that were won or skipped for this user."""
        cursor = self._conn.execute(
            "SELECT chapter_id FROM chapter_progress "
            "WHERE user_id = ? AND status IN ('won', 'skipped')",
            (self.user_id,),
        )
        return {row[0] for row in cursor.fetchall()}

    def mark(self, chapter_id: int, status: str) -> None:
        """Record a chapter result (won/skipped/failed)."""
        self._conn.execute(
            "INSERT OR REPLACE INTO chapter_progress "
            "(user_id, chapter_id, status, timestamp) "
            "VALUES (?, ?, ?, datetime('now'))",
            (self.user_id, chapter_id, status),
        )
        self._conn.commit()

    def stats(self) -> dict[str, int]:
        """Return counts by status for this user."""
        cursor = self._conn.execute(
            "SELECT status, COUNT(*) FROM chapter_progress "
            "WHERE user_id = ? GROUP BY status",
            (self.user_id,),
        )
        return dict(cursor.fetchall())

    def close(self) -> None:
        self._conn.close()
