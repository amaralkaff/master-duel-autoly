# Master Duel Bot Configuration

import os
import sys
from dotenv import load_dotenv

# When bundled by PyInstaller, look for .env next to the exe
if getattr(sys, "frozen", False):
    _env_path = os.path.join(os.path.dirname(sys.executable), ".env")
    load_dotenv(_env_path)
else:
    load_dotenv()

# Window
WINDOW_TITLE = "masterduel"
PROCESS_NAME = "masterduel.exe"

# Timing
SCAN_INTERVAL = 0.5        # Polling interval for state checks

# Hotkeys
HOTKEY_INSTANT_WIN = "F1"
HOTKEY_AUTOPILOT = "F2"
HOTKEY_REVEAL = "F3"
HOTKEY_ASSIST = "F4"
HOTKEY_WIN_NOW = "F5"
HOTKEY_SPEED = "F6"
STOP_HOTKEY = "F12"

# Gemini AI (set GEMINI_API_KEY env var or create .env file)
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3-flash-preview")

# TUI
TUI_REFRESH_RATE = 4  # refreshes per second
