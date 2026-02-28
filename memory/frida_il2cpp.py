"""Frida-based IL2CPP manipulation for Master Duel.

Attaches Frida to the game, finds the native duel engine's XOR-obfuscated
LP storage via IL2CPP introspection + native disassembly, and provides
instant-win by writing 0 to the opponent's LP.
"""

from __future__ import annotations

import os
import frida

from utils import logger
from config import PROCESS_NAME

_AGENT_PATH = os.path.join(os.path.dirname(__file__), "frida_agent.js")


class FridaIL2CPP:
    """Manages a Frida session for LP manipulation."""

    def __init__(self) -> None:
        self._session: frida.core.Session | None = None
        self._script: frida.core.Script | None = None
        self._api = None

    def attach(self, process_name: str | None = None) -> bool:
        target = process_name or PROCESS_NAME
        try:
            logger.info(f"Frida: attaching to {target}...")
            self._session = frida.attach(target)
        except frida.ProcessNotFoundError:
            logger.error(f"Frida: process '{target}' not found.")
            return False
        except frida.PermissionDeniedError:
            logger.error("Frida: permission denied. Run as administrator.")
            return False
        except Exception as exc:
            logger.error(f"Frida: attach failed - {exc}")
            return False

        try:
            with open(_AGENT_PATH, "r", encoding="utf-8") as f:
                agent_src = f.read()
            self._script = self._session.create_script(agent_src)
            self._script.on("message", self._on_message)
            self._script.load()
            self._api = self._script.exports_sync
        except Exception as exc:
            logger.error(f"Frida: failed to load agent - {exc}")
            self.detach()
            return False

        try:
            if self._api.ping() != "pong":
                raise RuntimeError("Bad ping")
        except Exception as exc:
            logger.error(f"Frida: agent not responding - {exc}")
            self.detach()
            return False

        logger.ok("Frida: attached and agent loaded.")
        return True

    def detach(self) -> None:
        if self._script:
            try:
                self._script.unload()
            except Exception:
                pass
            self._script = None
        if self._session:
            try:
                self._session.detach()
            except Exception:
                pass
            self._session = None
        self._api = None

    def is_attached(self) -> bool:
        return self._api is not None

    def reattach(self) -> bool:
        """Detach and re-attach Frida if the script was destroyed."""
        logger.info("Frida: re-attaching...")
        self.detach()
        return self.attach()

    def _on_message(self, message: dict, data) -> None:
        if message.get("type") == "send":
            payload = message.get("payload", "")
            if isinstance(payload, str):
                logger.debug(f"[Frida] {payload}")
        elif message.get("type") == "error":
            logger.error(f"Frida error: {message.get('description', message)}")

    # ── Duel state ──

    def is_duel_active(self) -> bool:
        if not self._api:
            return False
        try:
            return self._api.active()
        except Exception:
            self._api = None
            return False

    def get_duel_status(self) -> dict | None:
        if not self._api:
            return None
        try:
            result = self._api.status()
            if "error" in result:
                return None
            return result
        except Exception:
            return None

    def instant_win(self) -> bool:
        """Write 0 to opponent LP in XOR-obfuscated native memory."""
        if not self._api:
            logger.error("Frida: not attached.")
            return False
        try:
            result = self._api.win()
        except Exception as exc:
            logger.error(f"Frida instant_win failed: {exc}")
            return False

        if "error" in result:
            logger.error(f"Frida: {result['error']}")
            return False

        status = result.get("status", "")
        if status == "already_zero":
            logger.ok("Opponent LP already 0.")
            return True
        if status == "success":
            logger.ok(
                f"Opponent LP set to 0 (was {result['before']}). "
                f"Rival=player{result['rival']}"
            )
            return True

        logger.warn(f"LP write may have failed: {result}")
        return False

    # ── Solo API calls ──

    def call_api_with_result(self, method: str, arg: int | None = None) -> dict | None:
        """Call a Network API method and return success + GetParam data."""
        if not self._api:
            logger.error("Frida: not attached.")
            return None
        try:
            return self._api.call_api_with_result(method, arg)
        except Exception as exc:
            logger.error(f"call_api_with_result({method}) failed: {exc}")
            return None

    def call_solo_api_fire_and_forget(
        self, method: str, arg: int | None = None
    ) -> dict | None:
        """Call a Network API method without polling the Handle."""
        if not self._api:
            logger.error("Frida: not attached.")
            return None
        try:
            result = self._api.call_api_fire_and_forget(method, arg)
            return result
        except Exception as exc:
            logger.error(f"call_api_fire_and_forget({method}) failed: {exc}")
            return None

    def call_api_two_args(self, method: str, arg1: int, arg2: int) -> dict | None:
        """Call a Network API method with 2 int args."""
        if not self._api:
            return None
        try:
            return self._api.call_api_two_args(method, arg1, arg2)
        except Exception as exc:
            logger.error(f"call_api_two_args({method}) failed: {exc}")
            return None

    # ── Solo bot methods ──

    def set_time_scale(self, scale: float) -> bool:
        """Set UnityEngine.Time.timeScale. 1.0=normal, 10.0=10x speed."""
        if not self._api:
            return False
        try:
            result = self._api.set_time_scale(scale)
            return result.get("success", False)
        except Exception as exc:
            logger.error(f"set_time_scale failed: {exc}")
            return False

    def clean_vc_stack(self) -> bool:
        """Remove stuck VCs from the VC stack."""
        if not self._api:
            return False
        try:
            result = self._api.clean_vc_stack()
            if result.get("success"):
                logger.ok(
                    f"VC stack cleaned: {result.get('action')} "
                    f"(topVC={result.get('topVC')})"
                )
                return True
            logger.warn(f"cleanVcStack: {result.get('error', 'failed')}")
            if result.get("vcmMethods"):
                logger.debug(f"VCM methods: {result['vcmMethods']}")
            if result.get("cvcmMethods"):
                logger.debug(f"CVCM methods: {result['cvcmMethods']}")
            if result.get("vcmFields"):
                logger.debug(f"VCM fields: {result['vcmFields']}")
            return False
        except Exception as exc:
            logger.error(f"cleanVcStack RPC failed: {exc}")
            return False

    def force_reboot(self) -> bool:
        """Trigger game reboot via CVCM.PrepareReboot + ExecuteReboot."""
        if not self._api:
            return False
        try:
            result = self._api.force_reboot()
            return result.get("success", False)
        except Exception:
            return True  # Assume reboot triggered if we lost connection

    def dismiss_all_dialogs(self) -> bool:
        """Dismiss all error dialogs and stuck VCs."""
        if not self._api:
            return False
        try:
            result = self._api.dismiss_all_dialogs()
            if result.get("success"):
                actions = result.get("actions", [])
                logger.info(f"Dismissed: {actions}")
                return True
            return False
        except Exception as exc:
            logger.error(f"dismissAllDialogs RPC failed: {exc}")
            return False

    def advance_duel_end(self) -> bool:
        """Set DuelEndMessage.IsNextButtonClicked = true to auto-advance win screen."""
        if not self._api:
            return False
        try:
            result = self._api.advance_duel_end()
            return result.get("success", False)
        except Exception:
            return False

    def hook_result_screens(self) -> bool:
        """Install Interceptor hooks to auto-dismiss result/clear screens."""
        if not self._api:
            return False
        try:
            result = self._api.hook_result_screens()
            if result.get("success"):
                hooked = result.get("hooked", [])
                logger.info(f"Result screen hooks installed: {hooked}")
                return True
            logger.error(f"hookResultScreens failed: {result.get('error')}")
            return False
        except Exception as exc:
            logger.error(f"hookResultScreens RPC failed: {exc}")
            return False

    def retry_solo_duel(
        self,
        chapter_id: int,
        is_rental: bool = True,
    ) -> bool:
        """Call SoloSelectChapterViewController.RetryDuel."""
        if not self._api:
            logger.error("Frida: not attached.")
            return False
        try:
            result = self._api.retry_duel(chapter_id, is_rental)
            if result.get("success"):
                logger.ok(f"RetryDuel OK (chapter={chapter_id})")
                return True
            logger.error(f"RetryDuel failed: {result.get('error', 'unknown')}")
            return False
        except Exception as exc:
            logger.error(f"RetryDuel RPC failed: {exc}")
            return False


if __name__ == "__main__":
    fil = FridaIL2CPP()
    if not fil.attach():
        exit(1)
    status = fil.get_duel_status()
    if status:
        print(f"Myself=player{status['myself']} LP={status['lp'][status['myself']]}")
        print(f"Rival=player{status['rival']} LP={status['lp'][status['rival']]}")
    else:
        print("No duel active")
    fil.detach()
