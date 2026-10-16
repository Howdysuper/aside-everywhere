"""Settings (a small JSON file) and per-user paths. Nothing here is ever sent anywhere."""
from __future__ import annotations

import json
import logging
import logging.handlers
import os
import sys
from pathlib import Path


def _base(env: str, fallback: str) -> Path:
    v = os.environ.get(env)
    return Path(v) if v else Path.home() / fallback


if sys.platform == "win32":
    CONFIG_DIR = _base("APPDATA", "AppData/Roaming") / "HeyAside"
    DATA_DIR = _base("LOCALAPPDATA", "AppData/Local") / "HeyAside"
else:  # development on macOS/Linux
    CONFIG_DIR = Path.home() / ".config" / "heyaside"
    DATA_DIR = Path.home() / ".local" / "share" / "heyaside"

SETTINGS_FILE = CONFIG_DIR / "settings.json"
LOG_DIR = DATA_DIR / "Logs"
MODEL_DIR = DATA_DIR / "models"

DEFAULTS: dict = {
    "wakeThreshold": 0.55,         # openWakeWord score that counts as "Hey Jarvis" (a little above the default: fewer false alarms)
    "hotkey": "ctrl+alt+j",        # push to talk / stop talking
    "silence": 1.2,                # seconds of quiet that end your sentence
    "initialWait": 8.0,            # after a bare "Hey Jarvis", how long he waits for the request
    "followUpSeconds": 15,         # keep listening this long after an answer, no wake word needed
    "newChatAfterMinutes": 10,     # a conversation within this window continues the same Aside chat
    "whisperModel": "base.en",     # faster-whisper model; "small.en" is more accurate, slower
    "voice": "en-GB-RyanNeural",
    "rate": "+9%",
    "spokenReplies": True,
    "sounds": True,
    "muted": False,
    "showJarvisWords": False,
    "asideCli": "",                # empty = find aside.exe automatically
    "permission": "ask",           # Aside session permission: ask (Guard) or full-access
    "agentModel": "",              # empty = Aside's own default model
    "jev": "",                     # optional path to Aside Phone's tools/jev for instant answers
    "micDevice": None,             # None = system default microphone
}


def load() -> dict:
    data = dict(DEFAULTS)
    try:
        user = json.loads(SETTINGS_FILE.read_text(encoding="utf-8-sig"))  # tolerate a BOM (PowerShell 5, some editors)
        if isinstance(user, dict):
            data.update({k: v for k, v in user.items() if k in DEFAULTS})
    except (OSError, ValueError):
        pass
    return data


def save(settings: dict) -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    tmp = SETTINGS_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps({k: settings[k] for k in DEFAULTS if k in settings}, indent=2), encoding="utf-8")
    tmp.replace(SETTINGS_FILE)


def setup_logging(echo: bool = False) -> logging.Logger:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    log = logging.getLogger("heyaside")
    log.setLevel(logging.INFO)
    if not log.handlers:
        h = logging.handlers.RotatingFileHandler(LOG_DIR / "heyaside.log", maxBytes=2_000_000, backupCount=1, encoding="utf-8")
        h.setFormatter(logging.Formatter("%(asctime)s %(message)s"))
        log.addHandler(h)
        if echo:
            log.addHandler(logging.StreamHandler(sys.stdout))
    return log
