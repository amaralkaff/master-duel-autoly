"""Duel Autopilot -- auto-plays Solo duels via CPU hook.

Hooks DLL_DuelSetPlayerType to force CPU mode (game's built-in AI).
Solo mode only -- PvP uses the F4 Assist advisor instead.
"""

from __future__ import annotations

import time

from memory.frida_il2cpp import FridaIL2CPP
from utils import logger


class DuelAutopilot:
    """Auto-plays Solo duels via CPU hook."""

    def __init__(self, frida_session: FridaIL2CPP) -> None:
        self.frida = frida_session
        self._ai_active = False
        self._last_check = 0.0
        self._mode_detected = False

    @property
    def ai_active(self) -> bool:
        return self._ai_active

    def enable(self) -> bool:
        """Enable Solo AI auto-play (CPU hook)."""
        self._mode_detected = False
        self._ai_active = True

        if self._detect_and_set_mode():
            return True

        logger.info("Autopilot: enabled (will detect mode when duel starts)")
        return True

    def _detect_and_set_mode(self) -> bool:
        """Try to enable CPU hook. Returns True if successful."""
        result = self.frida.hook_autoplay(True)
        if result and result.get("success"):
            self._mode_detected = True
            logger.ok("Autopilot: Solo AI hook enabled (CPU mode)")
            return True
        return False

    def disable(self) -> bool:
        """Disable AI auto-play."""
        self._ai_active = False
        self._mode_detected = False

        result = self.frida.hook_autoplay(False)
        if result and result.get("success"):
            logger.ok("Autopilot: Solo AI hook disabled (Human mode)")
            return True
        return False

    def tick(self) -> None:
        """Periodic decision cycle."""
        if not self._ai_active:
            return

        # Deferred mode detection (F2 pressed before duel started)
        if not self._mode_detected:
            now = time.time()
            if now - self._last_check < 1.0:
                return
            self._last_check = now
            self._detect_and_set_mode()
            return

        # Solo: hook handles everything, just periodic health check
        now = time.time()
        if now - self._last_check < 5.0:
            return
        self._last_check = now
