"""The island's contract: pure layout maths, and the widget's state machine.

QT_QPA_PLATFORM=offscreen keeps this headless.
"""
from __future__ import annotations

import os

import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
qt = pytest.importorskip("PySide6.QtWidgets")
gui = pytest.importorskip("PySide6.QtGui")


# --------------------------------------------------------------------------- pure maths

class FakeMetrics:
    """A stand-in for QFontMetricsF with a fixed per-character width."""

    def __init__(self, width: float = 7.0):
        self.width = width

    def horizontalAdvance(self, text: str) -> float:  # noqa: N802 - Qt's name
        return len(text) * self.width


def test_wrap_lines_is_complete_and_wraps_at_the_width():
    from heyaside.island import wrap_lines

    text = " ".join(f"word{i}" for i in range(18))
    lines = wrap_lines(text, FakeMetrics(6.0), 60)
    assert all(line for line in lines)
    assert " ".join(lines) == text          # nothing is dropped, ever
    assert len(lines) > 1                   # and it wraps within a word of the width
    assert all(len(line) * 6.0 <= 60 + 6 for line in lines)


def test_wrap_lines_of_nothing_is_no_rows():
    from heyaside.island import wrap_lines

    assert wrap_lines("", FakeMetrics(), 300) == []
    assert wrap_lines("   ", FakeMetrics(), 300) == []


def test_wrap_lines_keeps_paragraphs():
    from heyaside.island import wrap_lines

    assert wrap_lines("first\n\nsecond", FakeMetrics(7.0), 400) == ["first", "", "second"]


def test_reveal_words_is_always_a_prefix_and_monotonic():
    from heyaside.island import reveal_words

    text = "The quick brown fox jumps over the lazy dog"
    prev = ""
    for n in range(0, len(text) + 1):
        shown = reveal_words(text, n)
        assert text.startswith(shown)          # a live caption never leads the voice
        assert len(shown) >= len(prev)          # and it only ever grows
        prev = shown
    assert reveal_words(text, 0) == ""
    assert reveal_words(text, 10**6) == text


def test_capsule_height_grows_with_lines_and_never_collapses():
    from heyaside.island import capsule_geometry

    one = capsule_geometry(1, 19.0, 18, 0)
    two = capsule_geometry(2, 19.0, 18, 0)
    with_label = capsule_geometry(2, 19.0, 18, 25)
    assert 0 < one < two < with_label


# --------------------------------------------------------------------------- the widget

@pytest.fixture()
def island():
    app = qt.QApplication.instance() or qt.QApplication([])
    yield app if False else _make(app)


def _make(app):
    from heyaside.island import Island

    return Island()


def _settle(island, frames: int = 90) -> None:
    for _ in range(frames):
        island._tick()


def test_island_opens_grows_and_hides():
    isl = _make(qt.QApplication.instance() or qt.QApplication([]))
    isl.set_question("what is on my calendar tomorrow")
    isl.set_phase("listening")
    assert isl.isVisible()
    assert isl.w.target > 200                     # it opens wide enough to read

    long_answer = " ".join(f"word{i}" for i in range(60))
    isl.set_answer(long_answer, len(long_answer), len(long_answer))
    assert isl.h.target > isl.h.value + 20        # it grows for the answer

    isl.set_phase("hidden")
    assert isl.alpha.target == 0
    _settle(isl)
    assert isl.alpha.value < 0.05


def test_streaming_answer_reveals_only_what_was_spoken():
    isl = _make(qt.QApplication.instance() or qt.QApplication([]))
    isl.set_question("what is seventeen times twenty three")
    isl.set_phase("speaking")
    answer = "Seventeen times twenty three is 391, sir."
    isl.set_answer(answer, 0, len(answer))
    early = len(isl._answer_lines(isl.w.value or 400))
    assert early == 0                            # nothing before the voice starts
    isl.set_answer(answer, len(answer) // 2, len(answer))
    mid_rows = isl._rows(560)
    assert any(text for text, kind in mid_rows if kind == "jarvis")
    isl.set_answer(answer, len(answer), len(answer))
    full_rows = isl._rows(560)
    assert any(answer.split(" sir")[0].split()[-1] in text for text, kind in full_rows if kind == "jarvis")
    # The question stays under the answer, never dropped.
    assert any("seventeen" in text.lower() for text, kind in full_rows if kind == "user")


def test_long_answers_scroll_instead_of_eliding():
    isl = _make(qt.QApplication.instance() or qt.QApplication([]))
    isl.set_question("tell me everything")
    isl.set_phase("done")
    answer = " ".join(f"sentence{i} about the topic at hand." for i in range(40))
    isl.set_answer(answer, len(answer), len(answer))
    rows = isl._rows(560)
    assert len(rows) > 6                          # every line is kept
    assert isl.content_h > isl.h.target           # the capsule caps, so it scrolls
    assert isl.scroll_target > 0
    isl.wheel_scroll_down()
    assert isl.scroll >= 0


def test_phase_labels_and_glow_states():
    isl = _make(qt.QApplication.instance() or qt.QApplication([]))
    from heyaside.island import STATUS_LABEL

    assert STATUS_LABEL["listening"] == "Listening"
    assert STATUS_LABEL["thinking"] == "Thinking"
    assert STATUS_LABEL["speaking"] == "Answering"
    for phase in ("listening", "thinking", "speaking", "done"):
        isl.set_phase(phase)
        assert isl.alpha.target == 1
    isl.set_phase("error")
    assert isl.phase == "error"
