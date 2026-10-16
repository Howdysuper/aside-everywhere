"""One conversation scenario, run in its own process.

A tray app's threads (audio, model loading, speech synthesis) outlive a
single test function, and logging from them after the harness closed its
streams crashes the runner. So the controller scenarios run here, in a
child process, exactly the way the real app runs, and print one JSON
RESULT line for the test to assert on.

    python scenario.py <name>
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

os.environ["QT_QPA_PLATFORM"] = "offscreen"

FAKE_CLI = r'''
import sys, time
E = "\x1b"
print(f"{E}[2mcreated new session: ses_TEST1{E}[0m", flush=True)
time.sleep(0.2)
print(f"{E}[32mrepl{E}[0m(code: {E}[32m'x'{E}[39m, title: {E}[32m'Opening the calendar'{E}[39m){E}[2m [call_1]{E}[0m", flush=True)
time.sleep(0.2)
print("You have two meetings tomorrow, sir.\n---\n- Standup 9 am\n- Review 2 pm", flush=True)
'''


def build(tmp: Path):
    from heyaside import aside_cli, audio, config
    from heyaside import app as appmod
    from PySide6.QtWidgets import QApplication

    config.SETTINGS_FILE = tmp / "settings.json"
    config.LOG_DIR = tmp / "logs"
    audio.Mic.start = lambda self: None
    audio.ensure_wake_models = lambda: None
    audio.WakeWord = lambda *a, **k: type("W", (), {"feed": lambda s, f: False, "reset": lambda s: None})()
    import heyaside.stt as stt

    stt.Transcriber = lambda *a, **k: (lambda pcm: "Hey Jarvis, what's on my calendar tomorrow?")
    fake = tmp / "fake_aside.py"
    fake.write_text(FAKE_CLI)
    orig_start = aside_cli.AgentRun.start

    def start(self):
        self.cli, self.args = sys.executable, [str(fake), *self.args]
        orig_start(self)

    aside_cli.AgentRun.start = start
    aside_cli.find_cli = lambda configured="": "fake-aside"
    config.save({**config.DEFAULTS, "spokenReplies": False})
    qapp = QApplication.instance() or QApplication([])
    ctl = appmod.Controller(qapp, config.setup_logging())
    deadline = time.time() + 10
    while ctl.state == "starting" and time.time() < deadline:
        qapp.processEvents()
        time.sleep(0.02)
    return ctl, qapp


def pump(qapp, until, timeout=10):
    deadline = time.time() + timeout
    while not until() and time.time() < deadline:
        qapp.processEvents()
        time.sleep(0.02)
    return until()


def run(name: str) -> dict:
    import tempfile

    tmp = Path(tempfile.mkdtemp(prefix="heyaside-scenario-"))
    ctl, qapp = build(tmp)
    out: dict = {"boot_state": ctl.state}
    try:
        if name == "request":
            steps: list[str] = []
            ctl.sig_step.connect(steps.append)
            ctl.on_text("Hey Jarvis, what's on my calendar tomorrow?", True)
            out["state_after_text"] = ctl.state
            out["reached_done"] = pump(qapp, lambda: ctl.island.phase == "done")
            out["session"] = ctl.session
            out["steps"] = steps
            out["has_answer"] = "two meetings tomorrow" in (ctl.island.question + " " + ctl.island.answer)
            out["prompt_has_voice_suffix"] = "Voice mode" in (ctl.run.args[-1] if ctl.run and ctl.run.args else "")
        elif name == "follow_up":
            ctl.on_text("what's on my calendar", True)
            pump(qapp, lambda: ctl.island.phase == "done")
            ctl.on_text("and the day after?", False)
            out["args"] = (ctl.run.args or [])[1:4]
            out["reached_done"] = pump(qapp, lambda: ctl.island.phase == "done")
        elif name == "thanks":
            ctl.on_text("thanks", False)
            out["state"] = pump(qapp, lambda: ctl.state == "idle")
            out["phase"] = ctl.island.phase
        elif name == "stop":
            ctl.on_text("open my calendar", True)
            out["was_running"] = bool(ctl.run and ctl.run.running)
            ctl.on_text("stop", False)
            out["stopped"] = pump(qapp, lambda: not (ctl.run and ctl.run.running))
            out["idle"] = pump(qapp, lambda: ctl.state == "idle")
        elif name == "bare_wake":
            ctl.from_wake = True
            ctl.on_text("Hey Jarvis", True)
            out["followup"] = pump(qapp, lambda: ctl.state == "followup")
        elif name == "lifecycle":
            # A speaker with no audio: the answer arrives and finishes at once,
            # which is exactly when the island must leave the screen.
            from PySide6.QtCore import QObject, Signal

            class FakeSpeaker(QObject):
                finished = Signal()

                def say(self, chunks):
                    chunks = [c for c in chunks if c.strip()]
                    if chunks:
                        self.finished.emit()

                def stop(self):
                    pass

            ctl.speaker = FakeSpeaker()
            ctl.speaker.finished.connect(ctl.on_spoken)
            ctl.s["spokenReplies"] = True     # the real setting: answers are spoken
            ctl.on_text("Hey Jarvis, what is seventeen times twenty three", True)
            out["reached_done"] = pump(qapp, lambda: ctl.island.phase != "working")
            out["state_after_answer"] = ctl.state
            out["island_after_answer"] = ctl.island.phase
            # He speaks inside the follow-up window: only now does it return.
            ctl.sig_speech_started.emit()
            for _ in range(20):
                qapp.processEvents()
                time.sleep(0.02)
            out["island_when_he_speaks"] = ctl.island.phase
        elif name == "false_alarm":
            # Noise that trips the wake model transcribes to a word or two:
            # he asks once instead of acting on background sound, and nothing
            # reaches Aside.
            ctl.on_text("mm hmm", True)
            out["state"] = pump(qapp, lambda: ctl.state in ("speaking", "followup"))
            out["session"] = ctl.session
            out["ran"] = bool(ctl.run and ctl.run.running)
            out["phase"] = ctl.island.phase
        elif name == "bare_noise_wake":
            # A wake that hears nothing at all must ask once, not guess.
            ctl.from_wake = True
            ctl.on_text("Hey Jarvis", True)
            out["state"] = pump(qapp, lambda: ctl.state == "followup")
            out["phase"] = ctl.island.phase
        elif name == "noisy_followup":
            # Short noise inside the follow-up window is dropped, not answered.
            ctl.on_text("thanks", False)
            t0 = time.time()
            while ctl.state != "idle" and time.time() - t0 < 8:
                qapp.processEvents()
                time.sleep(0.02)
            before = ctl.state
            ctl.on_text("mm hmm", False)
            for _ in range(10):
                qapp.processEvents()
                time.sleep(0.02)
            out["state_before"] = before
            out["state_after_noise"] = ctl.state
            out["session"] = ctl.session
        elif name == "four_clicks":
            isl = ctl.island
            isl.set_phase("listening")
            isl.set_question("something on screen")
            for _ in range(3):
                isl.mousePressEvent(None)
                qapp.processEvents()
            out["after_three"] = isl.phase
            isl.mousePressEvent(None)
            for _ in range(10):
                qapp.processEvents()
                time.sleep(0.02)
            out["phase"] = isl.phase
            out["state"] = ctl.state
        else:
            out["error"] = f"unknown scenario {name}"
        return out
    finally:
        ctl._audio_stop.set()


if __name__ == "__main__":
    name = sys.argv[1] if len(sys.argv) > 1 else ""
    # An optional second argument: a file to write the result to, so the
    # harness can poll for it instead of waiting on the process to exit (a
    # GUI process can leave helper processes holding its handles).
    result_file = Path(sys.argv[2]) if len(sys.argv) > 2 else None
    try:
        result = run(name)
    except Exception as e:  # the parent asserts on "error"
        result = {"error": f"{type(e).__name__}: {e}"}
    line = "RESULT " + json.dumps(result)
    print(line)
    sys.stdout.flush()
    if result_file:
        try:
            result_file.write_text(line + "\n", encoding="utf-8")
        except OSError:
            pass
    os._exit(0)
