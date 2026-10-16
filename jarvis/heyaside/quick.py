"""Local, instant answers: no network, no model, no waiting.

The fast path before the fast path. Math, percentages, unit conversion,
dates and time zones are asked out loud constantly, and every one of them
used to cost a model call (and a 12-second timeout when the model
refused - "What 1005 60 times 1005 60?" timed out the fast path once and
dragged a 45-second full session behind it). This answers them on this PC
in microseconds.

Speech-to-math is noise, so the rules are deliberately generous and every
parse is conservative: if the question does not reduce to exactly one
arithmetic expression, the answer is None and the caller moves on. It
never invents a number.
"""
from __future__ import annotations

import ast
import datetime as _dt
import operator as _op
import re
from zoneinfo import ZoneInfo

# --------------------------------------------------------------------------- math

_WORD_NUM = {
    "zero": "0", "one": "1", "two": "2", "three": "3", "four": "4", "five": "5",
    "six": "6", "seven": "7", "eight": "8", "nine": "9", "ten": "10", "eleven": "11",
    "twelve": "12", "thirteen": "13", "fourteen": "14", "fifteen": "15", "sixteen": "16",
    "seventeen": "17", "eighteen": "18", "nineteen": "19", "twenty": "20", "thirty": "30",
    "forty": "40", "fifty": "50", "sixty": "60", "seventy": "70", "eighty": "80",
    "ninety": "90", "hundred": "100", "thousand": "1000", "million": "1000000",
    "billion": "1000000000",
}

_BINOPS = {
    ast.Add: _op.add, ast.Sub: _op.sub, ast.Mult: _op.mul, ast.Div: _op.truediv,
    ast.Pow: _op.pow, ast.Mod: _op.mod, ast.FloorDiv: _op.floordiv,
}
_UNARY = {ast.UAdd: _op.pos, ast.USub: _op.neg}


def _safe_eval(expr: str) -> float | None:
    """A tiny AST whitelist evaluator: numbers, + - * / // % ** and parentheses."""
    try:
        tree = ast.parse(expr, mode="eval")
    except (SyntaxError, ValueError, MemoryError, RecursionError):
        return None

    def walk(node: ast.AST) -> float:
        if isinstance(node, ast.Expression):
            return walk(node.body)
        if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)) and not isinstance(node.value, bool):
            return float(node.value)
        if isinstance(node, ast.BinOp) and type(node.op) in _BINOPS:
            a, b = walk(node.left), walk(node.right)
            if a is None or b is None:
                raise ValueError
            if isinstance(node.op, ast.Pow) and abs(b) > 64:
                raise ValueError          # 9 ** 9 ** 9 is not a question
            return float(_BINOPS[type(node.op)](a, b))
        if isinstance(node, ast.UnaryOp) and type(node.op) in _UNARY:
            v = walk(node.operand)
            if v is None:
                raise ValueError
            return float(_UNARY[type(node.op)](v))
        raise ValueError

    try:
        return walk(tree)
    except (ValueError, ZeroDivisionError, OverflowError, TypeError):
        return None


def _tidy_number(n: float) -> str:
    """The way a person says a number: whole numbers with commas, else 2 dp."""
    if abs(n - round(n)) < 1e-9 and abs(n) < 1e15:
        return f"{int(round(n)):,}"
    return f"{n:,.2f}"


_NUMWORD = (r"zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|"
             r"seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion")
# A run of number words. The separator is whitespace, or a hyphen that sits
# directly between two words ("sixty-five") - never " - ", which is the
# minus operator and must survive as an operator.
_COMPOUND = re.compile(rf"\b(?:{_NUMWORD})(?:(?:\s+|(?<=[a-z])-(?=[a-z]))+(?:{_NUMWORD}))*\b", re.I)

_SCALE = {"hundred": 100, "thousand": 1000, "million": 1000000, "billion": 1000000000}
_SMALL = {"zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8,
          "nine": 9, "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14, "fifteen": 15,
          "sixteen": 16, "seventeen": 17, "eighteen": 18, "nineteen": 19, "twenty": 20, "thirty": 30,
          "forty": 40, "fifty": 50, "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90}


def _compound_value(run: str) -> int | None:
    """A run of number words as one integer: "twenty three", "one thousand five hundred"."""
    total = 0
    cur = 0
    for w in re.split(r"\s+|(?<=[a-z])-(?=[a-z])", run.lower()):
        if w in _SMALL:
            cur += _SMALL[w]
        elif w == "hundred":
            cur = max(cur, 1) * 100
        elif w in _SCALE:
            total += max(cur, 1) * _SCALE[w]
            cur = 0
        else:
            return None
    return total + cur


def _words_to_digits(text: str) -> str:
    def repl(m: re.Match) -> str:
        v = _compound_value(m.group(0))
        return str(v) if v is not None else m.group(0)
    out = _COMPOUND.sub(repl, text.lower())
    kept = []
    for tok in re.findall(r"\d+(?:\.\d+)?(?:,\d{3})*(?:\.\d+)?|\*\*|[()+\-*/^%.,]|[a-z]+", out):
        kept.append(_WORD_NUM.get(tok, tok) if tok.isalpha() else tok)
    return " ".join(kept)


def _math_answer(q: str) -> str | None:
    t = q.lower().strip().rstrip("?.! ")
    t = re.sub(r"\b(what|whats|what's|whats's|calculate|compute|equals|is|are|how much is|tell me)\b", " ", t)
    # Division first: "divided by" contains "by", which the times rule below
    # would otherwise eat and turn "40 divided by 8" into "40 * 8".
    t = re.sub(r"\bdivided\s+by\b|\bover\b", "/", t)
    t = re.sub(r"\b(times|x)\b", "*", t)
    t = re.sub(r"\b(plus|added to)\b", "+", t)
    t = re.sub(r"\bminus\b", "-", t)
    t = re.sub(r"\bto the power of\b|\^", "**", t)
    t = re.sub(r"\bsquare root of\b", "sqrt", t)
    # 'and' joins numbers only ("five and five"), never prose.
    t = re.sub(r"\b(\w+)\s+and\s+(\w+)\b", lambda m: f"{m.group(1)} + {m.group(2)}"
              if m.group(1).isdigit() or m.group(1) in _WORD_NUM or m.group(1) in _SMALL else m.group(0), t)
    t = _words_to_digits(t)
    t = re.sub(r"\s+", " ", t).strip()

    if "sqrt" in t:
        inner = re.search(r"sqrt\s*\(?(\d+(?:\.\d+)?)\)?", t)
        if not inner:
            return None
        v = _safe_eval(inner.group(1))
        if v is None or v < 0:
            return None
        return f"That's {_tidy_number(v ** 0.5)}, sir."

    if "%" in t or "percent" in t:
        pct = re.search(r"(\d+(?:\.\d+)?)\s*(?:%|percent)\s*(?:of)?\s*(\d+(?:,\d{3})*(?:\.\d+)?)", t.replace(",", ""))
        if pct:
            v = _safe_eval(f"{pct.group(1)} / 100 * {pct.group(2)}")
            return f"That's {_tidy_number(v)}, sir." if v is not None else None

    clean = re.sub(r"[^0-9+\-*/^(). ]", " ", t).strip()
    clean = re.sub(r"\s+", " ", clean).strip()
    if not clean:
        return None
    # "1005 60 times 1005 60": two digit-pairs around one operator, a split the
    # speech recognizer made. Keep the number on each side of the operator.
    pair = re.search(r"(\d+(?:,\d{3})*(?:\.\d+)?)\s+(\d+(?:,\d{3})*(?:\.\d+)?)\s*([+\-*/]{1,2})\s*(\d+(?:,\d{3})*(?:\.\d+)?)\s+(\d+(?:,\d{3})*(?:\.\d+)?)", clean)
    if pair:
        clean = f"{pair.group(2).replace(',', '')} {pair.group(3)} {pair.group(4)}"
    elif re.fullmatch(r"[\d\s]+", clean) or (not re.search(r"[+\-*/^]", clean)):
        return None                      # plain numbers, no operation: not a question
    v = _safe_eval(clean)
    if v is not None:
        return f"That's {_tidy_number(v)}, sir."
    return None


# --------------------------------------------------------------------------- units

_UNIT_TO = {
    # length (metres)
    "km": 1000, "kilometers": 1000, "kilometer": 1000, "kilometres": 1000, "kilometre": 1000, "miles": 1609.344,
    "mile": 1609.344, "mi": 1609.344, "meters": 1, "meter": 1, "metres": 1, "metre": 1, "m": 1, "cm": 0.01,
    "centimeters": 0.01, "centimeter": 0.01, "mm": 0.001, "millimeters": 0.001, "millimeter": 0.001,
    "feet": 0.3048, "foot": 0.3048, "ft": 0.3048, "inches": 0.0254, "inch": 0.0254, "in": 0.0254,
    "yards": 0.9144, "yard": 0.9144, "yd": 0.9144,
    # weight (kg)
    "kg": 1, "kilograms": 1, "kilogram": 1, "kilos": 1, "kilo": 1, "g": 0.001, "grams": 0.001, "gram": 0.001,
    "lbs": 0.45359237, "lb": 0.45359237, "pounds": 0.45359237, "pound": 0.45359237, "ounces": 0.0283495,
    "ounce": 0.0283495, "oz": 0.0283495, "tons": 907.18474, "ton": 907.18474, "tonnes": 1000, "tonne": 1000,
    # volume (litres)
    "liters": 1, "liter": 1, "litres": 1, "litre": 1, "l": 1, "ml": 0.001, "milliliters": 0.001, "millilitres": 0.001,
    "gallons": 3.785411784, "gallon": 3.785411784, "gal": 3.785411784, "cups": 0.236588, "cup": 0.236588,
    "pints": 0.473176, "pint": 0.473176, "quarts": 0.946353, "quart": 0.946353,
    # temperature handled separately
}
_FROM = {
    # metres -> target
    1000: ("km", "kilometers"), 1609.344: ("mi", "miles"), 1: ("m", "meters"), 0.01: ("cm", "centimeters"),
    0.001: ("mm", "millimeters"), 0.3048: ("ft", "feet"), 0.0254: ("in", "inches"), 0.9144: ("yd", "yards"),
}


def _units_answer(q: str) -> str | None:
    t = q.lower()
    for a, b in (("fahrenheit", "celsius"), ("celsius", "fahrenheit"), ("°f", "c"), ("°c", "f")):
        m = re.search(rf"(-?\d+(?:\.\d+)?)\s*(?:degrees?\s*)?(?:{a}|\b{b if a.startswith('°') else a}\b)", t)
        if m and a in t and b in t:
            v = float(m.group(1))
            if a.startswith("fahrenheit") or a == "°f":
                c = (v - 32) * 5 / 9
                return f"{_tidy_number(c)} degrees Celsius, sir."
            f = v * 9 / 5 + 32
            return f"{_tidy_number(f)} degrees Fahrenheit, sir."
    # "5 feet 10 inches" / "5 foot 10" is one height, not a length plus a label.
    fi = re.search(r"(\d+(?:\.\d+)?)\s*(?:feet|foot|ft)\s*(\d+(?:\.\d+)?)\s*(?:inches|inch|in)\b", t)
    if fi:
        m_ = _UNIT_TO["ft"] * float(fi.group(1)) + _UNIT_TO["in"] * float(fi.group(2))
        want = re.search(r"(?:to|in|into)\s+([a-z]+)", t)
        dst = want.group(1) if want else "cm"
        if dst in _UNIT_TO:
            return f"{_tidy_number(m_ / _UNIT_TO[dst])} {dst}, sir."
        return None
    m = re.search(r"(?:convert\s+)?(-?\d+(?:\.\d+)?)\s*([a-z]+)\s+(?:to|in|into)\s+([a-z]+)", t)
    if not m:
        return None
    n, src, dst = float(m.group(1)), m.group(2), m.group(3)
    if src not in _UNIT_TO or dst not in _UNIT_TO:
        return None
    if (src in ("fahrenheit", "celsius")) or (dst in ("fahrenheit", "celsius")):
        return None
    base = n * _UNIT_TO[src]
    if base == 0:
        return None
    v = base / _UNIT_TO[dst]
    return f"{_tidy_number(v)} {dst}, sir."


# --------------------------------------------------------------------------- dates and times

_MONTHS = {m.lower(): i for i, m in enumerate(
    ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"], 1)}
_MONTHS.update({m[:3].lower(): i for m, i in list(_MONTHS.items())})
_WEEKDAY = {d.lower(): i for i, d in enumerate(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"])}
_WEEKDAY.update({d[:3].lower(): i for i, d in enumerate(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"])})

_ZONES = {
    "london": "Europe/London", "uk": "Europe/London", "england": "Europe/London", "paris": "Europe/Paris", "france": "Europe/Paris",
    "berlin": "Europe/Berlin", "germany": "Europe/Berlin", "madrid": "Europe/Madrid", "spain": "Europe/Madrid",
    "moscow": "Europe/Moscow", "russia": "Europe/Moscow", "dubai": "Asia/Dubai", "india": "Asia/Kolkata",
    "mumbai": "Asia/Kolkata", "delhi": "Asia/Kolkata", "kolkata": "Asia/Kolkata", "calcutta": "Asia/Kolkata",
    "beijing": "Asia/Shanghai", "china": "Asia/Shanghai", "shanghai": "Asia/Shanghai", "hong kong": "Asia/Hong_Kong",
    "tokyo": "Asia/Tokyo", "japan": "Asia/Tokyo", "seoul": "Asia/Seoul", "korea": "Asia/Seoul", "singapore": "Asia/Singapore",
    "sydney": "Australia/Sydney", "australia": "Australia/Sydney", "melbourne": "Australia/Melbourne",
    "new york": "America/New_York", "nyc": "America/New_York", "eastern": "America/New_York", "boston": "America/New_York",
    "atlanta": "America/New_York", "miami": "America/New_York", "toronto": "America/Toronto", "canada": "America/Toronto",
    "chicago": "America/Chicago", "central": "America/Chicago", "dallas": "America/Chicago", "houston": "America/Chicago",
    "denver": "America/Denver", "mountain": "America/Denver", "phoenix": "America/Phoenix", "arizona": "America/Phoenix",
    "los angeles": "America/Los_Angeles", "la": "America/Los_Angeles", "california": "America/Los_Angeles",
    "seattle": "America/Los_Angeles", "pacific": "America/Los_Angeles", "san francisco": "America/Los_Angeles",
    "honolulu": "Pacific/Honolulu", "hawaii": "Pacific/Honolulu", "anchorage": "America/Anchorage", "alaska": "America/Anchorage",
    "franklin": "America/Chicago", "tennessee": "America/Chicago", "nashville": "America/Chicago",
}


def _dates_answer(q: str, now: _dt.datetime | None = None) -> str | None:
    t = q.lower().strip().rstrip("?.! ")
    today = (now or _dt.datetime.now()).date()

    m = re.search(r"(?:what(?:'s| is)?\s+)?(?:the\s+)?(?:date|day)\s+today|what day is it\b|today'?s date|the date today", t)
    if m:
        return f"Today is {today.strftime('%A, %B')} {today.day}, sir."

    m = re.search(r"(?:how many days|days)\s+(?:until|to|till|before)\s+(.+)$", t)
    if m:
        target = _parse_date(m.group(1), today)
        if target:
            d = (target - today).days
            if d == 0:
                return f"That's today, sir."
            if d == 1:
                return "That's tomorrow, sir."
            if 0 < d < 400:
                return f"{d} days, sir."
            weeks = d / 7
            if weeks < 26:
                return f"About {round(weeks)} weeks, sir."
            return f"About {round(d / 30.44)} months, sir."

    m = re.search(r"what day (?:of the week )?(?:is|was|will be)\s+(.+)$", t)
    if m:
        target = _parse_date(m.group(1), today)
        if target:
            return f"{target.strftime('%A')}, sir."

    m = re.search(r"(?:what'?s|what is|tell me)\s+the (?:time|date) (?:in|for|at)\s+([a-z ]+)$", t)
    if m:
        place = m.group(1).strip()
        zone = _ZONES.get(place)
        if zone:
            z = _dt.datetime.now(ZoneInfo(zone))
            when = "today" if z.date() == today else ("tomorrow" if (z.date() - today).days == 1 else z.strftime("%A"))
            h = z.hour % 12 or 12
            clock = f"{h}:{z.minute:02d} {z.strftime('%p')}"
            return f"In {place.title()} it's {clock} {when}, sir."

    m = re.search(r"^what time is it\b", t)
    if m:
        z = _dt.datetime.now()
        h = z.hour % 12 or 12
        clock = f"{h}:{z.minute:02d} {z.strftime('%p')}"
        return f"It's {clock}, sir."
    return None


def _parse_date(text: str, today: _dt.date) -> _dt.date | None:
    t = text.strip().lower()
    m = re.search(r"([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?", t)
    if m and m.group(1) in _MONTHS:
        month = _MONTHS[m.group(1)]
        day = int(m.group(2))
        year = int(m.group(3)) if m.group(3) else today.year
        try:
            return _dt.date(year, month, day)
        except ValueError:
            return None
    m = re.search(r"(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]+)(?:,?\s*(\d{4}))?", t)
    if m and m.group(2) in _MONTHS:
        month = _MONTHS[m.group(2)]
        day = int(m.group(1))
        year = int(m.group(3)) if m.group(3) else today.year
        try:
            return _dt.date(year, month, day)
        except ValueError:
            return None
    m = re.search(r"(\d{4})-(\d{2})-(\d{2})", t)
    if m:
        try:
            return _dt.date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError:
            return None
    if t.startswith("next "):
        rest = t[5:]
        day = re.match(r"(mon|tues|wednes|thurs|fri|satur|sun)[a-z]*day", rest)
        if day:
            wants = _WEEKDAY[day.group(1) + ("day" if len(day.group(1)) >= 3 else "")]
            wd = {"mon": 0, "tues": 1, "wednes": 2, "thurs": 3, "fri": 4, "satur": 5, "sun": 6}[day.group(1)]
            d = today + _dt.timedelta(days=(wd - today.weekday()) % 7 or 7)
            return d
    return None


# --------------------------------------------------------------------------- the entry point

def answer(question: str) -> str | None:
    """One spoken sentence, or None when this knows nothing (caller moves on)."""
    q = question.strip()
    if not q:
        return None
    for fn in (_dates_answer, _units_answer, _math_answer):
        try:
            out = fn(q)
        except Exception:
            out = None
        if out:
            return out
    return None
