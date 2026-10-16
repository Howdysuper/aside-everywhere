"""Microphone, wake word, and end-of-speech detection. All on this PC; audio is never saved or uploaded."""
from __future__ import annotations

import queue
import threading
import time

import numpy as np

RATE = 16_000
FRAME = 1280  # 80 ms: the frame size openWakeWord expects


class Endpointer:
    """Decides when you have finished a sentence: speech, then `silence` seconds of quiet.

    The noise floor adapts while nobody talks, so a fan or a loud room does not count as speech.
    """

    def __init__(self, silence: float = 1.2, initial_wait: float = 8.0, max_len: float = 30.0):
        self.silence, self.initial_wait, self.max_len = silence, initial_wait, max_len
        self.reset()

    def reset(self) -> None:
        self.floor = 0.004
        self.heard = False
        self.quiet = 0.0
        self.elapsed = 0.0

    def feed(self, frame: np.ndarray) -> str:
        """Returns 'wait', 'speaking', 'done' (sentence finished), or 'timeout' (nothing said)."""
        dt = len(frame) / RATE
        self.elapsed += dt
        rms = float(np.sqrt(np.mean(np.square(frame.astype(np.float32))))) if len(frame) else 0.0
        loud = rms > max(self.floor * 3.0, 0.012)
        if not loud:
            self.floor = 0.95 * self.floor + 0.05 * rms
        if loud:
            self.heard = True
            self.quiet = 0.0
        elif self.heard:
            self.quiet += dt
        if self.heard and self.quiet >= self.silence:
            return "done"
        if self.elapsed >= self.max_len:
            return "done" if self.heard else "timeout"
        if not self.heard and self.elapsed >= self.initial_wait:
            return "timeout"
        return "speaking" if self.heard else "wait"


def level(frame: np.ndarray) -> float:
    """0..1 loudness for the island's bars."""
    rms = float(np.sqrt(np.mean(np.square(frame.astype(np.float32))))) if len(frame) else 0.0
    return min(1.0, rms * 12)


class WakeWord:
    """openWakeWord's pretrained "hey jarvis" model (ONNX, runs on the CPU in a few ms per frame)."""

    def __init__(self, threshold: float = 0.5):
        from openwakeword.model import Model  # imported late: heavy

        self.threshold = threshold
        self.model = Model(wakeword_models=["hey_jarvis"], inference_framework="onnx")
        self.cooldown_until = 0.0
        self.last_score = 0.0

    def feed(self, frame: np.ndarray) -> bool:
        pcm = (np.clip(frame, -1, 1) * 32767).astype(np.int16)
        scores = self.model.predict(pcm)
        best = max(scores.values()) if scores else 0.0
        self.last_score = best
        hit = best >= self.threshold
        if hit and time.monotonic() >= self.cooldown_until:
            self.cooldown_until = time.monotonic() + 2.0
            self.model.reset()
            return True
        return False

    def reset(self) -> None:
        self.model.reset()


def ensure_wake_models() -> None:
    """Downloads the small ONNX feature + "hey jarvis" models on first run (openWakeWord's own release assets)."""
    from openwakeword import utils

    utils.download_models(model_names=["hey_jarvis"])


class Mic:
    """A 16 kHz mono input stream. `stop()` really releases the microphone (Windows shows the mic icon only while on)."""

    def __init__(self, device=None):
        self.device = device
        self.frames: "queue.Queue[np.ndarray]" = queue.Queue(maxsize=200)
        self._stream = None
        self._lock = threading.Lock()

    def start(self) -> None:
        import sounddevice as sd

        with self._lock:
            if self._stream:
                return
            self._stream = sd.InputStream(samplerate=RATE, channels=1, dtype="float32", blocksize=FRAME,
                                          device=self.device, callback=self._cb)
            self._stream.start()

    def _cb(self, indata, frames, t, status) -> None:
        try:
            self.frames.put_nowait(indata[:, 0].copy())
        except queue.Full:
            pass  # the consumer is behind; dropping a frame beats growing without bound

    def stop(self) -> None:
        with self._lock:
            if self._stream:
                self._stream.stop()
                self._stream.close()
                self._stream = None
        while not self.frames.empty():
            try:
                self.frames.get_nowait()
            except queue.Empty:
                break

    @property
    def on(self) -> bool:
        return self._stream is not None
