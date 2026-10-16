"""Running Aside through its CLI (`aside.exe` on Windows) and reading its output live.

The CLI styles its output with ANSI colours (same on macOS and Windows):
    ESC[2m created new session: X ESC[0m                        dim = meta, thinking, tool results
    ESC[32m repl ESC[0m ( code: ESC[32m'...' ESC[39m, title: ESC[32m'Opening the calendar' ESC[39m )
    plain text = Aside talking to you
    ESC[31m Error ESC[0m: ...                                      red = failure
A tool call is "green name, ESC[0m, then '(' at the start of a line"; argument values are green too.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import threading
from dataclasses import dataclass, field
from typing import Callable

ANSI = re.compile(r"\x1b\[([0-9;]*)m")
TOOL_CALL = re.compile(r"(?m)^\x1b\[32m([A-Za-z_][A-Za-z0-9_]*)\x1b\[0m\(")
SESSION = re.compile(r"(?:created new session|continuing existing session):\s*([A-Za-z0-9_-]+)")

KNOWN_STEPS = {
    "get_time": "Checking the time", "websearch": "Searching the web", "WebSearch": "Searching the web",
    "WebFetch": "Reading a web page", "history_search": "Checking your history", "history_read": "Checking your history",
    "memory_search": "Checking what I remember", "subagent": "Bringing in a helper", "subagent_wait": "Waiting on a helper",
    "Bash": "Running a quick command", "read_file": "Reading notes", "write_file": "Saving notes", "edit_file": "Updating notes",
    "write_todos": "Planning the steps", "notification": "Sending you a notification",
}

NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def find_cli(configured: str = "") -> str | None:
    """Settings, then the signed installer's location, then PATH."""
    if configured and os.path.isfile(configured):
        return configured
    local = os.environ.get("LOCALAPPDATA")
    if local:
        p = os.path.join(local, "Aside", "CLI", "current", "aside.exe")
        if os.path.isfile(p):
            return p
    mac = os.path.expanduser("~/.aside/cli/Aside CLI.app/Contents/MacOS/aside")
    if os.path.isfile(mac):
        return mac
    return shutil.which("aside")


def segments(raw: str) -> list[tuple[str, str, int]]:
    """(style, text, offset) runs. Style '0' = plain."""
    out: list[tuple[str, str, int]] = []
    style, pos = "0", 0
    for m in ANSI.finditer(raw):
        if m.start() > pos:
            out.append((style, raw[pos:m.start()], pos))
        code = m.group(1)
        style = "0" if code in ("", "0") else code
        pos = m.end()
    if pos < len(raw):
        out.append((style, raw[pos:], pos))
    return out


@dataclass
class ToolCall:
    name: str
    args: str
    start: int
    end: int
    complete: bool


def tool_calls(raw: str, final: bool) -> list[ToolCall]:
    out: list[ToolCall] = []
    for m in TOOL_CALL.finditer(raw):
        rest = raw[m.end():]
        ends = [i for i in (rest.find("\x1b[2m"), rest.find("\n\n")) if i >= 0]
        end_local = min(ends) if ends else None
        args_raw = rest[:end_local] if end_local is not None else rest
        out.append(ToolCall(m.group(1), ANSI.sub("", args_raw), m.start(), m.end() + len(args_raw), end_local is not None or final))
    return out


def step_title(tool: str, args: str) -> str | None:
    m = re.search(r"title:\s*['\"]([^'\"]{2,120})['\"]", args)
    if m:
        return m.group(1)[:60]
    m = re.search(r"skills/(?:user|builtin)/(?:site-specific/)?([a-z0-9-]+)", args)
    if m:
        words = m.group(1).split("-")
        return f"Using your {' '.join([words[0].capitalize()] + words[1:])} skill"[:60]
    if tool == "read_file" and "/memory/" in args.replace("\\", "/"):
        return "Checking what I remember"
    return KNOWN_STEPS.get(tool)


@dataclass
class Result:
    session_id: str | None = None
    answer: str = ""
    error: str | None = None
    exit_code: int = 0


def parse(raw: str) -> Result:
    """Final parse of a finished run: session id, error, and the plain text after the last styled block."""
    segs = segments(raw)
    r = Result()
    for style, text, _ in segs:
        if style == "2":
            m = SESSION.search(text)
            if m:
                r.session_id = m.group(1)
    if r.session_id is None:  # uncoloured output (some terminals strip colour): plain-text fallback
        m = SESSION.search(ANSI.sub("", raw))
        if m:
            r.session_id = m.group(1)
    for k, (style, text, _) in enumerate(segs):
        if style == "31" and "Error" in text:
            tail = "".join(t for _, t, _ in segs[k + 1:])
            r.error = (tail.split("\n")[0].strip(": ").strip() or "Aside error")
            break
    styled = [i for i, (s, t, _) in enumerate(segs) if s != "0" and t.strip()]
    last = styled[-1] if styled else -1
    if last == -1 and not any(s != "0" for s, _, _ in segs):
        # No colour at all: drop the meta lines we know and keep the rest.
        lines = [l for l in raw.splitlines() if not SESSION.search(l) and not l.startswith("Thinking:")]
        r.answer = "\n".join(lines).strip()
    else:
        r.answer = "".join(t for s, t, _ in segs[last + 1:] if s == "0").strip()
    return r


@dataclass
class AgentRun:
    """One running `aside` process, parsed live. Callbacks run on the reader thread."""

    cli: str
    args: list[str]
    on_session: Callable[[str], None] = lambda s: None
    on_step: Callable[[str], None] = lambda s: None
    on_done: Callable[[Result], None] = lambda r: None
    log: Callable[[str], None] = lambda s: None
    _proc: subprocess.Popen | None = field(default=None, init=False)
    _seen_steps: set = field(default_factory=set, init=False)
    _session_sent: bool = field(default=False, init=False)

    def start(self) -> None:
        env = dict(os.environ)
        env.setdefault("FORCE_COLOR", "1")  # keep the styling the parser relies on when stdout is a pipe
        self._proc = subprocess.Popen(
            [self.cli, *self.args], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            env=env, creationflags=NO_WINDOW,
        )
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self) -> None:
        assert self._proc and self._proc.stdout
        buf = b""
        while True:
            chunk = self._proc.stdout.read1(4096) if hasattr(self._proc.stdout, "read1") else self._proc.stdout.read(4096)
            if not chunk:
                break
            buf += chunk
            self._scan(buf.decode("utf-8", "replace"), final=False)
        code = self._proc.wait()
        raw = buf.decode("utf-8", "replace")
        self._scan(raw, final=True)
        self.log(f"aside exited {code}, {len(raw)} bytes")
        r = parse(raw)
        r.exit_code = code
        if r.error is None and code != 0:
            r.error = f"exit {code}"
        self.on_done(r)

    def _scan(self, raw: str, final: bool) -> None:
        if not self._session_sent:
            m = SESSION.search(ANSI.sub("", raw))
            if m:
                self._session_sent = True
                self.on_session(m.group(1))
        for c in tool_calls(raw, final):
            if c.complete and c.start not in self._seen_steps:
                self._seen_steps.add(c.start)
                t = step_title(c.name, c.args)
                if t:
                    self.on_step(t)

    @property
    def running(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    def terminate(self) -> None:
        if self.running:
            self._proc.terminate()


def control(cli: str, args: list[str], timeout: float = 20) -> bool:
    """Short CLI calls: session stop/steer/queue."""
    try:
        return subprocess.run([cli, *args], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                              timeout=timeout, creationflags=NO_WINDOW).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False
