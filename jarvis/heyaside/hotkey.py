"""A global hotkey on Windows via RegisterHotKey (no keyboard hook, no admin rights, nothing logged)."""
from __future__ import annotations

import sys
import threading
from typing import Callable

MODS = {"alt": 0x1, "ctrl": 0x2, "shift": 0x4, "win": 0x8}
NOREPEAT = 0x4000


def parse(combo: str) -> tuple[int, int] | None:
    parts = [p.strip().lower() for p in combo.split("+") if p.strip()]
    if not parts:
        return None
    mods, key = 0, parts[-1]
    for m in parts[:-1]:
        if m not in MODS:
            return None
        mods |= MODS[m]
    if len(key) == 1 and key.isalnum():
        vk = ord(key.upper())
    elif key == "space":
        vk = 0x20
    elif key.startswith("f") and key[1:].isdigit() and 1 <= int(key[1:]) <= 24:
        vk = 0x70 + int(key[1:]) - 1
    else:
        return None
    return mods | NOREPEAT, vk


def listen(combo: str, on_press: Callable[[], None], log) -> bool:
    """Starts a thread that calls `on_press` (from that thread) whenever the combo is pressed."""
    if sys.platform != "win32":
        return False
    spec = parse(combo)
    if not spec:
        log.info(f"hotkey: cannot parse {combo!r}")
        return False

    def run() -> None:
        import ctypes
        from ctypes import wintypes

        user32 = ctypes.windll.user32
        if not user32.RegisterHotKey(None, 1, spec[0], spec[1]):
            log.info(f"hotkey: {combo} is taken by another app; pick another in settings.json")
            return
        msg = wintypes.MSG()
        while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) != 0:
            if msg.message == 0x0312:  # WM_HOTKEY
                on_press()

    threading.Thread(target=run, daemon=True).start()
    return True
