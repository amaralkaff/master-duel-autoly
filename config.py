# Master Duel Bot Configuration

import os
from dotenv import load_dotenv

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
STOP_HOTKEY = "F12"

# Gemini AI (set GEMINI_API_KEY env var or create .env file)
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_MODEL = "gemini-3-flash-preview"

# TUI
TUI_REFRESH_RATE = 4  # refreshes per second
