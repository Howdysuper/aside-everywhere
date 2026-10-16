# Jarvis setup (Windows)

Jarvis is the desktop half: say "Hey Jarvis" and he answers out loud, with a glowing capsule at the top of the screen that streams his words as he speaks them.

## Install

```powershell
cd aside-everywhere\jarvis
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

That does everything: a private Python environment, the hash-locked packages, the wake-word and speech models, the Start menu entry, and the login item.

Requires Python 3.12 or 3.13 (`winget install Python.Python.3.13`).

## Using it

- **Start menu**: type "Jarvis" and open it. It starts in the system tray and runs in the background.
- **Tray icon**: right-click for Talk now, Mute, Hide the island, Settings, and Quit.
- **Hotkey**: `Ctrl+Alt+J` starts a conversation without the wake word.
- **The island**: click once to talk, click four times quickly to put it away and go back to the tray.
- It wakes for "Hey Jarvis" (and understands "hey aside" and similar once transcribing).

## What happens when you talk

```
wake word ──▶ listen ──▶ transcribe on this PC ──▶ what kind of question?
                                                   │
                        ┌──────────────────────────┼──────────────────────────┐
                        │                          │                          │
                   math, units,              general knowledge          anything needing
                   dates, clocks             (Jev, ~300 ms)              the real agent
                        │                          │                          │
                   answered locally          answered locally         Aside session, steps
                   (no network)              (no session)            shown, answer spoken
```

The first two paths never touch the network for the decision and never start a session, which is why "what is seventeen times twenty three" comes back instantly.

## Settings

`%APPDATA%\HeyAside\settings.json`. The useful ones:

| Key | Default | What it does |
| --- | --- | --- |
| `wakeThreshold` | 0.55 | Wake-model confidence. Raise it if he wakes on TV noise; lower it if he misses you. |
| `followUpSeconds` | 15 | How long he keeps listening after an answer without needing the wake word again. |
| `hotkey` | `ctrl+alt+j` | Push-to-talk. |
| `whisperModel` | `base.en` | `small.en` is more accurate and slower. |
| `voice` | `en-GB-RyanNeural` | Any Windows or edge voice. |
| `spokenReplies` | true | Speak answers (the text always shows on the island). |
| `muted` | false | Microphone off entirely. |

## Keeping it alive

A watchdog process supervises Jarvis: if the app crashes or hangs (its heartbeat stops), the watchdog restarts it. The watchdog is started at login, and the local server also audits it every five minutes and restarts the watchdog if that ever dies too.

To quit for good: right-click the tray icon → **Quit Jarvis**. That stops the app; the watchdog starts it again at the next login. To remove it entirely, run `uninstall.ps1`.

## Tests

```powershell
cd aside-everywhere\jarvis
.\.venv\Scripts\python.exe -m pytest tests -q
```

The suite covers the conversation state machine (including "the island must be hidden unless he is listening or answering"), the false-alarm path, the four-click close, the layout maths, and the local answer engine.
