"""PySide6 main window for Master Duel Bot."""

from __future__ import annotations

import os
import re
import sys
from datetime import datetime

from PySide6.QtCore import QTimer, Qt
from PySide6.QtGui import QFont, QTextCursor
from PySide6.QtWidgets import (
    QComboBox,
    QDialog,
    QFrame,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QListWidget,
    QMainWindow,
    QPushButton,
    QScrollArea,
    QSizePolicy,
    QSplitter,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

from memory.frida_il2cpp import FridaIL2CPP
from ui.bot_state import BotState
from ui.log_handler import TuiLogBuffer

_PHASE_NAMES = {0: "Draw", 1: "Standby", 2: "Main1", 3: "Battle", 4: "Main2", 5: "End"}

DARK_STYLE = """
QMainWindow, QWidget { background: #1e1e2e; color: #cdd6f4; }
QGroupBox { border: 1px solid #45475a; border-radius: 4px;
            margin-top: 8px; padding-top: 14px; font-weight: bold; }
QGroupBox::title { subcontrol-origin: margin; left: 8px; padding: 0 4px; }
QListWidget { background: #181825; border: 1px solid #45475a; border-radius: 4px;
              font-family: Consolas, monospace; font-size: 12px; }
QListWidget::item { padding: 2px 4px; }
QPushButton { background: #313244; border: 1px solid #45475a; border-radius: 4px;
              padding: 6px 14px; font-weight: bold; }
QPushButton:hover { background: #45475a; }
QPushButton:checked { background: #a6e3a1; color: #1e1e2e; }
QLabel { font-size: 13px; }
QSplitter::handle { background: #45475a; width: 2px; }
"""


def _env_path() -> str:
    """Return the .env file path (next to exe when frozen, else project root)."""
    if getattr(sys, "frozen", False):
        return os.path.join(os.path.dirname(sys.executable), ".env")
    return os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")


class SettingsDialog(QDialog):
    """Settings dialog for configuring the Gemini API key and model."""

    def __init__(self, parent=None, advisor=None) -> None:
        super().__init__(parent)
        self._advisor = advisor
        self.setWindowTitle("Settings")
        self.setFixedSize(420, 280)
        self.setStyleSheet(
            "QDialog { background: #1e1e2e; color: #cdd6f4; }"
            "QLabel { color: #cdd6f4; font-size: 13px; }"
            "QLineEdit { background: #181825; border: 1px solid #45475a; border-radius: 4px; "
            "  color: #cdd6f4; padding: 6px 8px; font-size: 13px; }"
            "QLineEdit:focus { border: 1px solid #89b4fa; }"
            "QComboBox { background: #181825; border: 1px solid #45475a; border-radius: 4px; "
            "  color: #cdd6f4; padding: 5px 8px; font-size: 12px; }"
            "QComboBox:focus { border: 1px solid #89b4fa; }"
            "QComboBox::drop-down { border: none; width: 20px; }"
            "QComboBox::down-arrow { image: none; border-left: 4px solid transparent; "
            "  border-right: 4px solid transparent; border-top: 5px solid #cdd6f4; }"
            "QComboBox QAbstractItemView { background: #181825; color: #cdd6f4; "
            "  border: 1px solid #45475a; selection-background-color: #313244; }"
            "QPushButton { background: #313244; border: 1px solid #45475a; border-radius: 4px; "
            "  padding: 6px 16px; font-weight: bold; color: #cdd6f4; }"
            "QPushButton:hover { background: #45475a; }"
        )

        layout = QVBoxLayout(self)
        layout.setSpacing(10)
        layout.setContentsMargins(20, 16, 20, 16)

        # -- API Key --
        layout.addWidget(QLabel("Gemini API Key"))
        key_row = QHBoxLayout()
        self._key_input = QLineEdit()
        self._key_input.setEchoMode(QLineEdit.Password)
        self._existing_key = os.environ.get("GEMINI_API_KEY", "")
        if self._existing_key:
            self._key_input.setPlaceholderText("Key saved -- enter new key to change")
        else:
            self._key_input.setPlaceholderText("Paste your Gemini API key here...")
        key_row.addWidget(self._key_input)
        self._btn_toggle = QPushButton("Show")
        self._btn_toggle.setFixedWidth(52)
        self._btn_toggle.clicked.connect(self._toggle_visibility)
        key_row.addWidget(self._btn_toggle)
        layout.addLayout(key_row)

        # -- Model selector --
        layout.addWidget(QLabel("Model"))
        model_row = QHBoxLayout()
        self._model_combo = QComboBox()
        self._model_combo.setEditable(True)
        current_model = advisor.model if advisor else os.environ.get("GEMINI_MODEL", "gemini-3-flash-preview")
        self._model_combo.addItem(current_model)
        self._model_combo.setCurrentText(current_model)
        model_row.addWidget(self._model_combo)
        self._btn_fetch = QPushButton("Fetch")
        self._btn_fetch.setFixedWidth(60)
        self._btn_fetch.setToolTip("Fetch available models from Gemini API")
        self._btn_fetch.clicked.connect(self._fetch_models)
        model_row.addWidget(self._btn_fetch)
        layout.addLayout(model_row)

        # -- Status --
        self._lbl_status = QLabel()
        self._update_status()
        layout.addWidget(self._lbl_status)

        layout.addStretch()

        # -- Buttons --
        btn_row = QHBoxLayout()
        btn_clear = QPushButton("Clear")
        btn_clear.clicked.connect(self._clear_key)
        btn_row.addWidget(btn_clear)
        btn_row.addStretch()
        btn_save = QPushButton("Save")
        btn_save.setStyleSheet(
            "QPushButton { background: #89b4fa; color: #1e1e2e; border: none; "
            "border-radius: 4px; padding: 6px 24px; font-weight: bold; }"
            "QPushButton:hover { background: #74c7ec; }"
        )
        btn_save.clicked.connect(self._save)
        btn_row.addWidget(btn_save)
        layout.addLayout(btn_row)

    def _toggle_visibility(self) -> None:
        if self._key_input.echoMode() == QLineEdit.Password:
            self._key_input.setEchoMode(QLineEdit.Normal)
            self._btn_toggle.setText("Hide")
        else:
            self._key_input.setEchoMode(QLineEdit.Password)
            self._btn_toggle.setText("Show")

    def _update_status(self) -> None:
        has = self._advisor and self._advisor.has_client
        if has:
            self._lbl_status.setText("Status: Configured")
            self._lbl_status.setStyleSheet("color: #a6e3a1; font-size: 12px;")
        else:
            self._lbl_status.setText("Status: Not configured")
            self._lbl_status.setStyleSheet("color: #f38ba8; font-size: 12px;")

    def _fetch_models(self) -> None:
        """Fetch available models from the Gemini API and populate the dropdown."""
        if not self._advisor or not self._advisor.has_client:
            # Try initializing with the current key field first
            key = self._key_input.text().strip() or self._existing_key
            if key and self._advisor:
                self._advisor.set_api_key(key)
            if not self._advisor or not self._advisor.has_client:
                self._lbl_status.setText("Status: Enter API key first")
                self._lbl_status.setStyleSheet("color: #f9e2af; font-size: 12px;")
                return

        self._btn_fetch.setEnabled(False)
        self._btn_fetch.setText("...")
        from PySide6.QtCore import QCoreApplication
        QCoreApplication.processEvents()

        models = self._advisor.list_models()
        self._btn_fetch.setEnabled(True)
        self._btn_fetch.setText("Fetch")

        if not models:
            self._lbl_status.setText("Status: Could not fetch models")
            self._lbl_status.setStyleSheet("color: #f38ba8; font-size: 12px;")
            return

        current = self._model_combo.currentText()
        self._model_combo.clear()
        self._model_combo.addItems(models)
        # Re-select the previously chosen model if it exists
        idx = self._model_combo.findText(current)
        if idx >= 0:
            self._model_combo.setCurrentIndex(idx)
        else:
            self._model_combo.setCurrentText(current)

        self._lbl_status.setText(f"Status: {len(models)} models loaded")
        self._lbl_status.setStyleSheet("color: #a6e3a1; font-size: 12px;")

    def _save(self) -> None:
        key = self._key_input.text().strip() or self._existing_key
        model = self._model_combo.currentText().strip()
        if not key:
            return
        # Write to .env
        env = _env_path()
        lines = []
        if os.path.isfile(env):
            with open(env, "r", encoding="utf-8") as f:
                lines = [
                    l for l in f.readlines()
                    if not l.startswith("GEMINI_API_KEY=") and not l.startswith("GEMINI_MODEL=")
                ]
        lines.append(f"GEMINI_API_KEY={key}\n")
        if model:
            lines.append(f"GEMINI_MODEL={model}\n")
        with open(env, "w", encoding="utf-8") as f:
            f.writelines(lines)
        # Apply at runtime
        if self._advisor:
            self._advisor.set_api_key(key)
            if model:
                self._advisor.set_model(model)
        self._update_status()
        self.accept()

    def _clear_key(self) -> None:
        self._key_input.clear()
        env = _env_path()
        if os.path.isfile(env):
            with open(env, "r", encoding="utf-8") as f:
                lines = [
                    l for l in f.readlines()
                    if not l.startswith("GEMINI_API_KEY=") and not l.startswith("GEMINI_MODEL=")
                ]
            with open(env, "w", encoding="utf-8") as f:
                f.writelines(lines)
        os.environ.pop("GEMINI_API_KEY", None)
        os.environ.pop("GEMINI_MODEL", None)
        if self._advisor:
            self._advisor.set_api_key("")
        self._update_status()


class MainWindow(QMainWindow):
    def __init__(
        self,
        frida_session: FridaIL2CPP,
        hwnd: int,
        state: BotState,
        log_buf: TuiLogBuffer,
    ) -> None:
        super().__init__()
        self.frida = frida_session
        self.hwnd = hwnd
        self.state = state
        self.log_buf = log_buf

        self.setWindowTitle("Master Duel Bot")
        self.resize(960, 800)
        self.setStyleSheet(DARK_STYLE)

        central = QWidget()
        self.setCentralWidget(central)
        main_layout = QHBoxLayout(central)
        main_layout.setSpacing(0)
        main_layout.setContentsMargins(6, 6, 6, 6)

        # ════════════════════════════════════════════
        # LEFT SIDE -- Duel info, cards, buttons, log
        # ════════════════════════════════════════════
        left = QWidget()
        left_layout = QVBoxLayout(left)
        left_layout.setSpacing(6)
        left_layout.setContentsMargins(0, 0, 4, 0)

        # -- Status row --
        status_box = QGroupBox("Status")
        sl = QHBoxLayout(status_box)
        self.lbl_attach = QLabel()
        self.lbl_frida = QLabel()
        self.lbl_hwnd = QLabel()
        sl.addWidget(self.lbl_attach)
        sl.addWidget(self.lbl_frida)
        sl.addStretch()
        sl.addWidget(self.lbl_hwnd)
        left_layout.addWidget(status_box)

        # -- Duel info --
        duel_box = QGroupBox("Duel")
        dl = QHBoxLayout(duel_box)
        self.lbl_my_lp = QLabel("My LP: --")
        self.lbl_rival_lp = QLabel("Rival LP: --")
        self.lbl_turn = QLabel("")
        dl.addWidget(self.lbl_my_lp)
        dl.addWidget(self.lbl_rival_lp)
        dl.addStretch()
        dl.addWidget(self.lbl_turn)
        left_layout.addWidget(duel_box)

        # -- Hand + Field side-by-side --
        cards_row = QHBoxLayout()
        hand_box = QGroupBox("My Hand")
        hl = QVBoxLayout(hand_box)
        self.list_hand = QListWidget()
        hl.addWidget(self.list_hand)
        cards_row.addWidget(hand_box)

        field_box = QGroupBox("My Field")
        fl = QVBoxLayout(field_box)
        self.list_my_field = QListWidget()
        fl.addWidget(self.list_my_field)
        cards_row.addWidget(field_box)
        left_layout.addLayout(cards_row)

        # -- Rival field --
        rival_box = QGroupBox("Rival Field")
        rl = QVBoxLayout(rival_box)
        self.list_rival_field = QListWidget()
        rl.addWidget(self.list_rival_field)
        left_layout.addWidget(rival_box)

        # -- GY / Deck summary --
        self.lbl_gy_deck = QLabel("")
        self.lbl_gy_deck.setFont(QFont("Consolas", 11))
        left_layout.addWidget(self.lbl_gy_deck)

        # -- Feature buttons --
        feat_box = QGroupBox("Features")
        feat_lay = QHBoxLayout(feat_box)
        self.btn_autopilot = QPushButton("Autopilot [F2]")
        self.btn_autopilot.setCheckable(True)
        self.btn_instant_win = QPushButton("Instant Win [F1]")
        self.btn_instant_win.setCheckable(True)
        self.btn_reveal = QPushButton("Reveal [F3]")
        self.btn_reveal.setCheckable(True)
        self.btn_win_now = QPushButton("Win Now [F5]")
        self.btn_speed = QPushButton("Speed [F6]")
        self.btn_speed.setCheckable(True)
        feat_lay.addWidget(self.btn_autopilot)
        feat_lay.addWidget(self.btn_instant_win)
        feat_lay.addWidget(self.btn_reveal)
        feat_lay.addWidget(self.btn_win_now)
        feat_lay.addWidget(self.btn_speed)
        left_layout.addWidget(feat_box)

        # -- Log viewer --
        log_box = QGroupBox("Log")
        ll = QVBoxLayout(log_box)
        self.log_view = QTextEdit()
        self.log_view.setReadOnly(True)
        self.log_view.setFont(QFont("Consolas", 10))
        self.log_view.setStyleSheet(
            "QTextEdit { background: #181825; border: 1px solid #45475a; "
            "border-radius: 4px; color: #a6adc8; padding: 4px; }"
        )
        ll.addWidget(self.log_view)
        left_layout.addWidget(log_box)

        # ════════════════════════════════════════════
        # RIGHT SIDE -- AI Advisor (chat-style)
        # ════════════════════════════════════════════
        right = QWidget()
        right.setStyleSheet("background: #11111b;")
        right_layout = QVBoxLayout(right)
        right_layout.setSpacing(0)
        right_layout.setContentsMargins(0, 0, 0, 0)

        # -- Header --
        header = QWidget()
        header.setFixedHeight(48)
        header.setStyleSheet(
            "background: #181825; border-bottom: 1px solid #313244;"
        )
        header_lay = QHBoxLayout(header)
        header_lay.setContentsMargins(12, 0, 12, 0)

        ai_icon = QLabel("AI")
        ai_icon.setFixedSize(28, 28)
        ai_icon.setAlignment(Qt.AlignCenter)
        ai_icon.setStyleSheet(
            "background: #89b4fa; color: #1e1e2e; border-radius: 14px; "
            "font-weight: bold; font-size: 11px;"
        )
        header_lay.addWidget(ai_icon)

        title_col = QVBoxLayout()
        title_col.setSpacing(0)
        lbl_title = QLabel("Duel Advisor")
        lbl_title.setStyleSheet("color: #cdd6f4; font-weight: bold; font-size: 14px; background: transparent;")
        self.lbl_ai_status = QLabel("Gemini 3 Flash")
        self.lbl_ai_status.setStyleSheet("color: #6c7086; font-size: 10px; background: transparent;")
        title_col.addWidget(lbl_title)
        title_col.addWidget(self.lbl_ai_status)
        header_lay.addLayout(title_col)
        header_lay.addStretch()

        self.btn_settings = QPushButton("\u2699")
        self.btn_settings.setFixedSize(28, 26)
        self.btn_settings.setCursor(Qt.PointingHandCursor)
        self.btn_settings.setStyleSheet(
            "QPushButton { background: #313244; color: #a6adc8; border: 1px solid #45475a; "
            "border-radius: 4px; font-size: 15px; padding: 0; }"
            "QPushButton:hover { background: #45475a; }"
        )
        header_lay.addWidget(self.btn_settings)

        self.btn_clear_ai = QPushButton("Clear")
        self.btn_clear_ai.setFixedSize(52, 26)
        self.btn_clear_ai.setStyleSheet(
            "QPushButton { background: #313244; color: #a6adc8; border: 1px solid #45475a; "
            "border-radius: 4px; font-size: 11px; padding: 0; }"
            "QPushButton:hover { background: #45475a; }"
        )
        self.btn_clear_ai.clicked.connect(self._clear_ai)
        header_lay.addWidget(self.btn_clear_ai)

        right_layout.addWidget(header)

        # -- Chat area (scrollable) --
        self._chat_area = QTextEdit()
        self._chat_area.setReadOnly(True)
        self._chat_area.setStyleSheet(
            "QTextEdit { background: #11111b; border: none; padding: 12px; "
            "font-family: 'Segoe UI', sans-serif; font-size: 13px; color: #cdd6f4; }"
            "QScrollBar:vertical { background: #11111b; width: 6px; }"
            "QScrollBar::handle:vertical { background: #45475a; border-radius: 3px; min-height: 20px; }"
            "QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical { height: 0; }"
        )
        self._chat_area.setHtml(self._welcome_html())
        right_layout.addWidget(self._chat_area)

        # -- Ask button (bottom) --
        btn_bar = QWidget()
        btn_bar.setFixedHeight(56)
        btn_bar.setStyleSheet("background: #181825; border-top: 1px solid #313244;")
        btn_bar_lay = QHBoxLayout(btn_bar)
        btn_bar_lay.setContentsMargins(12, 8, 12, 8)

        self.btn_assist = QPushButton("Ask AI   [F4]")
        self.btn_assist.setFixedHeight(38)
        self.btn_assist.setCursor(Qt.PointingHandCursor)
        self.btn_assist.setStyleSheet(
            "QPushButton { background: qlineargradient(x1:0,y1:0,x2:1,y2:0, "
            "stop:0 #89b4fa, stop:1 #74c7ec); color: #1e1e2e; "
            "font-size: 14px; font-weight: bold; border: none; border-radius: 8px; padding: 0 20px; }"
            "QPushButton:hover { background: qlineargradient(x1:0,y1:0,x2:1,y2:0, "
            "stop:0 #74c7ec, stop:1 #89dceb); }"
            "QPushButton:pressed { background: #585b70; color: #cdd6f4; }"
        )
        btn_bar_lay.addWidget(self.btn_assist)
        right_layout.addWidget(btn_bar)

        # -- Splitter: left | right --
        splitter = QSplitter(Qt.Horizontal)
        splitter.addWidget(left)
        splitter.addWidget(right)
        splitter.setSizes([540, 380])
        splitter.setHandleWidth(2)
        main_layout.addWidget(splitter)

        # -- AI chat messages buffer --
        self._ai_messages: list[dict] = []
        self._ai_dirty = False

        # -- Refresh timer (250ms) --
        self._timer = QTimer(self)
        self._timer.timeout.connect(self._refresh)
        self._timer.start(250)

    # ── AI advisor methods ─────────────────────────────────────────

    @staticmethod
    def _welcome_html() -> str:
        return (
            '<div style="text-align:center; padding:40px 20px;">'
            '<div style="font-size:32px; margin-bottom:12px;">AI</div>'
            '<div style="color:#a6adc8; font-size:14px; font-weight:bold; margin-bottom:8px;">'
            'Duel Advisor</div>'
            '<div style="color:#6c7086; font-size:12px; line-height:1.6;">'
            'Press <span style="color:#89b4fa; font-weight:bold;">F4</span> '
            'or click <span style="color:#89b4fa; font-weight:bold;">Ask AI</span> '
            'during a duel.<br>'
            'The AI will analyze your cards, field,<br>'
            'GY, and give you strategic advice.</div>'
            '</div>'
        )

    def append_ai_advice(self, text: str, msg_type: str = "ai") -> None:
        """Add a message to the AI advisor chat.

        msg_type: "ai" for advice, "system" for status, "loading" for thinking indicator.
        """
        ts = datetime.now().strftime("%H:%M:%S")
        self._ai_messages.append({"text": text, "type": msg_type, "time": ts})
        self._ai_dirty = True

    def _clear_ai(self) -> None:
        self._ai_messages.clear()
        self._chat_area.setHtml(self._welcome_html())
        self._ai_dirty = False

    @staticmethod
    def _md_to_html(text: str) -> str:
        """Convert basic markdown to HTML for the chat bubbles."""
        # Escape HTML first
        text = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

        # Fix unclosed markdown (truncated responses)
        # Count ** pairs — if odd, append ** to close
        if text.count("**") % 2 != 0:
            text += "**"
        # Count single * (not part of **) — if odd, append *
        stripped_bold = re.sub(r'\*\*', '', text)
        if stripped_bold.count("*") % 2 != 0:
            text += "*"

        # Bold: **text** or __text__
        text = re.sub(r'\*\*(.+?)\*\*', r'<b style="color:#89b4fa;">\1</b>', text)
        text = re.sub(r'__(.+?)__', r'<b style="color:#89b4fa;">\1</b>', text)

        # Italic: *text* or _text_ (but not inside bold)
        text = re.sub(r'(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)', r'<i>\1</i>', text)

        # Inline code: `text`
        text = re.sub(r'`(.+?)`', r'<code style="background:#313244; padding:1px 4px; border-radius:3px;">\1</code>', text)

        lines = text.split("\n")
        result = []
        in_list = False

        for line in lines:
            stripped = line.strip()

            # Numbered list: "1. item" or "1) item"
            m = re.match(r'^(\d+)[.)]\s+(.+)$', stripped)
            if m:
                if not in_list:
                    in_list = True
                num, content = m.group(1), m.group(2)
                result.append(
                    f'<div style="margin:3px 0 3px 8px;">'
                    f'<span style="color:#89b4fa; font-weight:bold;">{num}.</span> {content}</div>'
                )
                continue

            # Bullet list: "- item" or "* item"
            m = re.match(r'^[-*]\s+(.+)$', stripped)
            if m:
                if not in_list:
                    in_list = True
                content = m.group(1)
                result.append(
                    f'<div style="margin:3px 0 3px 8px;">'
                    f'<span style="color:#f9e2af;">&#8226;</span> {content}</div>'
                )
                continue

            in_list = False

            # Empty line = paragraph break
            if not stripped:
                result.append('<div style="height:6px;"></div>')
            else:
                result.append(f'<div style="margin:2px 0;">{stripped}</div>')

        return "".join(result)

    def _render_chat(self) -> None:
        """Re-render the chat area from messages buffer."""
        if not self._ai_dirty:
            return
        self._ai_dirty = False

        html_parts = []
        for msg in self._ai_messages:
            ts = msg["time"]

            if msg["type"] == "system":
                esc = msg["text"].replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
                html_parts.append(
                    f'<div style="text-align:center; margin:8px 0;">'
                    f'<span style="color:#6c7086; font-size:11px;">{ts} -- {esc}</span>'
                    f'</div>'
                )
            elif msg["type"] == "loading":
                html_parts.append(
                    f'<div style="margin:8px 0; padding:10px 14px; '
                    f'background:#181825; border-radius:12px; border:1px solid #313244;">'
                    f'<span style="color:#89b4fa; font-size:12px;">Analyzing board state...</span>'
                    f'</div>'
                )
            else:  # "ai"
                body = self._md_to_html(msg["text"])
                html_parts.append(
                    f'<div style="margin:8px 0; padding:12px 16px; '
                    f'background:#181825; border-radius:12px; border:1px solid #313244;">'
                    f'<div style="color:#89b4fa; font-size:10px; margin-bottom:8px; font-weight:bold;">'
                    f'AI Advisor  {ts}</div>'
                    f'<div style="color:#cdd6f4; font-size:13px; line-height:1.6;">{body}</div>'
                    f'</div>'
                )

        self._chat_area.setHtml(
            '<div style="padding:4px;">' + "".join(html_parts) + '</div>'
        )
        cursor = self._chat_area.textCursor()
        cursor.movePosition(QTextCursor.End)
        self._chat_area.setTextCursor(cursor)

    # ── Periodic refresh ──────────────────────────────────────────

    def _refresh(self) -> None:
        attached = self.frida.is_attached()

        # Status
        dot = "\u2022"
        if attached:
            self.lbl_attach.setText(f'<span style="color:#a6e3a1">{dot}</span> Attached')
            self.lbl_frida.setText(f'<span style="color:#a6e3a1">{dot}</span> Frida OK')
        else:
            self.lbl_attach.setText(f'<span style="color:#f38ba8">{dot}</span> Detached')
            self.lbl_frida.setText(f'<span style="color:#f38ba8">{dot}</span> Frida OFF')
        self.lbl_attach.setTextFormat(Qt.RichText)
        self.lbl_frida.setTextFormat(Qt.RichText)
        self.lbl_hwnd.setText(f"HWND {hex(self.hwnd)}")

        # Duel data
        duel_active = self.frida.is_duel_active() if attached else False
        gs = self.frida.get_game_state() if (attached and duel_active) else None

        if gs:
            self.lbl_my_lp.setText(f"My LP: {gs['myLP']}")
            self.lbl_rival_lp.setText(f"Rival LP: {gs['rivalLP']}")
            phase = _PHASE_NAMES.get(gs.get("phase", -1), f"Phase({gs.get('phase', '?')})")
            turn_who = "Mine" if gs.get("turnPlayer") == gs.get("myself") else "Rival"
            self.lbl_turn.setText(f"Turn {gs.get('turnNum', '?')} | {phase} | {turn_who}'s turn")

            self._fill_list(self.list_hand, [
                c.get("name") or str(c.get("cardId", "?"))
                for c in gs.get("myHand", [])
            ], "My Hand")

            my_field = gs.get("myField", {})
            my_items = []
            for c in my_field.get("monsters", []) + my_field.get("extraMonsters", []):
                name = c.get("name") or str(c.get("cardId", "?"))
                pos = "ATK" if c.get("face") else "SET"
                my_items.append(f"[{c.get('zone', '?')}] {name} ({pos})")
            for c in my_field.get("spells", []):
                name = c.get("name") or str(c.get("cardId", "?"))
                pos = "UP" if c.get("face") else "SET"
                my_items.append(f"[{c.get('zone', '?')}] {name} ({pos})")
            self._fill_list(self.list_my_field, my_items, "My Field")

            r_field = gs.get("rivalField", {})
            r_items = []
            for c in r_field.get("monsters", []) + r_field.get("extraMonsters", []):
                name = c.get("name") or str(c.get("cardId", "?"))
                pos = "ATK" if c.get("face") else "SET"
                r_items.append(f"[{c.get('zone', '?')}] {name} ({pos})")
            for c in r_field.get("spells", []):
                name = c.get("name") or str(c.get("cardId", "?"))
                pos = "UP" if c.get("face") else "SET"
                r_items.append(f"[{c.get('zone', '?')}] {name} ({pos})")
            self._fill_list(self.list_rival_field, r_items, "Rival Field")

            my_gy = gs.get("myGY", [])
            rival_gy = gs.get("rivalGY", [])
            self.lbl_gy_deck.setText(
                f"GY: Mine({len(my_gy)})  Rival({len(rival_gy)})  |  "
                f"Deck: {gs.get('myDeckCount', '?')}  "
                f"Extra: {gs.get('myExtraDeckCount', '?')}  "
                f"Rival Deck: {gs.get('rivalDeckCount', '?')}"
            )
        else:
            self.lbl_my_lp.setText("My LP: --")
            self.lbl_rival_lp.setText("Rival LP: --")
            self.lbl_turn.setText("No active duel")
            self.list_hand.clear()
            self.list_my_field.clear()
            self.list_rival_field.clear()
            self.lbl_gy_deck.setText("")

        # Sync buttons
        self.btn_autopilot.setChecked(self.state.autopilot_enabled)
        self.btn_instant_win.setChecked(self.state.instant_win_enabled)
        self.btn_reveal.setChecked(self.state.reveal_enabled)
        self.btn_speed.setChecked(self.state.speed_hack_enabled)

        # Log
        lines = self.log_buf.get_lines()
        log_html = ""
        for line in lines:
            if "[OK]" in line:
                color = "#a6e3a1"
            elif "[ERROR]" in line:
                color = "#f38ba8"
            elif "[WARN]" in line:
                color = "#f9e2af"
            elif "[DEBUG]" in line:
                color = "#cba6f7"
            else:
                color = "#a6adc8"
            escaped = line.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            log_html += f'<div style="color:{color}; font-size:11px; font-family:Consolas,monospace;">{escaped}</div>'
        current_html = self.log_view.toHtml()
        if log_html and log_html not in current_html:
            self.log_view.setHtml(log_html)
            cursor = self.log_view.textCursor()
            cursor.movePosition(QTextCursor.End)
            self.log_view.setTextCursor(cursor)

        # AI chat
        self._render_chat()

    def _fill_list(self, widget: QListWidget, items: list[str], group_title: str) -> None:
        current = [widget.item(i).text() for i in range(widget.count())]
        if current != items:
            widget.clear()
            widget.addItems(items if items else ["(empty)"])
            parent_box = widget.parent()
            if isinstance(parent_box, QWidget):
                box = parent_box.parent()
                if isinstance(box, QGroupBox):
                    box.setTitle(f"{group_title} ({len(items)})")

    def closeEvent(self, event) -> None:
        self._timer.stop()
        event.accept()
