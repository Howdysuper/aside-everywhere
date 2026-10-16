"""The watchdog: Hey Aside must never be silently dead again.

What went wrong before: the tray app crashed (or the machine slept through a
session) and nothing restarted it. The log just stopped. From then on "Hey
Jarvis" did nothing at all, for days, with no way to notice.

How this works now: this process (started at logon by Task Scheduler, and by
hand) spawns the app, then watches two signals:

  1. the process being gone (a crash),
  2. the app's heartbeat file going stale (a hang - alive but not listening,
     which is what a dead audio device or a wedged thread looks like).

Either one means a restart, with backoff, under a restart budget so a
permanent failure (no microphone, broken models) cannot become a restart
storm. Everything lands in the same heyaside.log, so there is one place to
look.

Runs as a plain script:  pythonw.exe watchdog.py
"""
from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent            # ...\hey-aside\windows\heyaside
WINDOWS = HERE.parent                             # ...\hey-aside\windows
sys.path.insert(0, str(WINDOWS))

from heyaside import config                       # noqa: E402  (needs the path above)

HEARTBEAT = config.DATA_DIR / "heartbeat.txt"
WATCHDOG_HEARTBEAT = config.DATA_DIR / "watchdog-heartbeat.txt"
STALE_AFTER = 120          # a healthy app rewrites it every second
CHECK_EVERY = 10
BACKOFF = [2, 5, 10, 20, 45, 90, 180]
BUDGET = 20                # restarts allowed per hour before pausing longer
BUDGET_WINDOW = 3600
BUDGET_PAUSE = 900         # after hitting the budget, wait 15 min and try again

log = config.setup_logging()


def app_command() -> list[str]:
    py = WINDOWS / ".venv" / "Scripts" / "pythonw.exe"
    if not py.exists():
        py = WINDOWS / ".venv" / "Scripts" / "python.exe"
    return [str(py), "-m", "heyaside"]


def heartbeat_age() -> float | None:
    try:
        return time.time() - HEARTBEAT.stat().st_mtime
    except OSError:
        return None


def beat_fresh() -> bool:
    age = heartbeat_age()
    return age is not None and age < STALE_AFTER


def wd_beat() -> None:
    """The watchdog's own heartbeat, so the server can tell it is alive."""
    try:
        WATCHDOG_HEARTBEAT.write_text(f"{os.getpid()} {time.time():.0f}", encoding="utf-8")
    except OSError:
        pass


_GUARD: list = []   # keeps the listening server object alive for this process


def already_running() -> bool:
    """One watchdog only: opening Jarvis twice must not start two supervisors."""
    from PySide6.QtCore import QCoreApplication
    from PySide6.QtNetwork import QLocalServer

    app = QCoreApplication.instance() or QCoreApplication(sys.argv)
    server = QLocalServer()
    if server.listen(f"heyaside-watchdog-{os.environ.get('USERNAME') or 'user'}"):
        _GUARD.append(server)   # never collected while this process lives
        return False
    return True


def main() -> int:
    log.info(f"watchdog started (pid {os.getpid()})")
    # Beat before anything else: the server's audit must not see a fresh
    # watchdog as a stale one and start a second copy in the first seconds.
    wd_beat()
    if already_running():
        log.info("watchdog: another watchdog is already running; exiting")
        return 0
    child: subprocess.Popen | None = None
    # True while an app instance started by someone else is being watched:
    # our own child exiting 0 (a second instance losing the single-instance
    # race) is normal, not a crash, and must not trigger a restart.
    adopted = False
    starts: list[float] = []
    failures = 0

    def spawn() -> None:
        nonlocal child, failures, adopted
        adopted = False
        try:
            child = subprocess.Popen(
                app_command(),
                cwd=str(WINDOWS),
                # Detached in its own process group: killing the watchdog (or
                # anything above it) must never take the tray app down with it.
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) | getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                stdin=subprocess.DEVNULL,
            )
            log.info(f"watchdog: started hey aside (pid {child.pid})")
        except OSError as e:
            log.warning(f"watchdog: could not start hey aside: {e}")

    spawn()
    while True:
        time.sleep(CHECK_EVERY)
        now = time.time()
        wd_beat()
        if child is not None and child.poll() is not None:
            if child.returncode == 0 and beat_fresh():
                # Someone else's copy is serving (ours exited at once because
                # of the single-instance guard): watch that one instead.
                log.info("watchdog: another app instance is already running; watching it instead")
                child = None
                adopted = True
            else:
                log.warning(f"watchdog: hey aside exited (code {child.returncode}); restarting")
                child = None
                adopted = False
        elif child is not None and not beat_fresh():
            # A hung app never exits on its own: kill it so the restart is clean.
            log.warning(f"watchdog: heartbeat stale ({heartbeat_age():.0f}s); restarting")
            try:
                child.kill()
                child.wait(timeout=10)
            except Exception:
                pass
            child = None
            adopted = False
        if child is None and not adopted:
            starts.append(now)
            starts = [t for t in starts if now - t < BUDGET_WINDOW]
            if len(starts) > BUDGET:
                log.warning(f"watchdog: {len(starts)} starts in the last hour; pausing {BUDGET_PAUSE}s")
                time.sleep(BUDGET_PAUSE)
                starts.clear()
                failures += 1
                continue
            spawn()
            time.sleep(BACKOFF[min(failures, len(BACKOFF) - 1)])
            failures += 1
        else:
            failures = 0
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        pass
