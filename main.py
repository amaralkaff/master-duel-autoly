from __future__ import annotations

import sys
import threading
import time

import keyboard
from colorama import init as colorama_init

from config import (
    WINDOW_TITLE,
    STOP_HOTKEY,
    HOTKEY_INSTANT_WIN,
    HOTKEY_AUTOPILOT,
    HOTKEY_REVEAL,
    HOTKEY_ASSIST,
    HOTKEY_WIN_NOW,
    HOTKEY_SPEED,
    SPEED_SCALE,
    SCAN_INTERVAL,
)
from memory.frida_il2cpp import FridaIL2CPP
from window.background_input import find_window
from ui.bot_state import BotState
from ui.log_handler import TuiLogBuffer
from ui.gui_main import run_gui
from bot.autopilot import DuelAutopilot
from bot.gemini_advisor import GeminiAdvisor
from utils import logger


def bot_worker(
    frida_session: FridaIL2CPP,
    state: BotState,
    autopilot: DuelAutopilot,
) -> None:
    while not state.stop_event.is_set():
        try:
            if not frida_session.is_attached():
                state.stop_event.wait(1.0)
                continue

            if not frida_session.is_duel_active():
                state.stop_event.wait(SCAN_INTERVAL)
                continue

            if state.autopilot_enabled:
                try:
                    autopilot.tick()
                except Exception as exc:
                    logger.error(f"Autopilot tick error: {exc}")
                state.stop_event.wait(SCAN_INTERVAL)
                continue

            if state.instant_win_enabled:
                status = frida_session.get_duel_status()
                if status:
                    rival = status.get("rival", 1)
                    rival_lp = status["lp"][rival]
                    if rival_lp > 0:
                        frida_session.instant_win()

            state.stop_event.wait(0.5)

        except Exception as exc:
            logger.error(f"Worker error: {exc}")
            state.stop_event.wait(1.0)


def main() -> None:
    colorama_init()

    state = BotState()
    log_buf = TuiLogBuffer()
    logger.set_log_callback(log_buf.append)

    logger.info("Master Duel Bot starting...")

    # wait for the game to be running
    logger.info("Waiting for Master Duel window...")
    hwnd = find_window(WINDOW_TITLE)
    while hwnd is None:
        time.sleep(2)
        hwnd = find_window(WINDOW_TITLE)
    logger.ok(f"Found game window (HWND: {hex(hwnd)})")

    frida_session = FridaIL2CPP()
    while not frida_session.attach():
        logger.info("Waiting for masterduel.exe process...")
        time.sleep(3)
    logger.ok("Frida IL2CPP session ready.")

    autopilot = DuelAutopilot(frida_session)
    advisor = GeminiAdvisor()

    if state.reveal_enabled:
        if frida_session.hook_reveal(True):
            logger.ok("In-game reveal hooks installed.")
        else:
            logger.warn("In-game reveal hooks failed (will still work in TUI).")

    # hotkey callbacks
    def on_toggle_iw():
        new = state.toggle_instant_win()
        logger.info(f"Instant Win: {'ON' if new else 'OFF'}")

    def on_toggle_autopilot():
        new = state.toggle_autopilot()
        if new:
            autopilot.enable()
        else:
            autopilot.disable()
        logger.info(f"Autopilot: {'ON' if new else 'OFF'}")

    def on_toggle_reveal():
        new = state.toggle_reveal()
        frida_session.hook_reveal(new)
        logger.info(f"Reveal Cards: {'ON' if new else 'OFF'}")

    # gui sets this once the window is ready
    _assist_cb = [None]

    def on_assist():
        if _assist_cb[0]:
            _assist_cb[0]()
        else:
            logger.info("AI Assist: GUI not ready yet")

    def on_toggle_speed():
        new = state.toggle_speed_hack()
        frida_session.set_time_scale(SPEED_SCALE if new else 1.0)
        logger.info(f"Speed Hack: {'ON' if new else 'OFF'}")

    def on_win_now():
        logger.info("One-shot instant win triggered!")
        try:
            frida_session.instant_win()
        except Exception as exc:
            logger.error(f"One-shot failed: {exc}")

    def on_quit():
        logger.warn(f"{STOP_HOTKEY} pressed -- shutting down...")
        state.stop_event.set()

    keyboard.add_hotkey(HOTKEY_INSTANT_WIN, on_toggle_iw, suppress=True, trigger_on_release=True)
    keyboard.add_hotkey(HOTKEY_AUTOPILOT, on_toggle_autopilot, suppress=True, trigger_on_release=True)
    keyboard.add_hotkey(HOTKEY_REVEAL, on_toggle_reveal, suppress=True, trigger_on_release=True)
    keyboard.add_hotkey(HOTKEY_ASSIST, on_assist, suppress=True, trigger_on_release=True)
    keyboard.add_hotkey(HOTKEY_WIN_NOW, on_win_now, suppress=True, trigger_on_release=True)
    keyboard.add_hotkey(HOTKEY_SPEED, on_toggle_speed, suppress=True, trigger_on_release=True)
    keyboard.add_hotkey(STOP_HOTKEY, on_quit, suppress=True, trigger_on_release=True)

    worker = threading.Thread(target=bot_worker, args=(frida_session, state, autopilot), daemon=True)
    worker.start()

    logger.ok("GUI starting. Press F1/F2/F3/F4/F5/F6/F12.")

    try:
        run_gui(frida_session, hwnd, state, log_buf, autopilot, advisor, _assist_cb)
    except KeyboardInterrupt:
        state.stop_event.set()
    finally:
        state.stop_event.set()
        if autopilot.ai_active:
            autopilot.disable()
        worker.join(timeout=3.0)
        frida_session.detach()
        keyboard.unhook_all()
        print("\nBot stopped. Goodbye!")


if __name__ == "__main__":
    main()
