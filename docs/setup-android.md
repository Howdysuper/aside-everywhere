# Android setup

Twenty minutes, once. After this the app installs to your home screen and pushes reminders to you.

## Before you start

- A Windows PC and an Android phone (the first pairing needs them on the same Wi-Fi)
- The Aside app on the PC, with the CLI installed from **Settings → Developer**
- Node 20+ on the PC
- A Cloudflare account (free) for the front door

## 1. Run the server on your PC

```powershell
cd aside-everywhere\miniapp\server
npm install
node ..\..\node_modules\typescript\bin\tsc -p tsconfig.json
copy .\src\cloudflared-release.json .\dist\
npm start
```

Confirm `http://127.0.0.1:8790/api/health` answers `{"ok":true}`.

## 2. Deploy the front door (one time)

```powershell
cd aside-everywhere\miniapp\frontdoor
npx wrangler login
npx wrangler deploy
```

Put the worker URL into the server's front-door config (`.aside-mobile\front-door\frontdoor.json`, key `front`) and restart the server.

## 3. Build the phone app

```powershell
cd aside-everywhere\miniapp\web
npm install
node ..\..\node_modules\typescript\bin\tsc --noEmit
node ..\..\node_modules\vite\bin\vite.js build
```

## 4. Install it on the phone

1. On the PC, open `http://127.0.0.1:8790/pair` and copy the link (it has a one-time code).
2. Open that link **in Chrome on the Android phone**. Both must be on the same Wi-Fi; use the PC's LAN address if the Cloudflare URL does not resolve yet.
3. Chrome shows the install prompt: **Add to Home screen**. Accept it.
4. Open the app from the home screen. It pairs itself and asks for notification permission. Tap **Allow**.

If Chrome does not offer the install prompt, use the menu → **Install app** / **Add to Home screen**.

## 5. Connect your accounts

**Settings → Connections**, in this order: Google (one per mailbox), Schoology (browser sign-in once), GroupMe (token from https://dev.groupme.com → Access token).

## 6. The GroupMe token

1. Sign in at https://dev.groupme.com
2. Open **Access token** (top right)
3. Copy the token into the app

It is saved in a private file on the PC and never leaves it.

## 7. Battery settings that actually matter

Android is aggressive about background apps, and this app is a PWA that polls a server. Do these three things or pushes will stall:

1. **Settings → Apps → Aside Mobile → Battery → Unrestricted**
2. **Settings → Apps → Chrome → Battery → Unrestricted** (Chrome delivers the pushes for the installed app)
3. Lock the app in the Recents screen (swipe down on its card, or the lock icon) so it is not killed in the background

Also confirm Chrome's site settings for your front-door URL allow notifications: Chrome menu → Settings → Site settings → Notifications.

## 8. Verify

- The To Do list shows a "last refreshed" time per feed
- Send a test push from Settings → Notifications
- Run `node scripts\doctor.mjs` from `miniapp\` on the PC

---

## The prompt for your AI assistant

Prefer to have an assistant do it? Paste this into ChatGPT, Claude, or any coding agent and hand it this repository.

```text
You are setting up "Aside Everywhere" on my Windows PC and my Android phone.
Work in order and verify each step. Ask me for anything you cannot discover.

Context you will need from me:
- where I cloned this repository
- a Cloudflare account I control (I will run `npx wrangler login` when asked)

Steps:

1. PREREQUISITES. Verify Node 20+ and the Aside CLI on the PC. If the CLI is
   missing, tell me to install it from the Aside app under Settings > Developer.

2. SERVER. From the repo: cd miniapp/server, install, typecheck, copy
   src/cloudflared-release.json into dist/, start it, and confirm
   http://127.0.0.1:8790/api/health answers {"ok":true}. If your shell kills it
   on exit, start it from my PowerShell instead and confirm a supervisor keeps
   it alive.

3. FRONT DOOR. Deploy miniapp/frontdoor (I will run `npx wrangler login`), put
   the worker URL into the server's front-door config, restart, and verify
   https://<worker>/api/health. Never print secrets.

4. PHONE APP. Build miniapp/web. Open http://127.0.0.1:8790/pair on the PC and
   give me the full link. I will open it in Chrome on the phone, both on the
   same Wi-Fi, and install it to the home screen. Then confirm the app says it
   is paired, and that a test push arrives on the PHONE (not just the PC).

5. ANDROID BATTERY. Walk me through making the app and Chrome unrestricted in
   Android's battery settings, and locking the app in Recents. Tell me why: an
   aggressive battery manager is the number one cause of missed pushes on
   Android.

6. CONNECTIONS. Connect and verify with a real refresh each time:
   - Google: school mailbox + personal mailbox. If an account added on the web
     is missing from the list, use the pinned /u/N/ index fallback the code
     already supports.
   - Schoology: browser sign-in once, then confirm the sweep writes
     item-notes.json. Never type or store my password. If a re-login is needed,
     say so.
   - GroupMe: dev.groupme.com Access token page, take the token I paste, save it
     to the private state file, and verify both the group sweep and the DM
     watcher.

7. SCHEDULES. Confirm Gmail and GroupMe every 30 minutes, DMs every 5 minutes,
   Schoology at 06:30, 12:00, 15:00, 19:00 with catch-up for missed slots.
   Verify from the activity log.

8. PUSH RULES. Verify: new items, due-soon (T-2h), late, immediate GroupMe DM
   pushes, and a "Problem: <what>" push plus a log line for any failure anywhere
   in the system. Show me the issue log.

9. JARVIS (optional). If I ask for it, set up jarvis/ and verify the tray icon,
   a "Hey Jarvis" conversation, a local math answer with no network call, and
   the island hiding after the answer.

Throughout: never print API keys, tokens, or personal data. If a step fails
twice, stop, show me the exact error, and tell me what you need.
```

---

## If something breaks

See [troubleshooting.md](troubleshooting.md).
