import sys
from datetime import datetime
from typing import Callable, Optional

from colorama import Fore, Style, init

init(autoreset=True)

_TAG_COLORS = {
    "INFO":    Fore.CYAN,
    "OK":      Fore.GREEN,
    "WARN":    Fore.YELLOW,
    "ERROR":   Fore.RED,
    "DEBUG":   Fore.MAGENTA,
}

_log_callback: Optional[Callable[[str, str], None]] = None


def set_log_callback(fn: Optional[Callable[[str, str], None]]) -> None:
    global _log_callback
    _log_callback = fn


def _log(tag: str, msg: str) -> None:
    color = _TAG_COLORS.get(tag, "")
    ts = datetime.now().strftime("%H:%M:%S")
    print(f"{Fore.WHITE}{ts} {color}[{tag}]{Style.RESET_ALL} {msg}")
    sys.stdout.flush()
    if _log_callback:
        _log_callback(tag, msg)


def info(msg: str) -> None:
    _log("INFO", msg)


def ok(msg: str) -> None:
    _log("OK", msg)


def warn(msg: str) -> None:
    _log("WARN", msg)


def error(msg: str) -> None:
    _log("ERROR", msg)


def debug(msg: str) -> None:
    _log("DEBUG", msg)
