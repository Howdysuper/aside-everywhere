"""Speech to text on this PC with faster-whisper. The model downloads once (from Hugging Face) on first use."""
from __future__ import annotations

import numpy as np

from .config import MODEL_DIR


class Transcriber:
    def __init__(self, model: str = "base.en"):
        from faster_whisper import WhisperModel  # heavy import

        MODEL_DIR.mkdir(parents=True, exist_ok=True)
        self.model = WhisperModel(model, device="cpu", compute_type="int8", download_root=str(MODEL_DIR))

    def __call__(self, audio: np.ndarray) -> str:
        if len(audio) < 1600:
            return ""
        segments, _ = self.model.transcribe(
            audio.astype(np.float32), language="en", beam_size=1, vad_filter=True,
            initial_prompt="Hey Jarvis. Aside.",
        )
        return " ".join(s.text.strip() for s in segments).strip()
