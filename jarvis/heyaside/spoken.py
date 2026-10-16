"""Words in, words out: everything about turning speech into a request and an answer into speech.

Ported from the macOS app (Conversation.swift, Controller.swift, WakeMatcher.swift) so both versions
behave the same.
"""
from __future__ import annotations

import re

VOICE_SUFFIX = (
    "\n\n[Voice mode: your reply is read aloud in a British voice; I call you Jarvis. Be JARVIS: composed, precise, "
    "quietly witty. Call me \"sir\" now and then, not every reply. Dry British humor only when it fits, never on serious "
    "answers. Lead with the actual answer, the specific names, times and numbers, in 2-6 short natural sentences under "
    "90 words; no markdown; fold lists into sentences. Never open with only a lead-in like \"Here are the five\". If I'm "
    "just reacting or chatting (\"oh that's cool\", \"thanks\", \"nice\"), reply in one short natural line and don't use "
    "tools. Be discreet: this plays out loud and others may hear, so never volunteer sensitive details (immigration "
    "status, health, money, grades, private messages, passwords) unless I asked for that exact thing. You have my memory, "
    "history and skills, so use them and never claim you can't remember things. My words come from speech recognition, "
    "so read through mishearings (a name like \"Clint\" or \"Travis\" at the start means Jarvis; \"a side\" means Aside). "
    "Any tool title you write is shown to me on screen: make it 2-5 plain-English words like \"Checking your calendar\", "
    "no file names or jargon. I have already said a short acknowledgement out loud, so never open with one or with a "
    "heads-up; start with the result. Say numbers the way a person would: exact when I asked for a figure, rounded when "
    "it doesn't matter. Fuller detail can go after a line containing only ---.]"
)

# --------------------------------------------------------------------------- wake phrase

_WAKE = re.compile(r"^\s*(hey|hi|okay|ok)[\s,]+(jarvis|jarvas|travis|clint|a ?side)\b[\s,.!?]*", re.I)


def strip_wake(text: str) -> str:
    """'Hey Jarvis, what's the weather' -> "what's the weather". Whisper often keeps the wake words."""
    return _WAKE.sub("", text, count=1).strip()


# --------------------------------------------------------------------------- conversation control

_DISMISS = re.compile(
    r"^(no,?\s*)?(thanks|thank you|thank you very much|that'?s all|that will be all|that'?ll be all|that is all|bye|goodbye|"
    r"good ?night|nothing|never ?mind|no thanks|no,? thank you|i'?m good|all good|we'?re done|that'?s it)"
    r"(,?\s*(jarvis|sir|buddy|mate))?[.!]*$",
    re.I,
)


def is_dismissal(text: str) -> bool:
    """A clear sign-off ends the conversation; 'thanks, now email it to me' does not."""
    t = text.strip().strip(".!? ").lower()
    if not t:
        return False
    return bool(_DISMISS.match(t))


def intent(text: str, agent_busy: bool) -> str:
    """While Aside is working: stop it, ask what it's doing, steer it, or queue the next thing."""
    t = text.strip().lower()
    words = t.split()
    if not agent_busy:
        return "new"
    if len(words) <= 5 and re.search(r"\b(stop|cancel|abort|never ?mind|forget it)\b", t):
        return "stop"
    if re.search(r"\b(what are you doing|what('?s| is) taking|how'?s it going|status|are you done|still working)\b", t):
        return "status"
    if re.match(r"^(actually|instead|wait|no,|make it|just|skip)\b", t):
        return "steer"
    return "queue"


# --------------------------------------------------------------------------- answer -> speech


def clean(text: str) -> str:
    s = text
    rules = [
        (r"```[\s\S]*?```", " "), (r"`([^`]*)`", r"\1"), (r"!\[[^\]]*\]\([^)]*\)", ""), (r"\[([^\]]+)\]\([^)]*\)", r"\1"),
        (r"https?://\S+", "the link"), (r"(?m)^\s{0,3}#{1,6}\s*", ""), (r"(?m)^\s*[-*+•]\s+", ""), (r"(?m)^\s*\d+[.)]\s+", ""),
        (r"\*\*|__|\*|_(?=\S)|(?<=\S)_", ""), (r"\|", ", "), (r"\s*\n\s*\n\s*", ". "), (r"\s*\n\s*", " "),
        (r"\.\s*\.(\s|$)", r".\1"), (r":\s*\.", ":"), (r"\s{2,}", " "),
    ]
    for pat, rep in rules:
        s = re.sub(pat, rep, s)
    return s.replace("—", ", ").strip()


def sentences(s: str) -> list[str]:
    parts = re.split(r"(?<=[.!?])\s+(?=[A-Z0-9\"'(])", s.strip())
    return [p.strip() for p in parts if p.strip()]


def cap(s: str, max_sentences: int, max_words: int) -> str:
    all_s = sentences(s)
    out: list[str] = []
    words = 0
    for t in all_s:
        w = len(t.split())
        if out and (len(out) >= max_sentences or words + w > max_words):
            break
        out.append(t)
        words += w
    joined = " ".join(out)
    return joined + " The rest is in Aside." if len(out) < len(all_s) else joined


def is_lead_in(s: str) -> bool:
    if len(s.split()) > 16:
        return False
    if s.endswith(":"):
        return True
    return bool(re.search(
        r"\b(here (are|is|'s)|here’s|below|the following|as follows|these are|i found|i've got|i have (the|your)|saved as|listed|breakdown|rundown|summary)\b",
        s, re.I))


def key_items(detail: str) -> list[str]:
    lines = [l.strip() for l in detail.split("\n") if l.strip()]
    is_header = lambda l: l.startswith("**") or l.startswith("#") or (l.endswith(":") and len(l) < 60)
    is_item = lambda l: re.match(r"^([-*+•]|\d+[.)])\s+", l) is not None
    timed = lambda l: re.search(r"\b(due|by|at|until)\b.*\d|\d{1,2}(:\d{2})?\s?(am|pm)|\b(mon|tue|wed|thu|fri|sat|sun)\w*\b", l, re.I) is not None
    has_due = lambda l: re.search(r"\bdue\b", l, re.I) is not None
    items = [l for l in lines if is_item(l)]
    prefer_due = sum(map(has_due, items)) >= 2
    prefer_timed = not prefer_due and sum(map(timed, items)) >= 2
    out: list[str] = []
    words = 0
    for l in lines:
        if is_header(l):
            h = clean(l).strip(":. ")
            if h and words < 70:
                out.append(h + ":")
                words += len(h.split())
        elif is_item(l) and (has_due(l) if prefer_due else (not prefer_timed or timed(l))):
            t = clean(l).strip()
            if not t.endswith("."):
                t += "."
            w = len(t.split())
            if words + w > 95:
                break
            out.append(t)
            words += w
    while out and out[-1].endswith(":"):
        out.pop()
    return out


def spoken_from(answer: str) -> str:
    """The real answer, concise, never just a headline; long detail stays in the Aside chat."""
    spoken, detail = answer, None
    m = re.search(r"\n\s*---+\s*(\n|$)", answer)
    if m:
        spoken, detail = answer[: m.start()], answer[m.end():]
    s = clean(spoken)
    if detail and is_lead_in(s):
        items = key_items(detail)
        if items:
            return cap(s.strip(":. ") + ". " + " ".join(items), 12, 120)
    return cap(s, 7, 110)


def speech_chunks(text: str) -> list[str]:
    """Sentences to synthesize one by one, so the first words play sooner. A long first sentence is cut at its first comma."""
    out = sentences(text)
    if out and len(out[0].split()) > 12 and "," in out[0]:
        head, tail = out[0].split(",", 1)
        out = [head + ","] + [tail.strip()] + out[1:]
    return out
