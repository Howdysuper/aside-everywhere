# Privacy: what goes where

The short version: **this system runs on your computer.** The only outbound connections are to services you explicitly connect, plus the model provider you point Aside at.

## What never leaves your machine

- Your **GroupMe token**, Gmail sessions, and Schoology session. They live in a private state directory with file mode 0600 and are never logged.
- Anything classified as **private** by the plain-code filters: one-time codes, account numbers, money amounts, addresses, health, legal, and immigration details. These are counted (so you can see "4 flagged") and then dropped. They are not sent to any model and not written to any feed.
- **Audio**. The microphone stream is processed locally by openWakeWord and faster-whisper. Nothing is recorded, saved, or uploaded.

## What does leave, and to whom

| Destination | What goes there | Why |
| --- | --- | --- |
| Your model provider (9router / OpenRouter / Opencode Zen, or whatever you configure) | Redacted message text and typed yes/no questions | the actual answering |
| Cloudflare | the request path for the front door | so your phone can reach your PC |
| Apple / Google push services | title and body of a notification | delivery to your phone |
| Schoology / Gmail / GroupMe | read-only requests | the sweeps |

## What is stripped before any model sees it

The text model never receives raw mail or chat. Before it is called, the pipeline removes: URLs, email addresses, phone numbers, long numbers, and money amounts. The question to Jev is a typed judgment, not the message.

The one field that is a real address is the **Web Push VAPID subject**, which Apple requires to be a real email (it rejects `mailto:aside-local@localhost` with a silent 403). Set it with `MINIAPP_VAPID_SUBJECT`. It is never used to send mail; push services only use it to identify the sender.

## Your own data, your own rules

- No telemetry, no analytics, no crash reporting to anyone but you.
- The issue log (`issues.jsonl`) is local and contains failure descriptions only.
- Kill switch for a lost phone: delete the signing secret (or rotate it). Every token everywhere is invalidated at once and a fresh pairing is required.
- GroupMe and Gmail access are read-only by construction: the code only ever issues GETs.

## Verifying it yourself

```powershell
# everything the server has stored locally, with sizes and ages
Get-ChildItem "$env:LOCALAPPDATA\HeyAside" -ErrorAction SilentlyContinue
Get-ChildItem "$HOME\.aside-mobile"

# the complete failure log
Get-Content "$HOME\.aside-mobile\issues.jsonl"
```

Grep the source for anything you are unsure about. The privacy filters live in `server/src/guards.ts` and are unit-tested.
