"""Thread-safe shared state for the bot."""

from __future__ import annotations

import threading
from dataclasses import dataclass, field


@dataclass
class BotState:
    instant_win_enabled: bool = False
    reveal_enabled: bool = False
    autopilot_enabled: bool = False
    stop_event: threading.Event = field(default_factory=threading.Event)
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def toggle_instant_win(self) -> bool:
        with self._lock:
            self.instant_win_enabled = not self.instant_win_enabled
            return self.instant_win_enabled

    def toggle_reveal(self) -> bool:
        with self._lock:
            self.reveal_enabled = not self.reveal_enabled
            return self.reveal_enabled

    def toggle_autopilot(self) -> bool:
        with self._lock:
            self.autopilot_enabled = not self.autopilot_enabled
            return self.autopilot_enabled
