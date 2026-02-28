"""Thread-safe shared state for the bot."""

from __future__ import annotations

import threading
from dataclasses import dataclass, field


@dataclass
class BotState:
    instant_win_enabled: bool = True
    stop_event: threading.Event = field(default_factory=threading.Event)
    _lock: threading.Lock = field(default_factory=threading.Lock)

    # Auto-solo state
    auto_solo_enabled: bool = False
    auto_solo_status: str = "Idle"
    auto_solo_gate_id: int = 0
    auto_solo_chapter_id: int = 0
    auto_solo_duels_won: int = 0
    auto_solo_duels_failed: int = 0

    # Progress tracking
    auto_solo_total: int = 0       # total chapters to process
    auto_solo_done: int = 0        # chapters completed (won)
    auto_solo_skipped: int = 0     # chapters already completed (skipped)

    def toggle_instant_win(self) -> bool:
        with self._lock:
            self.instant_win_enabled = not self.instant_win_enabled
            return self.instant_win_enabled

    def toggle_auto_solo(self) -> bool:
        with self._lock:
            self.auto_solo_enabled = not self.auto_solo_enabled
            if self.auto_solo_enabled:
                self.auto_solo_status = "Starting..."
            else:
                self.auto_solo_status = "Idle"
            return self.auto_solo_enabled
