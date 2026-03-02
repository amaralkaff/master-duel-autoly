"""Frida session for Master Duel. Hooks IL2CPP to read/write game state."""

from __future__ import annotations

import os
import sys
import frida

from utils import logger
from config import PROCESS_NAME

# pyinstaller bundles data under sys._MEIPASS
if getattr(sys, "frozen", False):
    _AGENT_PATH = os.path.join(sys._MEIPASS, "memory", "frida_agent.js")
else:
    _AGENT_PATH = os.path.join(os.path.dirname(__file__), "frida_agent.js")


class FridaIL2CPP:

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

    # duel state

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

    def diag_pvp(self) -> dict | None:
        if not self._api:
            return None
        try:
            return self._api.diagpvp()
        except Exception as exc:
            logger.error(f"diagPvp failed: {exc}")
            return None

    def instant_win(self) -> bool:
        """Write 0 to opponent LP via XOR-obfuscated native memory."""
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

    # solo API calls

    def call_api_with_result(self, method: str, arg: int | None = None) -> dict | None:
        if not self._api:
            logger.error("Frida: not attached.")
            return None
        try:
            return self._api.call_api_with_result(method, arg)
        except Exception as exc:
            logger.error(f"call_api_with_result({method}) failed: {exc}")
            return None

    def call_solo_api_fire_and_forget(self, method: str, arg: int | None = None) -> dict | None:
        if not self._api:
            logger.error("Frida: not attached.")
            return None
        try:
            return self._api.call_api_fire_and_forget(method, arg)
        except Exception as exc:
            logger.error(f"call_api_fire_and_forget({method}) failed: {exc}")
            return None

    def call_api_two_args(self, method: str, arg1: int, arg2: int) -> dict | None:
        if not self._api:
            return None
        try:
            return self._api.call_api_two_args(method, arg1, arg2)
        except Exception as exc:
            logger.error(f"call_api_two_args({method}) failed: {exc}")
            return None

    def set_time_scale(self, scale: float) -> bool:
        if not self._api:
            return False
        try:
            result = self._api.set_time_scale(scale)
            return result.get("success", False)
        except Exception as exc:
            logger.error(f"set_time_scale failed: {exc}")
            return False

    def clean_vc_stack(self) -> bool:
        if not self._api:
            return False
        try:
            result = self._api.clean_vc_stack()
            if result.get("success"):
                logger.ok(f"VC stack cleaned: {result.get('action')} (topVC={result.get('topVC')})")
                return True
            logger.warn(f"cleanVcStack: {result.get('error', 'failed')}")
            return False
        except Exception as exc:
            logger.error(f"cleanVcStack RPC failed: {exc}")
            return False

    def force_reboot(self) -> bool:
        if not self._api:
            return False
        try:
            result = self._api.force_reboot()
            return result.get("success", False)
        except Exception:
            return True  # assume reboot triggered if we lost connection

    def dismiss_all_dialogs(self) -> bool:
        if not self._api:
            return False
        try:
            result = self._api.dismiss_all_dialogs()
            if result.get("success"):
                logger.info(f"Dismissed: {result.get('actions', [])}")
                return True
            return False
        except Exception as exc:
            logger.error(f"dismissAllDialogs RPC failed: {exc}")
            return False

    # game state

    def get_game_state(self) -> dict | None:
        if not self._api:
            return None
        try:
            result = self._api.game_state()
            if "error" in result:
                logger.error(f"gameState: {result['error']}")
                return None
            return result
        except Exception as exc:
            logger.error(f"gameState failed: {exc}")
            return None

    def enum_engine(self, prefix: str = "DLL_DuelCom") -> dict | None:
        if not self._api:
            return None
        try:
            result = self._api.enum_engine(prefix)
            if "error" in result:
                logger.error(f"enumEngine: {result['error']}")
                return None
            return result
        except Exception as exc:
            logger.error(f"enumEngine failed: {exc}")
            return None

    def call_engine(self, method_name: str, args: list[int] | None = None) -> dict | None:
        if not self._api:
            return None
        try:
            result = self._api.call_engine(method_name, args or [])
            if result and "error" in result:
                return None
            return result
        except Exception:
            return None

    def get_commands(self) -> dict | None:
        if not self._api:
            return None
        try:
            result = self._api.get_commands()
            if "error" in result:
                return None
            return result
        except Exception:
            return None

    # managed command methods (run on Unity main thread)

    def do_command(self, player: int, zone: int, index: int, cmd_bit: int) -> dict | None:
        if not self._api:
            return None
        try:
            return self._api.do_command(player, zone, index, cmd_bit)
        except Exception as exc:
            logger.error(f"do_command failed: {exc}")
            return None

    def move_phase(self, phase: int) -> dict | None:
        if not self._api:
            return None
        try:
            return self._api.move_phase(phase)
        except Exception as exc:
            logger.error(f"move_phase failed: {exc}")
            return None

    def cancel_command(self, decide: bool = True) -> dict | None:
        if not self._api:
            return None
        try:
            return self._api.cancel_command(decide)
        except Exception as exc:
            logger.error(f"cancel_command failed: {exc}")
            return None

    def dialog_set_result(self, result: int) -> dict | None:
        if not self._api:
            return None
        try:
            return self._api.dialog_set_result(result)
        except Exception as exc:
            logger.error(f"dialog_set_result failed: {exc}")
            return None

    def list_send_index(self, index: int) -> dict | None:
        if not self._api:
            return None
        try:
            return self._api.list_send_index(index)
        except Exception as exc:
            logger.error(f"list_send_index failed: {exc}")
            return None

    def get_input_state(self) -> dict | None:
        if not self._api:
            return None
        try:
            return self._api.get_input_state()
        except Exception as exc:
            logger.error(f"get_input_state failed: {exc}")
            return None

    def default_location(self) -> dict | None:
        if not self._api:
            return None
        try:
            return self._api.default_location()
        except Exception as exc:
            logger.error(f"default_location failed: {exc}")
            return None

    # AI vs AI hook

    def hook_autoplay(self, enable: bool) -> dict | None:
        if not self._api:
            return None
        try:
            return self._api.hook_autoplay(enable)
        except Exception as exc:
            logger.error(f"hook_autoplay failed: {exc}")
            return None

    def is_player_human(self, player: int) -> dict | None:
        if not self._api:
            return None
        try:
            return self._api.is_player_human(player)
        except Exception as exc:
            logger.error(f"is_player_human failed: {exc}")
            return None

    # native calls (like CE scripts)

    def native_move_phase(self, phase: int) -> dict | None:
        if not self._api:
            return None
        try:
            return self._api.native_move_phase(phase)
        except Exception as exc:
            logger.error(f"native_move_phase failed: {exc}")
            return None

    def native_do_command(self, player: int, zone: int, index: int, cmd_bit: int, check: bool = True) -> dict | None:
        if not self._api:
            return None
        try:
            return self._api.native_do_command(player, zone, index, cmd_bit, check)
        except Exception as exc:
            logger.error(f"native_do_command failed: {exc}")
            return None

    def native_cancel_command(self, decide: bool = True) -> dict | None:
        if not self._api:
            return None
        try:
            return self._api.native_cancel_command(decide)
        except Exception as exc:
            logger.error(f"native_cancel_command failed: {exc}")
            return None

    def hook_reveal(self, enable: bool = True) -> bool:
        if not self._api:
            return False
        try:
            result = self._api.hookreveal(enable)
            return result.get("success", False)
        except Exception as exc:
            logger.error(f"hook_reveal failed: {exc}")
            return False

    def reveal_cards(self) -> dict | None:
        if not self._api:
            return None
        try:
            result = self._api.reveal()
            if "error" in result:
                return None
            return result
        except Exception:
            return None

    def zone_scan(self) -> dict | None:
        if not self._api:
            return None
        try:
            return self._api.zonescan()
        except Exception as exc:
            logger.error(f"zone_scan failed: {exc}")
            return None

    def advance_duel_end(self) -> bool:
        if not self._api:
            return False
        try:
            result = self._api.advance_duel_end()
            return result.get("success", False)
        except Exception:
            return False

    def hook_result_screens(self) -> bool:
        if not self._api:
            return False
        try:
            result = self._api.hook_result_screens()
            if result.get("success"):
                logger.info(f"Result screen hooks installed: {result.get('hooked', [])}")
                return True
            logger.error(f"hookResultScreens failed: {result.get('error')}")
            return False
        except Exception as exc:
            logger.error(f"hookResultScreens RPC failed: {exc}")
            return False

    def retry_solo_duel(self, chapter_id: int, is_rental: bool = True) -> bool:
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
