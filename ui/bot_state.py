"""Thread-safe shared state for the bot."""

from __future__ import annotations

import threading
from dataclasses import dataclass, field


@dataclass
class BotState:
    instant_win_enabled: bool = True
    stop_event: threading.Event = field(default_factory=threading.Event)
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def toggle_instant_win(self) -> bool:
        with self._lock:
            self.instant_win_enabled = not self.instant_win_enabled
            return self.instant_win_enabled
