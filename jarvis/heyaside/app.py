"""Jarvis for Windows: say "Hey Jarvis" (or "hey aside"), ask, and he does it; Ryan reads the answer back.

Flow (same as the Mac app):
  wake word (or the hotkey) -> listen until you stop talking -> transcribe on this PC -> Aside session via aside.exe
  -> steps shown on the island -> the answer spoken -> 30 s of follow-up listening with no wake word.
While Aside works you can say "Hey Jarvis, what are you doing", "stop", "actually ...", or add something for after.
"""
from __future__ import annotations

import json
import os
import random
import re
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
from PySide6.QtCore import QObject, QTimer, QUrl, Signal, Slot
from PySide6.QtGui import QAction, QColor, QDesktopServices, QIcon, QPainter, QPixmap, QRadialGradient
from PySide6.QtNetwork import QLocalServer, QLocalSocket
from PySide6.QtWidgets import QApplication, QMenu, QSystemTrayIcon

from . import aside_cli, audio, config, hotkey, quick, spoken
from .island import BLUE, CYAN, SKY, Island

ACKS = ["One moment, sir.", "Let me look.", "Right, checking now.", "Give me a second.", "Looking into it."]
SUMMONED = ["Sir?", "Yes, sir?"]
SIGN_OFF = ["Very good, sir.", "Anytime.", "Of course."]
RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"

# A follow-up shorter than this is almost always background noise, not a
# request: it is dropped instead of starting a whole agent turn.
MIN_FOLLOWUP_WORDS = 3


def orb_icon() -> QIcon:
    """The tray icon: the shipped .ico when it exists, else the painted orb."""
    ico = Path(config.CONFIG_DIR) / "jarvis.ico"
    if ico.exists():
        return QIcon(str(ico))
    pm = QPixmap(64, 64)
    pm.fill(QColor(0, 0, 0, 0))
    p = QPainter(pm)
    p.setRenderHint(QPainter.RenderHint.Antialiasing)
    g = QRadialGradient(26, 24, 34)
    g.setColorAt(0, SKY)
    g.setColorAt(0.4, CYAN)
    g.setColorAt(0.8, BLUE)
    p.setBrush(g)
    p.setPen(QColor(0, 0, 0, 0))
    p.drawEllipse(6, 6, 52, 52)
    p.end()
    return QIcon(pm)


class Controller(QObject):
    # cross-thread signals (audio thread / worker threads -> Qt main thread)
    sig_wake = Signal()
    sig_level = Signal(float)
    sig_speech_started = Signal()   # he began talking inside the follow-up window
    sig_utterance = Signal(object)
    sig_timeout = Signal()
    sig_text = Signal(str, bool)        # transcript, came from a fresh wake
    sig_session = Signal(str)
    sig_step = Signal(str)
    sig_done = Signal(object)
    sig_ready = Signal(str)             # "" = ready, else an error to show
    sig_fast = Signal(str, str)         # (request, answer) from the optional fast path

    def __init__(self, app: QApplication, log):
        super().__init__()
        self.app, self.log = app, log
        self.s = config.load()
        self.island = Island()
        self.island.clicked.connect(self.poke)
        self.mic = audio.Mic(self.s.get("micDevice"))
        self.endpointer = audio.Endpointer(self.s["silence"], self.s["initialWait"])
        self.wake = None
        self.stt = None
        self.cli = aside_cli.find_cli(self.s["asideCli"])
        self.pool = ThreadPoolExecutor(max_workers=2)
        self.state = "starting"          # starting | idle | listening | transcribing | speaking | followup
        self._spoken_text = ""
        self.from_wake = False
        self.buffer: list[np.ndarray] = []
        self.run: aside_cli.AgentRun | None = None
        self.session: str | None = None
        self.session_at = 0.0
        self.last_step: str | None = None
        self.speaker = None
        self.cancelled: aside_cli.AgentRun | None = None
        self._audio_stop = threading.Event()

        for sig, slot in ((self.sig_wake, self.on_wake), (self.sig_level, self.island.set_level),
                          (self.sig_speech_started, self.on_speech_started),
                          (self.island.closed_by_user, self.on_island_closed),
                          (self.sig_utterance, self.on_utterance), (self.sig_timeout, self.on_timeout),
                          (self.sig_text, self.on_text), (self.sig_session, self.on_session), (self.sig_step, self.on_step),
                          (self.sig_done, self.on_done), (self.sig_ready, self.on_ready), (self.sig_fast, self.on_fast)):
            sig.connect(slot)

        self.tray = QSystemTrayIcon(orb_icon(), self.app)
        self.tray.setToolTip("Jarvis: getting ready")
        self._tip = "Jarvis: getting ready"
        self._menu()
        self.tray.show()

        from .tts import Speaker

        self.speaker = Speaker(self.s["voice"], self.s["rate"], log)
        self.speaker.finished.connect(self.on_spoken)
        self.speaker.progress.connect(self.on_speech_progress)

        hotkey.listen(self.s["hotkey"], lambda: QTimer.singleShot(0, self.poke), log)
        # Heartbeat: one small file, rewritten every second, so a watchdog can
        # tell "working" from "hung on a dead audio device". A stale mtime is
        # the signal to restart, not the process disappearing alone.
        self.heartbeat = config.DATA_DIR / "heartbeat.txt"
        try:
            config.DATA_DIR.mkdir(parents=True, exist_ok=True)
            self.heartbeat.write_text(f"{os.getpid()} {time.time():.0f}", encoding="utf-8")
            log.info(f"heartbeat written to {self.heartbeat}")
        except OSError as e:
            self.heartbeat = None
            log.warning(f"heartbeat disabled: {e}")
        self.heartbeat_timer = QTimer(self)
        self.heartbeat_timer.timeout.connect(self._beat)
        self.heartbeat_timer.start(1000)
        threading.Thread(target=self._load_models, daemon=True).start()

    def set_state(self, state: str, tip: str | None = None) -> None:
        """One place that changes state, so the tray tooltip always tells the truth."""
        self.state = state
        self._tip = tip or {
            "idle": 'Jarvis: say "Hey Jarvis"',
            "listening": "Jarvis: listening",
            "transcribing": "Jarvis: transcribing",
            "working": "Jarvis: working",
            "speaking": "Jarvis: speaking",
            "starting": "Jarvis: getting ready",
            "followup": "Jarvis: listening (follow-up)",
        }.get(state, f"Jarvis: {state}")
        if self.s.get("muted"):
            self._tip = "Jarvis: muted"
        self.tray.setToolTip(self._tip)

    def _beat(self) -> None:
        if getattr(self, "heartbeat", None) is None:
            return
        try:
            self.heartbeat.write_text(f"{os.getpid()} {time.time():.0f} {self.state}", encoding="utf-8")
        except OSError:
            pass

    # ------------------------------------------------------------------ setup

    def _load_models(self) -> None:
        try:
            audio.ensure_wake_models()
            self.wake = audio.WakeWord(self.s["wakeThreshold"])
            from .stt import Transcriber

            self.stt = Transcriber(self.s["whisperModel"])
            self.sig_ready.emit("")
        except Exception as e:
            self.log.exception("model load failed")
            self.sig_ready.emit(f"{e.__class__.__name__}: {e}")

    @Slot(str)
    def on_ready(self, err: str) -> None:
        if err:
            self.tray.setToolTip("Jarvis: could not start (see the log)")
            self.tray.showMessage("Jarvis", f"Could not load speech models: {err[:120]}")
            return
        if not self.cli:
            self.tray.showMessage("Jarvis", "Aside CLI not found. Install it (Aside Settings > Developer), then restart Jarvis.")
        self.set_state("idle")
        self.tray.setToolTip('Jarvis: say "Hey Jarvis"' if not self.s["muted"] else "Jarvis: muted")
        if self.s["muted"]:
            self.island.set_phase("hidden")
        else:
            self.mic.start()
        threading.Thread(target=self._audio_loop, daemon=True).start()
        self.log.info(f"ready; aside cli: {self.cli}")

    def _menu(self) -> None:
        m = QMenu()
        self.act_talk = QAction("Talk now", m, triggered=self.poke)
        self.act_mute = QAction("Mute microphone", m, checkable=True, checked=self.s["muted"], triggered=self.set_muted)
        self.act_voice = QAction("Speak replies", m, checkable=True, checked=self.s["spokenReplies"],
                                 triggered=lambda on: self._set("spokenReplies", on))
        self.act_words = QAction("Show Jarvis's words", m, checkable=True, checked=self.s["showJarvisWords"],
                                 triggered=lambda on: self._set("showJarvisWords", on))
        self.act_login = QAction("Start at login", m, checkable=True, checked=self.login_enabled(), triggered=self.set_login)
        for a in (self.act_talk, self.act_mute, self.act_voice, self.act_words, self.act_login):
            m.addAction(a)
        m.addSeparator()
        m.addAction(QAction("Hide the island", m, triggered=self.on_island_closed))
        m.addAction(QAction("Open settings file", m, triggered=self.open_settings))
        m.addAction(QAction("Open log folder", m, triggered=lambda: QDesktopServices.openUrl(QUrl.fromLocalFile(str(config.LOG_DIR)))))
        m.addSeparator()
        m.addAction(QAction("Quit Jarvis", m, triggered=self.quit))
        self.menu = m
        self.tray.setContextMenu(m)
        # Left-click on the tray icon talks too, so the icon is never just a
        # menu button.
        self.tray.activated.connect(self._tray_click)

    def _tray_click(self, reason) -> None:
        if reason == QSystemTrayIcon.ActivationReason.Trigger:
            self.poke()
# (the tray click is wired to _tray_click in _menu)

    def _set(self, key: str, value) -> None:
        self.s[key] = value
        config.save(self.s)

    def open_settings(self) -> None:
        if not config.SETTINGS_FILE.exists():
            config.save(self.s)
        QDesktopServices.openUrl(QUrl.fromLocalFile(str(config.SETTINGS_FILE)))

    # ------------------------------------------------------------------ login item (HKCU Run, no admin)

    def login_command(self) -> str:
        exe = sys.executable
        if exe.lower().endswith("python.exe"):
            exe = exe[:-10] + "pythonw.exe"   # no console window at login
        return f'"{exe}" -m heyaside'

    def login_enabled(self) -> bool:
        if sys.platform != "win32":
            return False
        import winreg

        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as k:
                winreg.QueryValueEx(k, "HeyAside")
                return True
        except OSError:
            return False

    def set_login(self, on: bool) -> None:
        if sys.platform != "win32":
            return
        import winreg

        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE) as k:
            if on:
                winreg.SetValueEx(k, "HeyAside", 0, winreg.REG_SZ, self.login_command())
            else:
                try:
                    winreg.DeleteValue(k, "HeyAside")
                except OSError:
                    pass

    # ------------------------------------------------------------------ audio thread

    def _audio_loop(self) -> None:
        while not self._audio_stop.is_set():
            try:
                frame = self.mic.frames.get(timeout=0.5)
            except Exception:
                continue
            st = self.state
            if st == "idle" or (st == "working" and self.run and self.run.running):
                if self.wake and self.wake.feed(frame):
                    self.sig_wake.emit()
            elif st in ("listening", "followup"):
                self.buffer.append(frame)
                self.sig_level.emit(audio.level(frame))
                r = self.endpointer.feed(frame)
                if st == "followup" and r == "speaking":
                    # He says something inside the follow-up window: only now
                    # does the island come back, labelled Listening.
                    self.sig_speech_started.emit()
                if r == "done":
                    self.state = "transcribing"
                    self.sig_utterance.emit(np.concatenate(self.buffer))
                elif r == "timeout":
                    self.state = "transcribing"  # parked until the main thread decides
                    self.sig_timeout.emit()
            # speaking / transcribing / starting / muted: frames are dropped (never recorded, never saved)

    # ------------------------------------------------------------------ conversation

    def chime(self) -> None:
        if not self.s["sounds"] or sys.platform != "win32":
            return
        import winsound

        f = r"C:\Windows\Media\Speech On.wav"
        if os.path.exists(f):
            winsound.PlaySound(f, winsound.SND_FILENAME | winsound.SND_ASYNC | winsound.SND_NODEFAULT)

    def listen(self, from_wake: bool, wait: float | None = None) -> None:
        if self.s["muted"]:
            return
        self.buffer = []
        self.from_wake = from_wake
        self.endpointer = audio.Endpointer(self.s["silence"], wait if wait is not None else self.s["initialWait"])
        self.set_state("listening" if from_wake else "followup")
        self.island.set_phase("listening", "", "user")

    @Slot()
    def on_wake(self) -> None:
        if self.state == "working":
            self.speaker.stop()
        # The score is logged for every activation: when one feels random, the
        # log says exactly how confident the wake model was.
        score = getattr(self.wake, "last_score", None)
        self.log.info(f"wake fired (score {score:.2f}, threshold {self.s['wakeThreshold']})" if score is not None else "wake fired")
        self.chime()
        self.listen(from_wake=True)

    @Slot()
    def on_island_closed(self) -> None:
        """Four clicks on the island: put it away and go quiet in the tray."""
        self.speaker.stop()
        if self.run and self.run.running:
            self.cancelled = self.run
            self.run.terminate()
        self.island.set_phase("hidden")
        self.end_conversation()

    @Slot()
    def on_speech_started(self) -> None:
        """He is talking again in the follow-up window: show the island."""
        if self.state == "followup":
            self.island.set_phase("listening")

    @Slot()
    def poke(self) -> None:
        """Hotkey, tray click or island click: start talking, or cut Jarvis off, or finish your sentence now."""
        if self.state == "speaking":
            self.speaker.stop()
        elif self.state in ("listening", "followup") and self.buffer:
            self.set_state("transcribing")
            self.on_utterance(np.concatenate(self.buffer))
        elif self.state in ("idle", "working"):
            self.chime()
            self.listen(from_wake=True)

    @Slot(object)
    def on_utterance(self, pcm: np.ndarray) -> None:
        self.island.set_phase("thinking", "", "user")
        from_wake = self.from_wake

        def work() -> None:
            try:
                text = self.stt(pcm) if self.stt else ""
            except Exception:
                self.log.exception("transcription failed")
                text = ""
            self.sig_text.emit(text, from_wake)

        self.pool.submit(work)

    @Slot()
    def on_timeout(self) -> None:
        if self.from_wake:
            # A bare "Hey Jarvis" and then nothing: answer once, then wait a little longer.
            self.say([random.choice(SUMMONED)], then_listen=12.0)
        else:
            self.end_conversation()

    @Slot(str, bool)
    def on_text(self, text: str, from_wake: bool) -> None:
        cmd = spoken.strip_wake(text)
        self.log.info(f"heard: {len(cmd)} chars (from_wake={from_wake})")
        # Noise that trips the wake model transcribes to a word or two. That is
        # never a request, so it gets the same quiet prompt as a bare wake
        # instead of launching a whole agent turn on background sound.
        if from_wake and len(cmd.split()) < MIN_FOLLOWUP_WORDS:
            self.log.info(f"wake followed by {len(cmd.split())} word(s); asking once, not acting")
            self.say([random.choice(SUMMONED)], then_listen=12.0)
            return
        if from_wake and not cmd:
            self.say([random.choice(SUMMONED)], then_listen=12.0)
            return
        if not from_wake and len(cmd.split()) < MIN_FOLLOWUP_WORDS:
            # Background noise inside the follow-up window, not a request.
            self.log.info(f"follow-up too short to be a request ({len(cmd.split())} words); ignoring")
            self.end_conversation()
            return
        if not cmd:
            self.end_conversation()
            return
        self.island.set_question(cmd)
        busy = bool(self.run and self.run.running)
        if spoken.is_dismissal(cmd) and not busy:
            self.say([random.choice(SIGN_OFF)], then_end=True)
            return
        kind = spoken.intent(cmd, busy)
        if kind == "stop":
            self.cancelled = self.run
            self.run.terminate()
            if self.session:
                self.pool.submit(aside_cli.control, self.cli, ["session", "stop", self.session])
            self.say(["Stopped, sir."], then_end=True)
            return
        if kind == "status":
            self.say([f"I'm {self.last_step[0].lower() + self.last_step[1:]}." if self.last_step else "Still working on it."], then_back_to_work=True)
            return
        if kind in ("steer", "queue") and self.session:
            self.pool.submit(aside_cli.control, self.cli, ["session", "steer" if kind == "steer" else "queue", self.session, cmd])
            self.say(["Understood." if kind == "steer" else "I'll do that next."], then_back_to_work=True)
            return
        self.start_task(cmd)

    def start_task(self, cmd: str) -> None:
        if not self.cli:
            self.island.set_phase("error", "Aside CLI not found", "hint")
            self.say(["I can't reach Aside, sir. The command line tool isn't installed."], then_end=True)
            return
        # 1. On this PC, instantly: math, units, dates, world clocks. No network,
        #    no model, nothing to time out.
        try:
            local = quick.answer(cmd)
        except Exception:
            self.log.exception("quick answer failed")
            local = None
        if local:
            self.log.info(f"quick (local): {cmd[:60]}")
            self.deliver(local)
            return
        if self.s.get("jev") and self.try_fast(cmd):
            return
        fresh = time.monotonic() - self.session_at > self.s["newChatAfterMinutes"] * 60
        prompt = cmd + spoken.VOICE_SUFFIX
        if self.session and not fresh:
            args = ["session", "resume", self.session, prompt]
        else:
            self.session = None
            args = []
            if self.s["agentModel"]:
                args += ["--model", self.s["agentModel"]]
            args += ["--permission", self.s["permission"], prompt]
        self.last_step = None
        self.set_state("working")
        self.island.set_phase("thinking", "", "step")
        if self.s["spokenReplies"]:
            self.speaker.say([random.choice(ACKS)])
        self.run = aside_cli.AgentRun(self.cli, args, on_session=self.sig_session.emit, on_step=self.sig_step.emit,
                                      on_done=self.sig_done.emit, log=self.log.info)
        try:
            self.run.start()
        except OSError as e:
            self.log.info(f"could not start aside: {e}")
            self.on_done(aside_cli.Result(error=str(e), exit_code=-1))

    def try_fast(self, cmd: str) -> bool:
        """Outside-this-PC knowledge: Aside Phone's `jev quick` answers general questions in seconds.

        The timeout is deliberately short (6 s). A refusal must never cost a
        12-second wait and then a full session anyway; falling back fast is
        what keeps him talking to Jarvis instead of watching a spinner.
        """
        jev = self.s["jev"]
        node = "node"

        def work() -> None:
            ans = None
            try:
                p = subprocess.run([node, jev, "quick", cmd], capture_output=True, text=True, timeout=6,
                                   creationflags=aside_cli.NO_WINDOW)
                out = p.stdout.strip()
                if p.returncode == 0 and out:
                    ans = json.loads(out.splitlines()[-1]).get("answer")
                if not ans:
                    self.log.warning(f"jev fast path empty: rc={p.returncode} out={out[-160:]!r} err={p.stderr[-160:]!r}")
            except subprocess.TimeoutExpired:
                self.log.warning(f"jev fast path timed out after 6s for {cmd[:50]!r}; falling back to a full session")
            except Exception as e:
                self.log.warning(f"jev fast path failed: {e!r}")
            self.sig_fast.emit(cmd, ans or "")

        self.set_state("working")
        self.island.set_phase("thinking", "", "step")
        self.pool.submit(work)
        return True

    @Slot(str, str)
    def on_fast(self, cmd: str, answer: str) -> None:
        if answer:
            self.deliver(answer)
        else:
            saved, self.s["jev"] = self.s["jev"], ""
            try:
                self.start_task(cmd)
            finally:
                self.s["jev"] = saved

    @Slot(str)
    def on_session(self, sid: str) -> None:
        self.session = sid
        self.session_at = time.monotonic()

    @Slot(str)
    def on_step(self, step: str) -> None:
        self.last_step = step
        if self.state == "working":
            self.island.set_phase("thinking", step, "step")

    @Slot(object)
    def on_done(self, r: aside_cli.Result) -> None:
        self.session_at = time.monotonic()
        if self.cancelled is not None and self.cancelled is self.run:
            self.cancelled = None
            return  # you stopped it; "Stopped, sir." was already said
        if r.error and not r.answer:
            self.log.info(f"aside error: {r.error}")
            self.island.set_phase("error", "Aside couldn't finish that", "hint")
            self.say(["Sorry, sir, that didn't go through. It's in Aside if you want to look."], then_end=True)
            return
        self.deliver(r.answer or "Done.")

    @Slot(int, int)
    def on_speech_progress(self, spoken_chars: int, total_chars: int) -> None:
        """The voice has said this much: the island reveals exactly that much."""
        if self.island.phase == "speaking":
            self.island.set_answer(self._spoken_text, spoken_chars, total_chars)

    def deliver(self, answer: str) -> None:
        text = spoken.spoken_from(answer)
        if not self.s["spokenReplies"]:
            self.island.set_phase("done", text, "jarvis")
            QTimer.singleShot(6000, self.end_conversation)
            return
        self._spoken_text = text
        self.island.set_phase("speaking")
        self.island.set_answer(text, 0, len(text))
        self.say(spoken.speech_chunks(text), then_listen=float(self.s["followUpSeconds"]))

    # ------------------------------------------------------------------ speaking

    def say(self, chunks: list[str], then_listen: float | None = None, then_end: bool = False, then_back_to_work: bool = False) -> None:
        self._after = ("listen", then_listen) if then_listen else ("end", None) if then_end else ("work", None) if then_back_to_work else ("listen", float(self.s["followUpSeconds"]))
        self.set_state("speaking")
        if not self.s["spokenReplies"]:
            self.on_spoken()
            return
        if self.island.phase != "speaking":
            self.island.set_phase("speaking", None, None)
        self.speaker.say(chunks)

    @Slot()
    def on_spoken(self) -> None:
        if self.state != "speaking":
            return  # the acknowledgement finished while Aside works, or speech was cut off mid-listen
        what, wait = getattr(self, "_after", ("end", None))
        if self.run and self.run.running and what != "end":
            self.set_state("working")
            self.island.set_phase("thinking", self.last_step or "", "step")
            return
        if what == "listen":
            self.listen(from_wake=False, wait=wait)
            # The follow-up window stays open, but the island leaves the
            # screen: it appears again the moment he actually says something.
            self.island.set_phase("hidden")
        elif what == "work":
            self.set_state("working")
            self.island.set_phase("thinking", self.last_step or "", "step")
        else:
            self.end_conversation()

    def end_conversation(self) -> None:
        self.set_state("idle")
        self.island.set_phase("hidden")
        if self.wake:
            self.wake.reset()

    # ------------------------------------------------------------------ mute / quit

    def set_muted(self, on: bool) -> None:
        self._set("muted", on)
        if on:
            self.mic.stop()          # really releases the microphone
            self.speaker.stop()
            self.island.set_phase("muted", "Muted", "hint")
            QTimer.singleShot(1500, lambda: self.island.set_phase("hidden") if self.s["muted"] else None)
            self.tray.setToolTip("Jarvis: muted")
        else:
            self.mic.start()
            self.set_state("idle")
            self.tray.setToolTip('Jarvis: say "Hey Jarvis"')
        self.act_mute.setChecked(on)

    def quit(self) -> None:
        self.log.info("stopping (quit from the tray)")
        self._audio_stop.set()
        self.mic.stop()
        if self.run:
            self.run.terminate()
        self.app.quit()


def single_instance(app: QApplication) -> QLocalServer | None:
    name = f"heyaside-{os.environ.get('USERNAME') or os.environ.get('USER') or 'user'}"
    probe = QLocalSocket()
    probe.connectToServer(name)
    if probe.waitForConnected(300):
        probe.write(b"poke")
        probe.flush()
        probe.waitForBytesWritten(300)
        return None
    QLocalServer.removeServer(name)
    server = QLocalServer(app)
    server.listen(name)
    return server


def main(argv: list[str]) -> int:
    log = config.setup_logging(echo="--verbose" in argv)
    # A crash that no one can see is a crash that keeps happening: write the
    # native traceback beside the log, and record the goodbye lines.
    import faulthandler

    try:
        config.DATA_DIR.mkdir(parents=True, exist_ok=True)
        faulthandler.enable(file=(config.DATA_DIR / "crash.log").open("a", encoding="utf-8"))
    except OSError:
        pass

    def _boom(exc_type, exc, tb) -> None:
        log.critical("unhandled exception", exc_info=(exc_type, exc, tb))

    sys.excepthook = _boom
    log.info(f"Jarvis started (pid {os.getpid()})")
    app = QApplication(argv)
    app.setQuitOnLastWindowClosed(False)
    app.setApplicationName("Jarvis")
    server = single_instance(app)
    if server is None:
        return 0  # already running; the other copy starts listening
    ctl = Controller(app, log)
    server.newConnection.connect(lambda: (server.nextPendingConnection(), ctl.poke()))
    if "--enable-login" in argv:
        ctl.set_login(True)
    log.info("Jarvis started")
    return app.exec()

