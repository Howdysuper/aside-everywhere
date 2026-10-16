"""The Jarvis island: the glowing capsule at the top centre of the screen.

The Windows stand-in for Siri's glow and the Dynamic Island, built on the
rules in the apple-design skill (response, interruptibility, springs,
materials, restraint):

  - The glow is one physical thing: a soft halo behind a dark translucent
    capsule, breathing with the microphone while you talk, pulsing while
    Jarvis thinks, and riding the waveform while he answers.
  - Motion is a spring on every axis (width a little bouncy, height
    calmer, alpha snappy), always animating from the value on screen right
    now, so grabbing it mid-flight never jumps.
  - The capsule is a material: dark, translucent, a bright top edge for
    light catching it, a hairline border, and a soft shadow beneath.
  - Words stream in as they are spoken: the island knows how many
    characters the voice has said and reveals exactly that much, so the
    text is never ahead of the sound and never a dot-dot-dot summary.
  - The capsule grows to fit every word, up to a share of the screen, and
    then scrolls with the newest line in view. Nothing is elided.

Parts: orb (listening pulse / thinking shimmer / waveform bars), status
label, your question, and Jarvis's answer.
"""
from __future__ import annotations

import math
import time

from PySide6.QtCore import QPointF, QRectF, Qt, QTimer, Signal
from PySide6.QtGui import QColor, QFont, QFontMetricsF, QGuiApplication, QLinearGradient, QPainter, QPainterPath, QPen, QRadialGradient
from PySide6.QtWidgets import QWidget

BLUE = QColor(11, 134, 255)       # arc-reactor blue
CYAN = QColor(92, 214, 255)       # ice cyan
SKY = QColor(158, 219, 255)       # pale sky highlight
VIOLET = QColor(126, 108, 255)    # the second glow colour, like Siri's edge
RED = QColor(237, 69, 74)
DIM = QColor(255, 255, 255, 150)
FAINT = QColor(255, 255, 255, 110)

PHASES = ("hidden", "listening", "thinking", "speaking", "done", "error", "muted")

# Typography: the system font first. Small text, so tracking stays near zero
# with a hair of air on the status labels only.
FONT_STACK = ("Segoe UI Variable Text", "Segoe UI")
STATUS_LABEL = {"listening": "Listening", "thinking": "Thinking", "speaking": "Answering"}


class Spring:
    """One spring axis. `bounce` 0..0.3 adds overshoot when growing."""

    def __init__(self, value: float):
        self.value = self.target = value
        self.v = 0.0

    def step(self, dt: float, duration: float, bounce: float) -> None:
        w = 2 * math.pi / max(duration, 0.05)
        zeta = max(0.2, 1.0 - bounce)
        a = -w * w * (self.value - self.target) - 2 * zeta * w * self.v
        self.v += a * dt
        self.value += self.v * dt

    @property
    def settled(self) -> bool:
        return abs(self.value - self.target) < 0.3 and abs(self.v) < 0.3


# ---------------------------------------------------------------------------
# Pure layout maths (unit-tested without a screen)

def wrap_lines(text: str, metrics, width: float, max_lines: int = 0) -> list[str]:
    """Word-wrap to a pixel width. Never elides: the list is complete.

    Empty or whitespace-only text has no lines at all, so "nothing said
    yet" paints nothing rather than a blank row. `max_lines` 0 = no cap.
    """
    if not text or not text.strip():
        return []
    out: list[str] = []
    for para in text.split("\n"):
        words, cur = para.split(), ""
        if not words:
            out.append("")
            continue
        for w in words:
            trial = (cur + " " + w).strip()
            if metrics.horizontalAdvance(trial) > width and cur:
                out.append(cur)
                cur = w
            else:
                cur = trial
        if cur:
            out.append(cur)
    return out[:max_lines] if max_lines else out


def reveal_words(text: str, chars: int) -> str:
    """The part of the answer the voice has said. Partial words are kept:
    a live caption shows the word as it is being spoken, exactly like the
    voice does, so the text and the sound never drift apart."""
    if chars <= 0:
        return ""
    return text if chars >= len(text) else text[:chars]


def capsule_geometry(lines: int, line_h: float, pad: float, status_h: float) -> float:
    """Height of the capsule for a number of text lines."""
    body = pad * 2 + max(1, lines) * line_h + max(0, lines - 1) * 3
    return body + (status_h if status_h else 0)


class Island(QWidget):
    clicked = Signal()
    closed_by_user = Signal()   # four quick clicks: back to the background

    PAD = 18
    ORB = 26
    GAP = 14
    LINE_H = 19.0
    MIN_W = 250
    MAX_W = 560
    MAX_H_FRACTION = 0.42          # of the screen's available height

    def __init__(self):
        super().__init__(None, Qt.WindowType.FramelessWindowHint | Qt.WindowType.WindowStaysOnTopHint
                         | Qt.WindowType.Tool | Qt.WindowType.WindowDoesNotAcceptFocus)
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.setAttribute(Qt.WidgetAttribute.WA_ShowWithoutActivating)
        self.setWindowTitle("Jarvis")
        self.phase = "hidden"
        self.question = ""
        self.answer = ""
        self.answer_shown = 0
        self.answer_total = 0
        self.step = ""
        self.level = 0.0
        self.levels = [0.0] * 6
        self.scroll = 0.0
        self.scroll_target = 0.0
        self.content_h = 0.0
        self._clicks: list[float] = []
        self.w = Spring(0.0)
        self.h = Spring(0.0)
        self.alpha = Spring(0.0)
        self.pulse = 0.0
        self.t0 = time.monotonic()
        self.last = self.t0
        self.font_user = QFont(FONT_STACK[0], 9)
        self.font_user.setPointSizeF(11.5)
        self.font_answer = QFont(FONT_STACK[0], 9)
        self.font_answer.setPointSizeF(12.5)
        self.font_answer.setWeight(QFont.Weight.DemiBold)
        self.font_status = QFont(FONT_STACK[0], 8)
        self.font_status.setPointSizeF(9.5)
        self.font_status.setLetterSpacing(QFont.SpacingType.PercentageSpacing, 108)  # small caps labels want air
        self.resize(520, 180)
        self._place()
        self.timer = QTimer(self)
        self.timer.setInterval(16)
        self.timer.timeout.connect(self._tick)

    # ------------------------------------------------------------------ public

    def set_phase(self, phase: str, text: str | None = None, kind: str | None = None) -> None:
        self.phase = phase
        if text is not None and kind is not None:
            if kind == "user":
                self.question, self.answer, self.answer_shown = text, "", 0
            elif kind == "jarvis":
                # The answer lands under the question; the question stays put.
                self.answer, self.answer_shown, self.answer_total = text, len(text), len(text)
            elif kind in ("step", "hint"):
                self.step = text
        self._retarget()

    def set_question(self, text: str) -> None:
        self.question = text
        self.answer, self.answer_shown, self.answer_total = "", 0, 0
        self.scroll = self.scroll_target = 0.0
        self._retarget()

    def set_answer(self, text: str, spoken: int = 0, total: int = 0) -> None:
        """The answer, and how much of it has been spoken out loud."""
        self.answer = text
        self.answer_total = total or len(text)
        self.answer_shown = max(0, min(self.answer_total, spoken))
        self._retarget()

    def set_level(self, v: float) -> None:
        self.level = max(0.0, min(1.0, v))

    def set_step(self, text: str) -> None:
        self.step = text
        self._retarget()

    def clear_answer(self) -> None:
        self.answer, self.answer_shown, self.answer_total = "", 0, 0
        self.scroll = self.scroll_target = 0.0
        self._retarget()

    # ------------------------------------------------------------------ layout

    def _place(self) -> None:
        screen = QGuiApplication.primaryScreen().availableGeometry()
        self.move(screen.x() + (screen.width() - self.width()) // 2, screen.y() + 8)

    def _text_width(self, w: float) -> float:
        return max(140.0, w - 2 * self.PAD - self.ORB - self.GAP - 8)

    def _answer_lines(self, w: float) -> list[str]:
        if not self.answer:
            return []
        fm = QFontMetricsF(self.font_answer)
        return wrap_lines(reveal_words(self.answer, self.answer_shown), fm, self._text_width(w))

    def _question_lines(self, w: float) -> list[str]:
        if not self.question:
            return []
        fm = QFontMetricsF(self.font_user)
        return wrap_lines(self.question, fm, self._text_width(w))

    def _rows(self, w: float) -> list[tuple[str, str]]:
        rows: list[tuple[str, str]] = [(l, "user") for l in self._question_lines(w)]
        if self.step:
            rows.append((self.step, "step"))
        rows.extend((l, "jarvis") for l in self._answer_lines(w))
        return rows

    def _retarget(self) -> None:
        if self.phase == "hidden":
            self.w.target, self.h.target, self.alpha.target = 140, 0, 0
            return
        self.alpha.target = 1
        rows = self._rows(self.MAX_W)
        longest = 0.0
        for text, kind in rows:
            fm = QFontMetricsF(self.font_answer if kind == "jarvis" else self.font_user)
            longest = max(longest, fm.horizontalAdvance(text))
        label_w = QFontMetricsF(self.font_status).horizontalAdvance(STATUS_LABEL.get(self.phase, ""))
        self.w.target = max(self.MIN_W, min(self.MAX_W, longest + label_w + 2 * self.PAD + self.ORB + self.GAP + 56))
        screen_h = QGuiApplication.primaryScreen().availableGeometry().height()
        max_h = max(170.0, screen_h * self.MAX_H_FRACTION)
        status_h = self.LINE_H + 6 if STATUS_LABEL.get(self.phase) else 0
        want = capsule_geometry(len(rows), self.LINE_H, self.PAD, status_h)
        self.content_h = want
        self.h.target = min(max_h, want)
        self.scroll_target = max(0.0, want - self.h.target)
        if self.scroll > self.scroll_target:
            self.scroll = self.scroll_target
        if not self.isVisible():
            self.w.value, self.h.value = 140, 20
            self._place()
            self.show()
            self.timer.start()

    # ------------------------------------------------------------------ animation

    def _tick(self) -> None:
        now = time.monotonic()
        dt = min(0.05, now - self.last)
        self.last = now
        self.pulse = now - self.t0
        grow_w = self.w.target > self.w.value
        grow_h = self.h.target > self.h.value
        self.w.step(dt, 0.44 if grow_w else 0.30, 0.25 if grow_w else 0.0)
        self.h.step(dt, 0.38 if grow_h else 0.26, 0.22 if grow_h else 0.0)
        self.alpha.step(dt, 0.22, 0.0)
        if self.scroll < self.scroll_target:
            self.scroll = min(self.scroll_target, self.scroll + dt * 240.0)
        target = self.level if self.phase == "listening" else 0.0
        if self.phase == "speaking":
            target = 0.35 + 0.3 * abs(math.sin(now * 7.3)) * abs(math.sin(now * 3.1))
        if self.phase == "thinking":
            # A breather that keeps pace with the ring: visible, not frantic.
            target = 0.32 + 0.36 * abs(math.sin(now * 4.6))
        self.levels = self.levels[1:] + [0.7 * self.levels[-1] + 0.3 * target]
        if self.phase == "hidden" and self.alpha.value < 0.02 and self.alpha.settled:
            if self.isVisible():
                self.hide()
            return
        self.update()

    def wheelEvent(self, event) -> None:
        notches = event.angleDelta().y() / 120
        if notches:
            self.scroll = max(0.0, min(self.scroll_target, self.scroll - notches * 34.0))
            self.update()

    def wheel_scroll_down(self) -> None:
        """Scroll a long answer towards the newest words (wheel or key)."""
        self.scroll = max(0.0, min(self.scroll_target, self.scroll + 34.0))
        self.update()

    # ------------------------------------------------------------------ painting

    def paintEvent(self, _event) -> None:
        w, h = max(0.0, self.w.value), max(0.0, self.h.value)
        if w < 4 or h < 4:
            return
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        p.setOpacity(max(0.0, min(1.0, self.alpha.value)))
        x = (self.width() - w) / 2
        body = QRectF(x, 0, w, h)
        r = min(h / 2, 26)
        path = QPainterPath()
        path.addRoundedRect(body, r, r)

        self._glow(p, body)
        self._shadow(p, body, r)
        grad = QRadialGradient(QPointF(body.center().x(), body.top() + h * 0.15), h * 1.2)
        grad.setColorAt(0.0, QColor(28, 28, 36, 242))
        grad.setColorAt(1.0, QColor(8, 8, 12, 246))
        p.fillPath(path, grad)
        p.setPen(QPen(QColor(255, 255, 255, 26), 1))
        p.drawRoundedRect(body.adjusted(0.5, 0.5, -0.5, -0.5), r, r)
        p.setPen(QPen(QColor(255, 255, 255, 60), 1))
        p.drawLine(QPointF(x + r, body.top() + 1), QPointF(x + w - r, body.top() + 1))

        cy = min(h, 44) / 2 + 4
        self._orb(p, QPointF(x + self.PAD + self.ORB / 2, cy), self.ORB / 2)
        if self.phase == "speaking":
            self._bars(p, x + w - self.PAD - 52, cy)

        p.setClipPath(path)
        p.setClipRect(QRectF(x + self.PAD, 0, w - 2 * self.PAD, h), Qt.ClipOperation.IntersectClip)
        tx = x + self.PAD + self.ORB + self.GAP
        ty = self.PAD + 4
        label = STATUS_LABEL.get(self.phase)
        if label:
            p.setFont(self.font_status)
            p.setPen(FAINT)
            p.drawText(QPointF(tx, ty), label.upper())
            ty += self.LINE_H + 6
        rows = self._rows(w)
        y = ty - self.scroll
        fm_a = QFontMetricsF(self.font_answer)
        for text, kind in rows:
            if y + self.LINE_H < 0:
                y += self.LINE_H + 3
                continue
            if y > h:
                break
            font = self.font_answer if kind == "jarvis" else self.font_user
            p.setFont(font)
            if kind == "jarvis":
                p.setPen(QColor(255, 255, 255, 244))
            elif kind == "user":
                p.setPen(DIM)
            else:
                p.setPen(FAINT)
            p.drawText(QPointF(tx, y + fm_a.ascent()), text)
            y += self.LINE_H + 3
        if self.phase == "speaking" and self.answer_shown < self.answer_total:
            lines = self._answer_lines(w)
            caret_x = tx + (QFontMetricsF(self.font_answer).horizontalAdvance(lines[-1]) if lines else 0)
            caret_y = y - self.LINE_H - 3 + 2
            if 0 < caret_y < h - 4:
                col = CYAN
                col.setAlphaF(0.4 + 0.6 * abs(math.sin(self.pulse * 6.0)))
                p.setPen(Qt.PenStyle.NoPen)
                p.setBrush(col)
                p.drawRoundedRect(QRectF(caret_x + 1, caret_y, 2, self.LINE_H - 4), 1, 1)
        if self.scroll > 2:
            fade = QLinearGradient(x, 0, x, 20)
            fade.setColorAt(0.0, QColor(8, 8, 12, 232))
            fade.setColorAt(1.0, QColor(8, 8, 12, 0))
            p.fillRect(QRectF(x + self.PAD, 2, w - 2 * self.PAD, 18), fade)
        p.end()

    # ------------------------------------------------------------------ parts

    def _glow(self, p: QPainter, body: QRectF) -> None:
        cx, cy = body.center().x(), body.center().y()
        level = self.levels[-1]
        if self.phase not in ("listening", "speaking", "thinking", "done"):
            return
        thinking_glow = (0.2 + 0.09 * math.sin(self.pulse * 5.2)) if self.phase == "thinking" else 0.0
        reach = 1.0 + 0.35 * level + thinking_glow + 0.05 * math.sin(self.pulse * 1.7)
        # The halo stays a halo: wide but shallow, so a tall answer column
        # never washes the whole screen out.
        rx = body.width() * 0.55 * reach
        ry = body.height() * 0.55 * reach + 70
        g = QRadialGradient(QPointF(cx, cy), max(rx, ry))
        g.setColorAt(0.0, QColor(BLUE.red(), BLUE.green(), BLUE.blue(), int(110 + 80 * level)))
        g.setColorAt(0.4, QColor(VIOLET.red(), VIOLET.green(), VIOLET.blue(), int(52 + 46 * level)))
        g.setColorAt(0.75, QColor(CYAN.red(), CYAN.green(), CYAN.blue(), int(14 + 16 * level)))
        g.setColorAt(1.0, QColor(0, 0, 0, 0))
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(g)
        p.drawEllipse(QRectF(cx - rx, cy - ry, 2 * rx, 2 * ry))

    def _shadow(self, p: QPainter, body: QRectF, r: float) -> None:
        for i, spread in enumerate((10, 6, 3)):
            p.setPen(Qt.PenStyle.NoPen)
            p.setBrush(QColor(0, 0, 0, 30 - i * 8))
            p.drawRoundedRect(body.adjusted(-spread, 1, spread, 1 + spread), r + spread, r + spread)

    def _orb(self, p: QPainter, c: QPointF, r: float) -> None:
        if self.phase == "muted":
            p.setBrush(QColor(110, 110, 115))
            p.setPen(Qt.PenStyle.NoPen)
            p.drawEllipse(c, r, r)
            p.setPen(QPen(QColor(30, 30, 30), 2))
            p.drawLine(QPointF(c.x() - r * 0.6, c.y() + r * 0.6), QPointF(c.x() + r * 0.6, c.y() - r * 0.6))
            return
        level = self.levels[-1]
        rr = r * (1.0 + 0.16 * level)
        halo = QRadialGradient(c, rr * 2.6)
        halo.setColorAt(0.0, QColor(CYAN.red(), CYAN.green(), CYAN.blue(), int(90 + 70 * level)))
        halo.setColorAt(0.5, QColor(BLUE.red(), BLUE.green(), BLUE.blue(), int(30 + 40 * level)))
        halo.setColorAt(1.0, QColor(0, 0, 0, 0))
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(halo)
        p.drawEllipse(c, rr * 2.6, rr * 2.6)
        drift = QPointF(c.x() + r * 0.22 * math.sin(self.pulse * 0.55), c.y() + r * 0.16 * math.cos(self.pulse * 0.43))
        g = QRadialGradient(drift, rr * 1.25)
        g.setColorAt(0.0, SKY)
        g.setColorAt(0.35, CYAN)
        g.setColorAt(0.75, BLUE)
        g.setColorAt(1.0, QColor(4, 60, 140))
        p.setBrush(g)
        p.drawEllipse(c, rr, rr)
        if self.phase == "thinking":
            # The loading ring: one bright comet leading, one dimmer arc
            # trailing the other way. Two motions at different speeds read as
            # work happening, the way a real spinner does; one slow arc reads
            # as a decoration.
            ring = rr + 11
            rect = QRectF(c.x() - ring, c.y() - ring, 2 * ring, 2 * ring)
            # Qt draws arcs in sixteenths of a degree, so a span of "200"
            # would be a 12-degree sliver: every span is multiplied by 16.
            spin = self.pulse * 720                      # two turns a second: unmistakably loading
            lead = int((spin * 16) % 5760)
            trail = int((-spin * 16 * 0.62) % 5760)
            p.setPen(QPen(QColor(CYAN.red(), CYAN.green(), CYAN.blue(), 238), 3.2,
                         Qt.PenStyle.SolidLine, Qt.PenCapStyle.RoundCap))
            p.drawArc(rect, lead, 200 * 16)
            back = QColor(BLUE.red(), BLUE.green(), BLUE.blue(), 150)
            p.setPen(QPen(back, 2.4, Qt.PenStyle.SolidLine, Qt.PenCapStyle.RoundCap))
            p.drawArc(rect, trail, 130 * 16)
            # A faint third arc, fastest and shortest, keeps the ring alive
            # between the two big sweeps.
            faint = QColor(SKY.red(), SKY.green(), SKY.blue(), 90)
            p.setPen(QPen(faint, 1.8, Qt.PenStyle.SolidLine, Qt.PenCapStyle.RoundCap))
            p.drawArc(rect, int((spin * 16 * 1.9) % 5760), 70 * 16)

    def _bars(self, p: QPainter, x: float, cy: float) -> None:
        n = len(self.levels)
        bw, gap = 3.2, 3.4
        spoken_frac = (self.answer_shown / self.answer_total) if self.answer_total else 0
        for i, v in enumerate(self.levels):
            frac = i / max(1, n - 1)
            live = v * (0.45 + 0.55 * max(0.0, 1.0 - abs(frac - spoken_frac) * 1.6))
            bh = 3 + 16 * live
            p.setPen(Qt.PenStyle.NoPen)
            col = QColor(CYAN if spoken_frac >= frac - 0.12 else BLUE)
            col.setAlphaF(0.55 + 0.45 * live)
            p.setBrush(col)
            p.drawRoundedRect(QRectF(x + i * (bw + gap), cy - bh / 2, bw, bh), 1.6, 1.6)

    def mousePressEvent(self, _event) -> None:
        """One click talks; four clicks inside three seconds puts it away.

        A click that completes the four-click gesture does not also poke,
        so the island never opens and closes on the same tap.
        """
        now = time.monotonic()
        self._clicks = [t for t in getattr(self, "_clicks", []) if now - t < 3.0]
        self._clicks.append(now)
        if len(self._clicks) >= 4:
            self._clicks.clear()
            self.closed_by_user.emit()
            return
        self.clicked.emit()
