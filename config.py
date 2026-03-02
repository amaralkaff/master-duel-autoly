import os
import sys
from dotenv import load_dotenv

# pyinstaller puts .env next to the exe
if getattr(sys, "frozen", False):
    load_dotenv(os.path.join(os.path.dirname(sys.executable), ".env"))
else:
    load_dotenv()

WINDOW_TITLE = "masterduel"
PROCESS_NAME = "masterduel.exe"
SCAN_INTERVAL = 0.5

HOTKEY_INSTANT_WIN = "F1"
HOTKEY_AUTOPILOT = "F2"
HOTKEY_ASSIST = "F4"
HOTKEY_WIN_NOW = "F5"
HOTKEY_SPEED = "F6"
STOP_HOTKEY = "F12"

SPEED_SCALE = 3.0

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3-flash-preview")

TUI_REFRESH_RATE = 4
