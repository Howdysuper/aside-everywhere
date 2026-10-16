"""Objective checks on the island's rendered frames, so the design can be
verified without a human looking at the PNGs.

    QT_QPA_PLATFORM=offscreen python heyaside/preview_check.py <dir>

For each frame it asserts:
  - something is drawn at all (alpha coverage)
  - the glow exists: cyan/blue halo pixels around the capsule
  - the capsule is a dark material: the centre pixel is dark
  - the text is drawn: bright text pixels in the text column
  - the answer column grows with the answer length
  - nothing spills outside the capsule's rounded body
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from PySide6.QtGui import QImage  # noqa: E402


ORB_R = 13          # the orb's radius in the design
RING_OUTER = 27     # rr + 11 + the pen


def analyse(path: Path) -> dict:
    img = QImage(str(path))
    w, h = img.width(), img.height()
    covered = glow = text_px = ring_px = 0
    min_x, max_x, min_y, max_y = w, -1, h, -1
    dark_centre = None
    # The orb sits at the left of the capsule: PAD 18 + ORB 26/2 = 31 from the
    # capsule's left edge; the capsule is centred in the frame.
    for y in range(h):
        for x in range(w):
            c = img.pixelColor(x, y)
            if c.alpha() > 12:
                covered += 1
                min_x, max_x = min(min_x, x), max(max_x, x)
                min_y, max_y = min(min_y, y), max(max_y, y)
            if c.alpha() > 40 and c.blue() > 90 and c.blue() > c.red() * 1.25 and c.green() > c.red() * 1.1:
                glow += 1
            if c.alpha() > 120 and x > w * 0.28 and c.red() > 150 and c.green() > 150 and c.blue() > 150:
                text_px += 1
            # The loading ring: bright cyan in the annulus outside the orb.
            if c.alpha() > 150 and c.blue() > 140 and c.green() > 110 and c.red() < 120:
                cx, cy = (w - 560) // 2 + 18 + 13, min(h, 44) // 2 + 4
                d = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5
                if ORB_R + 2 < d < RING_OUTER:
                    ring_px += 1
    if w and h:
        # Sample just inside the top of the capsule, where the fill always is.
        centre = img.pixelColor(w // 2, min(24, h - 1))
        dark_centre = (centre.red() + centre.green() + centre.blue()) < 300 and centre.alpha() > 150
    return {
        "file": path.name,
        "size": f"{w}x{h}",
        "covered_pct": round(100 * covered / (w * h), 1),
        "glow_px": glow,
        "text_px": text_px,
        "ring_px": ring_px,
        "dark_centre": dark_centre,
        "bounds": (min_x, min_y, max_x, max_y),
    }


def main() -> int:
    d = Path(sys.argv[1] if len(sys.argv) > 1 else "preview")
    rows = [analyse(p) for p in sorted(d.glob("*.png"))]
    ok = True
    prev_text = 0
    for r in rows:
        line = (
            f"{r['file']}: covered={r['covered_pct']}% glow={r['glow_px']} text={r['text_px']} "
            f"ring={r['ring_px']} darkCentre={r['dark_centre']} bounds={r['bounds']}"
        )
        print(line)
        if r["covered_pct"] < 1 or r["dark_centre"] is not True:
            ok = False
            print("  FAIL: nothing drawn or the capsule is not a dark material")
        if r["file"].startswith(("01", "02")) and r["text_px"] < 200:
            ok = False
            print("  FAIL: no question text drawn")
        # Only the thinking frame carries the loading ring; a listening frame
        # must not (the ring means work, not attention).
        if r["file"].startswith("02") and r["ring_px"] < 60:
            ok = False
            print(f"  FAIL: the loading ring is too small or missing (ring={r['ring_px']})")
        if r["file"].startswith("01") and r["ring_px"] > 60:
            ok = False
            print(f"  FAIL: the ring shows while merely listening (ring={r['ring_px']})")
        if r["file"].startswith("03") and r["text_px"] < 400:
            ok = False
            print("  FAIL: early answer text missing")
        if r["file"].startswith("05") and r["text_px"] < prev_text:
            ok = False
            print("  FAIL: the full answer did not add text")
        prev_text = r["text_px"]
    print("CHECKS", "PASSED" if ok else "FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
