"""Find the game window by title."""

import win32gui


def find_window(title_substring: str) -> int | None:
    """Find a window whose title contains *title_substring* (case-insensitive).

    Returns the HWND or None.
    """
    result = []

    def _enum_cb(hwnd, _):
        if win32gui.IsWindowVisible(hwnd):
            text = win32gui.GetWindowText(hwnd)
            if title_substring.lower() in text.lower():
                result.append(hwnd)

    win32gui.EnumWindows(_enum_cb, None)
    if result:
        return result[0]
    return None
