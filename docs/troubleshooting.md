# Troubleshooting

Every failure in this system is written to `<stateDir>/issues.jsonl` **and** pushed to your phone as "Problem: <what>". Start there: it names the component and the reason.

```powershell
Get-Content "$HOME\.aside-mobile\issues.jsonl" | Select-Object -Last 10
```

Then the health check:

```powershell
cd aside-everywhere\miniapp
node scripts\doctor.mjs
```

## The failures that actually happen

### Pushes stop arriving

1. Settings → Notifications → **Send test**. If it says "no devices", the phone lost its subscription: open the app once on the phone and re-allow notifications.
2. On iPhone: check Focus / Do Not Disturb, and that notifications for the app are allowed in Settings → Notifications.
3. On Android: the app and Chrome must be **Unrestricted** in battery settings, and locked in Recents. See the Android guide.
4. Quiet hours hold non-urgent pushes between 22:30 and 06:45. They release as one batch, they are not dropped.

### "Schoology stopped syncing"

The browser session expired. Open the app, sign into Schoology once, and the next sweep replays it. The 12:00/15:00/19:00 checks will catch up anything missed while it was expired.

If it keeps happening, delete the saved session file and re-login.

### Mail says "N wait for Jev"

Jev spent its daily budget. The budget splits per model and per tier, and mail is capped at 85% of the day, so this should be rare. When it happens, emails wait and sort on the next sweep after the budget resets (the upstream day resets at 00:00 UTC).

To see exactly where it went:

```powershell
node tools\jev status
```

### Jarvis does not wake up

- Is the tray icon there? If not, the app is not running: open Jarvis from the Start menu (the watchdog should start it).
- Wake too rarely: lower `wakeThreshold` in settings.json (0.55 default, 0.5 is the model's default).
- Waking on TV noise: raise it.
- Read the log — every activation is recorded with its score:

```powershell
Get-Content "$env:LOCALAPPDATA\HeyAside\Logs\heyaside.log" -Tail 30
```

A line like `wake fired (score 0.61, threshold 0.55)` tells you exactly how confident the model was. If the score is always near the threshold, move the threshold past it.

### Jarvis acts on things nobody said

That is the follow-up window hearing background noise. Short utterances (under three words) inside the window are ignored by design; shorten `followUpSeconds` if it keeps happening.

### The island will not go away

Click it four times quickly. Or right-click the tray icon → **Hide the island**.

### The app says it cannot reach your computer

The tunnel died. The server restarts it automatically (it audits every 20 seconds), so this usually fixes itself in under a minute. If it does not:

```powershell
# is the server up?
Invoke-WebRequest http://127.0.0.1:8790/api/health

# is the front door up?
Invoke-WebRequest https://<your-worker>/api/health
```

### A Google account is missing from the list

Accounts added on the web sometimes do not appear in the enumeration. The code supports a pinned index: set `mailAccountIndex` (school) or `{ "email": ..., "index": N }` (personal) in the planner config and it uses that account directly.

## Reading the logs

| File | What is in it |
| --- | --- |
| `<stateDir>/issues.jsonl` | every failure, one JSON line each |
| `<stateDir>/next-ledger.jsonl` | every sweep, with counts and reasons |
| `%LOCALAPPDATA%\HeyAside\Logs\heyaside.log` | Jarvis: boot, every wake with its score, every answer path |

## Nuclear option

Delete the state directory (`.aside-mobile`) and restart the server. You will need to re-pair the phone and reconnect the accounts, and every question will be re-asked from scratch. Prefer fixing the one feed that is broken.
