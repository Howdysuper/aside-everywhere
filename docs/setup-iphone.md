# iPhone setup

Twenty minutes, once. After this the app opens from your home screen like any other app and pushes reminders to you.

## Before you start

- A Windows PC on the same network as your phone (for the first pairing only)
- The Aside app installed on the PC, with the CLI installed from **Settings → Developer**
- Node 20+ on the PC
- A Cloudflare account (free) for the front door, so your phone can reach the PC from anywhere

## 1. Run the server on your PC

```powershell
cd aside-everywhere\miniapp\server
npm install
node ..\..\node_modules\typescript\bin\tsc -p tsconfig.json
copy .\src\cloudflared-release.json .\dist\
npm start        # or: node dist\index.js
```

The server listens on `http://127.0.0.1:8790`.

## 2. Deploy the front door (one time)

```powershell
cd aside-everywhere\miniapp\frontdoor
npx wrangler login
npx wrangler deploy
```

Write the worker URL it prints into the server config (`.aside-mobile\front-door\frontdoor.json` is created for you; the key is `front`). Restart the server.

## 3. Build the phone app

```powershell
cd aside-everywhere\miniapp\web
npm install
node ..\..\node_modules\typescript\bin\tsc --noEmit
node ..\..\node_modules\vite\bin\vite.js build
```

The server serves the built app itself, so there is nothing to upload anywhere.

## 4. Pair the phone

1. On the PC, open `http://127.0.0.1:8790/pair` and copy the link it shows (it contains a one-time code).
2. Send that link to your phone (AirDrop, Messages, whatever) and open it in Safari.
3. The page asks to add the app to your home screen: tap Share → **Add to Home Screen**.
4. Open the app from the home screen. It pairs itself and asks to enable notifications. Say **Allow**.

Pairing lasts years by default; the phone silently refreshes its token in the background every time you open the app.

## 5. Connect your accounts

In the app: **Settings → Connections**. You will need, in this order:

- **Google** (for Gmail and Calendar) — sign in once per mailbox
- **Schoology** — sign in through the browser once; the login is replayed automatically afterwards
- **GroupMe** — paste a personal access token (see below)

## 6. The GroupMe token

GroupMe's API needs a personal token. The shortest path:

1. Sign in at https://dev.groupme.com
2. Open the **Access token** page (top right)
3. Copy the token and paste it into the app's GroupMe settings

The token is stored in a private file on your PC (mode 0600) and never leaves it.

## 7. Check it is alive

- Open the app: the top of the To Do list shows when each feed last refreshed
- Send yourself a test push: **Settings → Notifications → Send test**
- Run `node scripts\doctor.mjs` from `miniapp\` for a full health report

---

## The prompt for your AI assistant

Prefer to have an assistant do it? Paste this into ChatGPT, Claude, or any coding agent and give it this repository. It is written to be self-contained.

```text
You are setting up "Aside Everywhere" on my Windows PC and my iPhone. Work
through it in order and verify each step before moving on. Ask me for anything
you cannot discover yourself.

Context you will need from me as we go:
- the path where I cloned this repository
- a Cloudflare account I control (I will run `npx wrangler login` when you ask)

Steps:

1. PREREQUISITES. Verify Node 20+ and the Aside CLI exist on this PC. If the
   Aside CLI is missing, tell me to install it from the Aside app under
   Settings > Developer and wait.

2. SERVER. From the repo root:
   - cd miniapp/server
   - install dependencies
   - compile TypeScript
   - copy src/cloudflared-release.json into dist/
   - start the server and confirm http://127.0.0.1:8790/api/health answers
     {"ok":true}
   If the server dies when your shell exits, tell me to start it from my own
   PowerShell; a supervisor on the PC is expected to keep it alive, so tell me
   how to check that too.

3. FRONT DOOR. Deploy miniapp/frontdoor as a Cloudflare Worker (I will run
   `npx wrangler login`). Then put the worker's URL into the server's front-door
   config and restart the server. Verify https://<worker>/api/health answers
   {"ok":true}. Never print any secret values; just confirm they exist.

4. PHONE APP. Build miniapp/web (typecheck + vite build). Then open
   http://127.0.0.1:8790/pair on the PC and give me the full link it shows.
   I will open it on my iPhone in Safari, add it to my home screen, and open it.
   Confirm the app reports itself as paired, then have me allow notifications
   and send a test push that arrives.

5. CONNECTIONS. Walk me through connecting, one at a time, and verify each by
   running a refresh and checking the feed timestamps update:
   - Google: sign in for my school mailbox and my personal mailbox. If the
     account list does not show an account I added on the web, use the pinned
     /u/N/ index fallback the code already supports rather than failing.
   - Schoology: sign in through the browser once, then verify the scheduled
     sweep writes item-notes.json. Do not store or type my password; the
     existing replay logic handles the session. If it asks me to re-login, say so.
   - GroupMe: give me the dev.groupme.com Access token page, take the token I
     paste, save it to the private state file, and verify the group sweep and
     the DM watcher both run.

6. SCHEDULES. Confirm and report: Gmail and GroupMe sweeps every 30 minutes,
   the GroupMe DM watcher every 5 minutes, Schoology at 06:30, 12:00, 15:00 and
   19:00 with an automatic catch-up if the PC was asleep for a slot. Verify by
   reading the activity log, not by trusting any single message.

7. PUSH RULES. Verify that: new items push "New on your list"; something due
   within two hours pushes "Due soon"; a late item pushes "Now late"; a GroupMe
   DM pushes "Respond to <name> on GroupMe" immediately; any failure in the whole
   system writes to the issue log AND pushes a "Problem: <what>" notification.
   Show me the issue log path.

8. JARVIS (optional). If I say yes, set up jarvis/ per its install script, then
   verify: the tray icon appears, saying "Hey Jarvis" starts a conversation, a
   math question answers locally without any network call, and the island hides
   itself after the answer. Report the wake threshold and how to change it.

Throughout: never print API keys, tokens, or my personal data. If a step fails
twice, stop and tell me exactly what you saw, what you tried, and what you need
from me.
```

---

## If something breaks

See [troubleshooting.md](troubleshooting.md). The two that matter most:

- **"Schoology stopped syncing"** — the session expired. Open the app once, sign into Schoology, and the next sweep replays it.
- **No pushes at all** — check Settings → Notifications, then run `node scripts\doctor.mjs`.
