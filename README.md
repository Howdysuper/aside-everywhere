[![CI](https://github.com/Howdysuper/aside-everywhere/actions/workflows/ci.yml/badge.svg)](https://github.com/Howdysuper/aside-everywhere/actions/workflows/ci.yml) [![Demo site](https://github.com/Howdysuper/aside-everywhere/actions/workflows/pages.yml/badge.svg)](https://howdysuper.github.io/aside-everywhere/)

# Aside Everywhere

**Turn Aside into a full personal assistant: on your phone, on your desktop, and running in the background.**

Aside is a coding agent. This project wraps it in everything a person actually needs day to day:

- **Aside Mobile** — a phone PWA that tracks your school work (Schoology, school and personal Gmail, GroupMe, Google Calendar) and pushes real reminders to your phone, even overnight.
- **Jarvis** — a Siri-style voice assistant for Windows. Say "Hey Jarvis", ask anything, and he answers out loud with a glowing capsule that streams his words as he speaks them.
- **The local server** — always-on automation: hourly sweeps, a private decision-model door (Jev), Web Push delivery, a Cloudflare front door so your phone reaches your computer from anywhere, and a supervisor that keeps it all alive.

Nothing sensitive ever leaves your machine. Read [docs/privacy.md](docs/privacy.md) for exactly what goes where.

> **Security note:** this repo is designed to run entirely on your own computer. The only outbound services are the ones you configure (Schoology, Gmail, GroupMe, Cloudflare, and whatever model provider you point Aside at). No telemetry, no analytics, no third-party accounts.

---

## What is in the box

```
miniapp/                 the phone PWA and the local server (TypeScript + React)
  server/                Fastify API, sweeps, push engine, the Jev door, sessions bridge
  web/                   the phone app (PWA), built with Vite + React
  frontdoor/             the Cloudflare Worker that fronts your computer to the internet
  docs/                  detailed setup notes for each integration
jarvis/                  the Windows voice assistant (Python + PySide6)
  heyaside/             the app: wake word, speech, island UI, tray
  tests/                the test suite
  install.ps1           one-command setup
tools/jev                the CLI door to the decision model, shared by both apps
ops/                     operational scripts (health checks, doctor)
docs/                    the guides in this repo, including the AI setup prompts
```

---

## Quick start

You need a Windows PC and an iPhone or Android phone. Everything else is installed by the scripts.

1. **Install Aside** from the Aside app (Settings → Developer → install the CLI).
2. **Install the Phone app** — follow [docs/setup-iphone.md](docs/setup-iphone.md) or [docs/setup-android.md](docs/setup-android.md). Both contain a ready-made prompt: paste it into your AI assistant and it does the setup for you.
3. **Install Jarvis** (optional but recommended) — [docs/setup-windows.md](docs/setup-windows.md).

Full manual instructions are in each guide. The short version of the idea: the server runs on your PC, exposes itself through a Cloudflare tunnel, and the phone installs itself as a home-screen app that talks to it. Pair once with a code and it stays paired.

---

## How it works

```
                    ┌──────────────────────── your computer ────────────────────────┐
                    │                                                               │
  Gmail ──────┐     │   ┌──────────┐    ┌───────────┐    ┌──────────┐               │
  Schoology ──┼────▶│   │  sweeps  │───▶│   plan    │───▶│  pushes  │──┐            │
  GroupMe ────┘     │   │ (hourly) │    │ (ranking) │    │  (Web    │  │            │
  Calendar ─────────┘     └──────────┘    └───────────┘    │   Push)  │  │            │
                                                        └──────────┘  │            │
  Jarvis (voice) ──▶ Jev door ──▶ Aside sessions                    │            │
                                                                   ▼            │
                    └───────────────────────────────────────────────┼────────────┘
                                                                     │
                              Cloudflare front door (your own Worker) │
                                                                     ▼
                                                          ┌────────────────────┐
                                                          │  Aside Mobile PWA  │
                                                          │  (your phone)      │
                                                          └────────────────────┘
```

Two independent decision models keep it cheap and fast:

- **Jev** answers typed judgment questions (is this worth showing? is this private? is this urgent?) in milliseconds for a fraction of a cent. It never writes text and never triggers an action — code reads its numbers and decides.
- **Claude** (through Aside) writes the human-facing summary when a message actually needs one.

That split is what makes hourly sweeps affordable: the expensive model only sees mail that already passed a cheap judgment.

---

## Documentation

| Guide | What it covers |
| --- | --- |
| [docs/setup-iphone.md](docs/setup-iphone.md) | iPhone setup, including the copy-paste prompt |
| [docs/setup-android.md](docs/setup-android.md) | Android setup, including the copy-paste prompt |
| [docs/setup-windows.md](docs/setup-windows.md) | Jarvis: wake word, voice, tray, startup |
| [docs/architecture.md](docs/architecture.md) | the full system, module by module |
| [docs/privacy.md](docs/privacy.md) | what data goes where, and what never leaves the machine |
| [docs/troubleshooting.md](docs/troubleshooting.md) | the failures that actually happen and how to read them |

---

## Development

```powershell
# server
cd miniapp\server
node ..\..\node_modules\typescript\bin\tsc -p tsconfig.json
node ..\..\node_modules\vitest\vitest.mjs run

# web (phone app)
cd miniapp\web
node ..\..\node_modules\typescript\bin\tsc --noEmit
node ..\..\node_modules\vite\bin\vite.js build

# jarvis
cd jarvis
.\.venv\Scripts\python.exe -m pytest tests -q
```

Tests cover the push rules, the sweeps' privacy gates, the planner, the Jev budget door, the island's layout maths, and the whole voice conversation state machine.

---

## License

MIT. See [LICENSE](LICENSE).
