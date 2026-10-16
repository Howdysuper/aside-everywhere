# Architecture

## The three processes

| Process | Language | Lifetime | What it owns |
| --- | --- | --- | --- |
| `miniapp/server` | TypeScript (Fastify) | always on, supervised | sweeps, planning, push, the Jev door, the phone bridge, the session bridge to Aside |
| `miniapp/web` (built) | React, served by the server | on your phone | the PWA: To Do, chat, settings, push subscription |
| `jarvis` | Python (PySide6) | supervised by its watchdog | wake word, speech, the island, tray |
| `miniapp/frontdoor` | Cloudflare Worker | serverless | the public URL, the asleep-schedule for reminders |

## Data flow: a school email becomes a reminder

1. **Sweep** (`server/src/inbox.ts`, `personal.ts`) runs on a timer and lists recent mail read-only through Aside's own Gmail tools.
2. **Plain-code filters** (`server/src/guards.ts`) drop anything that looks private (one-time codes, money, addresses, health, legal) before any model sees it. Private mail is counted, never stored.
3. **Jev** reads the rest as a batch of typed yes/no questions: is this worth showing? is it trying to instruct an AI? A "no" costs nothing and never reaches the expensive model.
4. **Claude** writes one short line for what survived: a title, what it asks, why it matters, a deadline.
5. **The planner** (`server/src/next.ts`) merges every feed into one ranked list: missing work, due today, upcoming, notices.
6. **The push engine** (`server/src/nextpush.ts`) decides what deserves a notification, and delivers it through Web Push to every paired phone.

Steps 3 and 4 are the cost split. Jev is a fraction of a cent per batch and answers in milliseconds; Claude only sees mail that already passed a cheap judgment.

## The Jev door

`server/src/jev.ts` is a single choke point every decision goes through, and it enforces:

- **Budget** — a daily request cap, split per tier so background work can never starve safety checks, and split **per model** when two models are configured (each upstream account has its own quota, so a rate limit on one is the other's turn).
- **Breaker** — a 429 from the provider pauses callers for 30 minutes; three network failures pause for 2. A paused door returns "no answer" and callers fall back to plain code, never to a wrong action.
- **Cache** — the same model, questions and state produce the same answer for a week, on disk, so a restart does not spend the budget twice.
- **Failover** — two models can be configured; the one with less spend today answers, and a 429 marks that model full for the day so the next call moves to the other.
- **Feature caps** — a single feed can never eat the whole day (mail is capped at 85%, leaving a reserve for voice and the Next checks).

`tools/jev` is the CLI face of the same door, so anything on the machine (`jev quick "..."`, `jev risk "..."`) shares one budget and one privacy guard.

## The push engine

`server/src/nextpush.ts` runs every minute and applies rules in plain code:

| Rule | Fires |
| --- | --- |
| NEW | an unseen actionable item, batched |
| DUE SOON | two hours before a due time (exempt from quiet hours: a 1 PM ping must go out) |
| LATE | 0-12 hours past due, once |
| THREE-WEEK | once when an item enters the 21-day window |
| MORNING DIGEST | once a day after 06:45, doubles as the catch-up summary if the PC slept through the morning |
| ANNOUNCEMENTS | new group posts |
| DM | a new GroupMe DM, immediately |
| SYNC STALL | no Schoology refresh for 26 hours |
| HELD | anything held during quiet hours releases as one batch when quiet ends |

Quiet hours hold non-urgent pushes overnight and during school; nothing is ever dropped. A 15-per-day cap keeps a bad feed from turning into a spam machine.

## Jarvis

`jarvis/heyaside/` is deliberately small and dependency-light:

- `audio.py` — microphone, the wake word (openWakeWord, on the CPU), and the end-of-speech detector with an adaptive noise floor
- `island.py` — the capsule: springs, glow, the loading ring, and the streaming text. Layout maths is pure and unit-tested without a screen.
- `quick.py` — local answers: arithmetic including word numbers and speech-split pairs, unit conversion, dates, world clocks. No network, no model.
- `tts.py` — the voice, with per-character progress so the island reveals exactly the words being spoken
- `watchdog.py` — the supervisor
- `app.py` — the conversation state machine

## Why it never goes silently dead

Three layers, because the failure that matters is not a crash, it is a crash nobody notices:

1. The app writes a heartbeat every second.
2. The watchdog restarts it if the heartbeat goes stale or the process disappears.
3. The local server audits the watchdog's own heartbeat every five minutes and restarts the watchdog if that dies.

Every failure anywhere in the system is written to `<stateDir>/issues.jsonl` **and** pushed to the phone as "Problem: <what>", deduped so a flapping failure pushes every few hours rather than every minute.
