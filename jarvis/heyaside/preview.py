"""Render the island's states to PNGs so the design can be reviewed without speaking.

    QT_QPA_PLATFORM=offscreen python heyaside/preview.py <outdir>

A fixed 60 fps clock stands in for the display's, so the springs settle the
same way they do on screen. A crash here is a crash in the tray app.
"""
from __future__ import annotations

import os
import sys
import types
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# A deterministic clock: 60 fps, starting at 1000 s (so t0 is in the past).
_clock = [1000.0]
import heyaside.island as _island_mod  # noqa: E402

_island_mod.time = types.SimpleNamespace(monotonic=lambda: _clock[0])

from PySide6.QtGui import QImage                      # noqa: E402
from PySide6.QtWidgets import QApplication            # noqa: E402

from heyaside.island import Island                    # noqa: E402
from heyaside import spoken                           # noqa: E402

FRAME = 1.0 / 60.0


def settle(island: Island, frames: int = 90, level: float = 0.0) -> None:
    for _ in range(frames):
        _clock[0] += FRAME
        if level:
            island.set_level(level)
        island._tick()
    island.repaint()


def shot(island: Island, path: Path) -> None:
    img = QImage(island.size(), QImage.Format.Format_ARGB32)
    img.fill(0)
    island.render(img)
    img.save(str(path))


def main() -> int:
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "preview")
    out.mkdir(parents=True, exist_ok=True)
    app = QApplication(sys.argv)
    isl = Island()
    isl.resize(620, 300)

    question = "Hey Jarvis, what is seventeen times twenty three"
    answer = spoken.spoken_from(
        "Seventeen times twenty three is 391, sir. I worked it out on this PC without a network call, so it came back before you finished asking.\n\n"
        "--- The rest of the detail stays here: arithmetic, units, dates and world clocks all answer locally, and only general-knowledge questions "
        "go to the decision model. That is what keeps the answers instant."
    )

    states = [
        ("01-listening", "listening", question, None, 0.65),
        ("02-thinking", "thinking", question, None, 0.0),
        ("03-speaking-early", "speaking", question, answer, int(len(answer) * 0.12)),
        ("04-speaking-mid", "speaking", question, answer, int(len(answer) * 0.5)),
        ("05-speaking-full", "speaking", question, answer, len(answer)),
        ("06-done-long", "done", question, answer, len(answer)),
        ("07-error", "error", question, None, 0.0),
    ]
    for name, phase, q, a, shown in states:
        isl.set_phase("hidden")
        settle(isl, 20)
        if phase == "error":
            isl.set_step("Aside couldn't finish that")
        isl.set_phase(phase)
        if q:
            isl.set_question(q)
        if a:
            isl.set_answer(a, shown, len(a))
        level = 0.65 if phase in ("listening", "speaking") else 0.0
        settle(isl, 100, level)
        shot(isl, out / f"{name}.png")
        print(
            f"{name}: w={isl.w.value:.0f} h={isl.h.value:.0f} rows={len(isl._rows(isl.w.value))} "
            f"content_h={isl.content_h:.0f} scroll_target={isl.scroll_target:.0f}"
        )
    print("previews written to", out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
