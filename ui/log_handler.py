"""Captures log output into a deque for TUI display."""

from __future__ import annotations

import collections
from datetime import datetime


class TuiLogBuffer:
    """Ring buffer that stores recent log entries for the dashboard."""

    def __init__(self, maxlen: int = 30) -> None:
        self._buf: collections.deque[tuple[str, str, str]] = collections.deque(maxlen=maxlen)

    def append(self, tag: str, msg: str) -> None:
        ts = datetime.now().strftime("%H:%M:%S")
        self._buf.append((ts, tag, msg))

    def get_lines(self) -> list[str]:
        lines = []
        for ts, tag, msg in self._buf:
            lines.append(f"{ts} [{tag}] {msg}")
        return lines
