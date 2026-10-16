"""The conversation state machine, end to end, one process per scenario.

Each scenario runs in tests/scenario.py as a child process: a tray app's
threads outlive a single test function, and logging from them after the
harness closed its streams crashed the runner. Isolating each scenario in
its own process is what makes these reliable, and it is also how the app
really runs.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
PY = sys.executable
SCENARIO = HERE / "scenario.py"


def _kill_tree(pid: int) -> None:
    """Kill a scenario and anything it left behind (best effort)."""
    for cmd in (f"taskkill /PID {pid} /T /F", f"taskkill /PID {pid} /F"):
        subprocess.run(cmd, shell=True, capture_output=True)


def scenario(name: str, timeout: float = 90, allow_error: bool = False) -> dict:
    """Run one scenario in its own process and read its RESULT.

    The scenario writes its result to a file; the harness polls for that
    file instead of waiting for the process to exit. A GUI process can
    leave helper processes holding its handles, so "the process exited"
    is not a reliable signal that the work is done - the result file is.
    """
    with tempfile.TemporaryDirectory(prefix="heyaside-test-") as td:
        result = Path(td) / "result.txt"
        proc = subprocess.Popen(
            [PY, str(SCENARIO), name, str(result)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL,
            cwd=str(HERE.parent),
            env={**os.environ, "QT_QPA_PLATFORM": "offscreen"},
        )
        try:
            deadline = time.time() + timeout
            while time.time() < deadline:
                if result.exists():
                    break
                if proc.poll() is not None:
                    break
                time.sleep(0.2)
            text = result.read_text(encoding="utf-8", errors="replace") if result.exists() else ""
        finally:
            if proc.poll() is None:
                _kill_tree(proc.pid)
        line = next((l for l in text.splitlines() if l.startswith("RESULT ")), None)
        assert line, f"scenario {name} produced no RESULT file in {timeout}s"
        data = json.loads(line[len("RESULT "):])
        if not allow_error:
            assert "error" not in data, f"scenario {name} failed: {data['error']}"
        return data


def test_request_runs_in_aside_and_answer_is_delivered():
    r = scenario("request")
    assert r["boot_state"] == "idle"
    assert r["state_after_text"] == "working"
    assert r["reached_done"] is True
    assert r["session"] == "ses_TEST1"
    assert r["steps"] == ["Opening the calendar"]
    assert r["has_answer"] is True
    assert r["prompt_has_voice_suffix"] is True


def test_follow_up_resumes_the_same_chat():
    r = scenario("follow_up")
    assert r["args"] == ["session", "resume", "ses_TEST1"]
    assert r["reached_done"] is True


def test_thanks_ends_the_conversation():
    r = scenario("thanks")
    assert r["state"] is True
    assert r["phase"] == "hidden"


def test_stop_while_busy():
    r = scenario("stop")
    assert r["was_running"] is True
    assert r["stopped"] is True
    assert r["idle"] is True


def test_bare_wake_word_asks_again():
    r = scenario("bare_wake")
    assert r["followup"] is True


def test_island_hides_after_answering_and_returns_only_when_he_speaks():
    """The island is on screen for Listening and Answering only; the rest of
    the time it is in the background."""
    r = scenario("lifecycle")
    assert r["reached_done"] is True
    assert r["state_after_answer"] == "followup"      # still listening, in the background
    assert r["island_after_answer"] == "hidden"       # but nothing on the screen
    assert r["island_when_he_speaks"] == "listening" # it returns the moment he talks


def test_settings_file_with_bom_is_read(tmp_path):
    from heyaside import config

    f = tmp_path / "settings.json"
    f.write_bytes(b"\xef\xbb\xbf" + b'{"jev": "C:\\\\x\\\\jev"}')
    original = config.SETTINGS_FILE
    config.SETTINGS_FILE = f
    try:
        assert config.load()["jev"] == "C:\\x\\jev"
    finally:
        config.SETTINGS_FILE = original


def test_scenario_runner_is_importable():
    """The runner must import cleanly without Qt, or every scenario above fails."""
    out = subprocess.run(
        [PY, "-c", "import ast,pathlib; ast.parse(pathlib.Path(r'%s').read_text())" % SCENARIO],
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert out.returncode == 0, out.stderr[-200:]


@pytest.mark.parametrize("name", ["request", "follow_up", "thanks", "stop", "bare_wake", "lifecycle", "false_alarm", "noisy_followup", "four_clicks"])
def test_every_scenario_is_known(name):
    """Every scenario the suite runs must be one the runner knows."""
    r = scenario(name)
    assert "boot_state" in r


def test_noise_after_a_wake_asks_once_and_never_acts():
    """The wake model fires on TV noise; a word or two is never a request."""
    r = scenario("false_alarm")
    assert not r["session"]     # nothing reached Aside
    assert r["ran"] is False    # no turn was started
    assert r["state"] is True   # he simply asked once and waited


def test_short_noise_in_the_followup_window_is_ignored():
    r = scenario("noisy_followup")
    assert r["state_before"] == "idle"
    assert r["state_after_noise"] == "idle"
    assert not r["session"]


def test_four_clicks_put_the_island_away():
    r = scenario("four_clicks")
    assert r["after_three"] == "listening"   # three clicks change nothing
    assert r["phase"] == "hidden"            # the fourth closes it
    assert r["state"] == "idle"


def test_an_unknown_scenario_fails_loudly():
    data = scenario("definitely-not-a-scenario", timeout=30, allow_error=True)
    assert "error" in data
