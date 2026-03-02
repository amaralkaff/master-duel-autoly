from __future__ import annotations

import time

from memory.frida_il2cpp import FridaIL2CPP
from utils import logger


class DuelAutopilot:
    """Hooks DLL_DuelSetPlayerType to force CPU mode (Solo only)."""

    def __init__(self, frida_session: FridaIL2CPP) -> None:
        self.frida = frida_session
        self._ai_active = False
        self._last_check = 0.0
        self._mode_detected = False

    @property
    def ai_active(self) -> bool:
        return self._ai_active

    def enable(self) -> bool:
        self._mode_detected = False
        self._ai_active = True

        if self._detect_and_set_mode():
            return True

        logger.info("Autopilot: enabled (will detect mode when duel starts)")
        return True

    def _detect_and_set_mode(self) -> bool:
        result = self.frida.hook_autoplay(True)
        if result and result.get("success"):
            self._mode_detected = True
            logger.ok("Autopilot: Solo AI hook enabled (CPU mode)")
            return True
        return False

    def disable(self) -> bool:
        self._ai_active = False
        self._mode_detected = False

        result = self.frida.hook_autoplay(False)
        if result and result.get("success"):
            logger.ok("Autopilot: Solo AI hook disabled (Human mode)")
            return True
        return False

    def tick(self) -> None:
        if not self._ai_active:
            return

        # keep retrying if F2 was pressed before a duel started
        if not self._mode_detected:
            now = time.time()
            if now - self._last_check < 1.0:
                return
            self._last_check = now
            self._detect_and_set_mode()
            return

        # hook handles everything, just periodic health check
        now = time.time()
        if now - self._last_check < 5.0:
            return
        self._last_check = now
