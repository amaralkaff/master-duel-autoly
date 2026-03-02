"""GUI entry point -- creates QApplication and MainWindow."""

from __future__ import annotations

import sys
import threading

from PySide6.QtWidgets import QApplication

from bot.autopilot import DuelAutopilot
from bot.gemini_advisor import GeminiAdvisor
from config import SPEED_SCALE
from memory.frida_il2cpp import FridaIL2CPP
from ui.bot_state import BotState
from ui.log_handler import TuiLogBuffer
from ui.main_window import MainWindow, SettingsDialog
from utils import logger


def run_gui(
    frida_session: FridaIL2CPP,
    hwnd: int,
    state: BotState,
    log_buf: TuiLogBuffer,
    autopilot: DuelAutopilot,
    advisor: GeminiAdvisor | None = None,
    assist_cb_ref: list | None = None,
) -> None:
    """Launch the PySide6 GUI (blocks until window is closed)."""
    app = QApplication(sys.argv)

    win = MainWindow(frida_session, hwnd, state, log_buf)

    # ── Connect feature buttons ──
    def _toggle_autopilot(checked: bool) -> None:
        if state.autopilot_enabled != checked:
            state.toggle_autopilot()
        if checked:
            autopilot.enable()
        else:
            autopilot.disable()
        logger.info(f"Autopilot: {'ON' if checked else 'OFF'}")

    def _toggle_instant_win(checked: bool) -> None:
        if state.instant_win_enabled != checked:
            state.toggle_instant_win()
        logger.info(f"Instant Win: {'ON' if checked else 'OFF'}")

    def _toggle_reveal(checked: bool) -> None:
        if state.reveal_enabled != checked:
            state.toggle_reveal()
        frida_session.hook_reveal(checked)
        logger.info(f"Reveal Cards: {'ON' if checked else 'OFF'}")

    def _assist() -> None:
        if not advisor or not advisor.has_client:
            win.append_ai_advice("No API key configured. Click the gear icon to add your Gemini API key.", "system")
            return
        if not frida_session.is_attached() or not frida_session.is_duel_active():
            win.append_ai_advice("No active duel detected.", "system")
            return

        win.append_ai_advice("", "loading")
        win.lbl_ai_status.setText("Thinking...")
        win.lbl_ai_status.setStyleSheet("color: #89b4fa; font-size: 10px; background: transparent;")

        def _query():
            try:
                advice = advisor.analyze_board(frida_session)
                # Remove loading indicator
                if win._ai_messages and win._ai_messages[-1]["type"] == "loading":
                    win._ai_messages.pop()
                if advice:
                    win.append_ai_advice(advice.strip())
                else:
                    win.append_ai_advice("Could not get advice. Check API key in .env file.", "system")
            except Exception as exc:
                if win._ai_messages and win._ai_messages[-1]["type"] == "loading":
                    win._ai_messages.pop()
                win.append_ai_advice(f"Error: {exc}", "system")
            finally:
                _update_ai_status()

        threading.Thread(target=_query, daemon=True).start()

    def _toggle_speed(checked: bool) -> None:
        if state.speed_hack_enabled != checked:
            state.toggle_speed_hack()
        frida_session.set_time_scale(SPEED_SCALE if checked else 1.0)
        logger.info(f"Speed Hack: {'ON' if checked else 'OFF'}")

    def _win_now() -> None:
        logger.info("One-shot instant win triggered!")
        try:
            frida_session.instant_win()
        except Exception as exc:
            logger.error(f"One-shot failed: {exc}")

    def _update_ai_status() -> None:
        if advisor and advisor.has_client:
            win.lbl_ai_status.setText(advisor.model)
            win.lbl_ai_status.setStyleSheet("color: #6c7086; font-size: 10px; background: transparent;")
        else:
            win.lbl_ai_status.setText("Not configured")
            win.lbl_ai_status.setStyleSheet("color: #f38ba8; font-size: 10px; background: transparent;")

    def _open_settings() -> None:
        dlg = SettingsDialog(win, advisor)
        dlg.exec()
        _update_ai_status()

    _update_ai_status()

    win.btn_autopilot.toggled.connect(_toggle_autopilot)
    win.btn_instant_win.toggled.connect(_toggle_instant_win)
    win.btn_reveal.toggled.connect(_toggle_reveal)
    win.btn_speed.toggled.connect(_toggle_speed)
    win.btn_assist.clicked.connect(_assist)
    win.btn_win_now.clicked.connect(_win_now)
    win.btn_settings.clicked.connect(_open_settings)

    # Register assist callback so F4 hotkey can trigger it
    if assist_cb_ref is not None:
        assist_cb_ref[0] = _assist

    win.show()
    app.exec()

    # ── Clean shutdown after window closes ──
    state.stop_event.set()
    if autopilot.ai_active:
        autopilot.disable()
