"""Master Duel Bot -- TUI entry point with instant win toggle."""

from __future__ import annotations

import sys
import threading

import keyboard
from colorama import init as colorama_init

from config import (
    WINDOW_TITLE,
    STOP_HOTKEY,
    HOTKEY_INSTANT_WIN,
    HOTKEY_WIN_NOW,
    SCAN_INTERVAL,
)
from memory.frida_il2cpp import FridaIL2CPP
from window.background_input import find_window
from ui.bot_state import BotState
from ui.log_handler import TuiLogBuffer
from ui.dashboard import Dashboard
from utils import logger


def bot_worker(frida_session: FridaIL2CPP, state: BotState) -> None:
    """Background thread: monitors duel state and auto-fires instant win."""
    while not state.stop_event.is_set():
        try:
            if not frida_session.is_attached():
                state.stop_event.wait(1.0)
                continue

            if not frida_session.is_duel_active():
                state.stop_event.wait(SCAN_INTERVAL)
                continue

            if not state.instant_win_enabled:
                state.stop_event.wait(SCAN_INTERVAL)
                continue

            # Duel active + instant win enabled -> write LP=0
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

    # -- Shared state --
    state = BotState()
    log_buf = TuiLogBuffer(maxlen=15)

    # Wire logger -> TUI log buffer
    logger.set_log_callback(log_buf.append)

    logger.info("Master Duel Bot starting...")

    # -- Find game window --
    hwnd = find_window(WINDOW_TITLE)
    if hwnd is None:
        logger.error(f"Could not find window '{WINDOW_TITLE}'. Is the game running?")
        sys.exit(1)
    logger.ok(f"Found game window (HWND: {hex(hwnd)})")

    # -- Attach Frida --
    frida_session = FridaIL2CPP()
    if not frida_session.attach():
        logger.error("Failed to attach Frida. Cannot proceed.")
        sys.exit(1)
    logger.ok("Frida IL2CPP session ready.")

    # -- Register hotkeys --
    def on_toggle_iw():
        new = state.toggle_instant_win()
        logger.info(f"Instant Win: {'ON' if new else 'OFF'}")

    def on_win_now():
        logger.info("One-shot instant win triggered!")
        try:
            frida_session.instant_win()
        except Exception as exc:
            logger.error(f"One-shot failed: {exc}")

    def on_quit():
        logger.warn(f"{STOP_HOTKEY} pressed -- shutting down...")
        state.stop_event.set()

    keyboard.add_hotkey(HOTKEY_INSTANT_WIN, on_toggle_iw, suppress=True)
    keyboard.add_hotkey(HOTKEY_WIN_NOW, on_win_now, suppress=True)
    keyboard.add_hotkey(STOP_HOTKEY, on_quit, suppress=True)

    # -- Start worker thread --
    worker = threading.Thread(target=bot_worker, args=(frida_session, state), daemon=True)
    worker.start()

    # -- Start dashboard (blocks main thread) --
    dashboard = Dashboard(frida_session, hwnd, state, log_buf)
    logger.ok("Dashboard running. Press F1/F5/F12.")

    try:
        dashboard.run()
    except KeyboardInterrupt:
        state.stop_event.set()
    finally:
        state.stop_event.set()
        worker.join(timeout=3.0)
        frida_session.detach()
        keyboard.unhook_all()
        print("\nBot stopped. Goodbye!")


if __name__ == "__main__":
    main()
