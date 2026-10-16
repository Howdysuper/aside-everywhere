#!/usr/bin/env node
/**
 * Does this install actually work?
 *
 * Every check answers a question someone hits during setup, in the order
 * they hit it, and each one prints what to do rather than just what failed.
 * Exit code is the number of hard failures, so an agent can branch on it.
 *
 * Run: npm run doctor   (from miniapp/)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const miniapp = path.resolve(here, '..');
const repo = path.resolve(miniapp, '..');

let failures = 0;
let warnings = 0;
const setupOnly = process.argv.includes('--setup');

const ok = (m, detail) => console.log(`  ok    ${m}${detail ? `  (${detail})` : ''}`);
const bad = (m, fix) => {
  failures += 1;
  console.log(`  FAIL  ${m}`);
  if (fix) console.log(`        fix: ${fix}`);
};
const warn = (m, detail) => {
  warnings += 1;
  console.log(`  warn  ${m}${detail ? `  (${detail})` : ''}`);
};
// During first install there is intentionally no running server or Serve
// rule yet. Keep those findings visible without making reproducible setup
// fail before the networking steps have happened.
const runtimeBad = (m, fix) => setupOnly ? warn(m, fix) : bad(m, fix);

const section = (title) => console.log(`\n${title}`);
const WIN = process.platform === 'win32';
/** The install hint for this platform. */
const hint = (mac, win) => (WIN ? win : mac);
/** Is a bare command name (e.g. `aside`) on PATH? */
function onPath(name) {
  try {
    sh(WIN ? 'where' : 'which', [name]);
    return true;
  } catch {
    return false;
  }
}

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...opts }).trim();
}

async function httpStatus(url, timeoutMs = 4000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal });
    return res.status;
  } catch {
    return 0;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Status plus body, without following redirects.
 *
 * `fetch` follows a 302 by default, which would hide exactly the thing the
 * `/` check is looking for.
 */
async function httpRaw(url, timeoutMs = 4000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal, redirect: 'manual' });
    return {
      status: res.status,
      location: res.headers.get('location') || '',
      body: await res.text().catch(() => ''),
    };
  } catch {
    return { status: 0, location: '', body: '' };
  } finally {
    clearTimeout(timer);
  }
}

// --- 1. toolchain ---------------------------------------------------------
section('Toolchain');

/*
 * 22.5 is where `node:sqlite` landed, and browser history and the session
 * state cache both read Chrome's SQLite directly. Both imports are inside a
 * try/catch, so an older Node boots fine and then quietly has no history
 * and no state cache -- a silent half-working install, which is worse than
 * refusing to start. This used to say 20.
 */
const [major, minor] = process.versions.node.split('.').map(Number);
if (major > 22 || (major === 22 && minor >= 5)) ok('node', process.version);
else
  bad(
    `node ${process.version} is too old for node:sqlite`,
    hint('brew install node', 'winget install OpenJS.NodeJS.LTS') + '  (need v22.5+; history and search silently do nothing below it)',
  );

if (fs.existsSync(path.join(miniapp, 'node_modules'))) ok('dependencies installed');
else bad('dependencies are not installed', 'cd miniapp && npm install');

// --- 2. build outputs -----------------------------------------------------
section('Build');

const serverEntry = path.join(miniapp, 'server/dist/index.js');
if (fs.existsSync(serverEntry)) ok('server built');
else bad('server is not built', 'cd miniapp/server && npm run build');

const webIndex = path.join(miniapp, 'web/dist/index.html');
if (fs.existsSync(webIndex)) ok('web app built');
else bad('web app is not built', 'cd miniapp/web && npm run build');

// --- 3. what the server will read -----------------------------------------
section('Configuration');

let config = null;
try {
  const mod = await import(pathToFileURL(path.join(miniapp, 'server/dist/config.js')).href);
  ok('Aside data folder', mod.asideHome());
  config = mod.loadConfig();
  ok(config.standalone ? 'standalone mode (no Telegram)' : 'Telegram mode', `port ${config.port}`);
} catch (err) {
  bad(`config could not be loaded: ${err.message}`, 'this should not happen; open an issue with this output');
}

if (config) {
  const bare = !/[\\/]/.test(config.asideCli);
  if (bare ? onPath(config.asideCli) : fs.existsSync(config.asideCli)) ok('Aside CLI found', config.asideCli);
  else
    bad(
      `no Aside CLI at ${config.asideCli}`,
      hint(
        'install Aside from https://aside.com and sign in, or set MINIAPP_ASIDE_CLI',
        'install the Aside app from https://aside.com/download, then the CLI (Aside Settings > Developer, or the signed PowerShell installer on https://docs.aside.com/help/developers); open a new terminal',
      ),
    );

  if (fs.existsSync(path.dirname(config.sessionsDir))) ok('Aside account folder found', path.dirname(config.sessionsDir));
  else
    warn(
      `no Aside account folder at ${path.dirname(config.sessionsDir)}`,
      hint('sign in to Aside first', 'sign in to Aside first; if it lives elsewhere, set ASIDE_HOME to the folder that holds accounts.json'),
    );

  if (fs.existsSync(config.sessionsDir)) ok('Aside sessions directory found');
  else warn('no sessions directory yet', 'normal on a fresh Aside install; it appears after your first task');

  if (fs.existsSync(config.secretPath) && WIN) {
    // Windows has no Unix modes; the file sits in the user profile, which only this user (and admins) can read.
    ok('signing secret present', 'protected by your Windows user profile');
  } else if (fs.existsSync(config.secretPath)) {
    const mode = fs.statSync(config.secretPath).mode & 0o777;
    if (mode === 0o600) ok('signing secret present and private');
    else bad(`signing secret is mode ${mode.toString(8)}`, `chmod 600 ${config.secretPath}`);
  } else {
    warn('no signing secret yet', 'the server writes one on first start');
  }
}

// --- 4. is it running -----------------------------------------------------
section('Runtime');

const port = config?.port ?? 8790;
const pairPort = Number(process.env.MINIAPP_PAIR_PORT) || port + 1;

const health = await httpStatus(`http://127.0.0.1:${port}/api/health`);
if (health === 200) {
  ok(`server responding on ${port}`);

  const pair = await httpRaw(`http://127.0.0.1:${pairPort}/pair`);
  if (pair.status === 200) ok(`pairing page on ${pairPort}`);
  else runtimeBad(`pairing page not answering on ${pairPort}`, 'restart the server; check nothing else holds that port');

  const leak = await httpStatus(`http://127.0.0.1:${port}/pair`);
  if (leak === 403) ok('pairing page refused on the proxied port, as it must be');
  else if (leak === 404) warn('no /pair route on the app port', 'expected when the web app is not built');
  else runtimeBad(`/pair on the app port returned ${leak}, expected 403`, 'this is the tailnet pairing leak; do not expose this server');

  /*
   * iPhone cannot pair by scanning: an installed web app has storage
   * separate from the Safari tab it was installed from, so it has to be
   * installed first and then handed the link by paste. A pairing page that
   * renders only a QR has nothing to paste, which is where the documented
   * iPhone install used to dead-end.
   */
  if (pair.status === 200) {
    if (pair.body.includes('#pair=') && pair.body.includes('<input')) {
      ok('pairing link is copyable, which iPhone needs');
    } else {
      runtimeBad('pairing page has no copyable link', 'running an old build; rebuild and restart');
    }
  }

  /*
   * `/` used to serve the Telegram build: a script from telegram.org and no
   * manifest link, so iOS Add to Home Screen made a bookmark rather than an
   * installed app. This is also the cheapest way to notice that the running
   * server is an older build than the checkout.
   */
  if (config?.standalone) {
    const root = await httpRaw(`http://127.0.0.1:${port}/`);
    if (root.status === 302 && root.location === '/app') {
      ok('/ redirects to the standalone app');
    } else if (root.body.includes('telegram.org/js')) {
      runtimeBad('/ serves the Telegram build', 'running an old build; rebuild and restart the server');
    } else if (root.status === 0) {
      warn('could not read /', 'server answered health but not the root');
    } else {
      warn(`/ returned ${root.status}`, 'expected a 302 to /app in standalone mode');
    }
  }
} else {
  warn(`server is not running on ${port}`, 'start it: npm run service  (or npm start in the foreground)');
}

// --- 5. the network the phone needs ---------------------------------------
section('Tailscale');

let tailnetHost = '';
const tsCandidates = [
  process.env.TAILSCALE_CLI,
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  '/usr/local/bin/tailscale',
  '/opt/homebrew/bin/tailscale',
  'C:\\Program Files\\Tailscale\\tailscale.exe',
];
/*
 * A machine can have more than one Tailscale CLI and more than one daemon,
 * and the wrong pairing simply errors. Some installs run a userspace
 * tailscaled on a socket of their own, which the CLI will not find unless
 * it is told, and the App Store binary cannot drive a Homebrew daemon at
 * all. Picking the first binary on disk and hoping reported "could not read
 * Tailscale status" on a machine whose tailnet was working perfectly.
 *
 * So try the combinations and keep the first that answers, rather than
 * guessing which one is real.
 */
const sockCandidates = [
  path.join(os.homedir(), '.aside-mobile/tailscale/ts.sock'),
  path.join(os.homedir(), '.aside-telegram-bridge/tailscale/ts.sock'),
];
const socks = [...sockCandidates.filter((p) => fs.existsSync(p)), null];

let ts = null;
let tsArgs = [];
let status = null;
for (const bin of [...new Set(tsCandidates.filter((p) => p && fs.existsSync(p)))]) {
  for (const sock of socks) {
    const args = sock ? ['--socket', sock] : [];
    try {
      const parsed = JSON.parse(sh(bin, [...args, 'status', '--json']));
      if (!parsed?.Self) continue;
      ts = bin;
      tsArgs = args;
      status = parsed;
      break;
    } catch {
      // Wrong binary for this daemon, or no daemon on that socket.
    }
  }
  if (status) break;
}

if (!tsCandidates.some((p) => p && fs.existsSync(p))) {
  warn('Tailscale not found', hint('brew install --cask tailscale', 'winget install Tailscale.Tailscale') + ', then sign in on this computer and the phone (skip this if you use the Cloudflare front door)');
} else if (!status) {
  warn('could not read Tailscale status', 'is any tailscaled running (Tailscale.app or a userspace daemon)?');
} else {
  tailnetHost = String(status?.Self?.DNSName || '').replace(/\.$/, '');
  if (tailnetHost) ok('tailnet hostname', tailnetHost);
  else warn('Tailscale is installed but this Mac has no hostname yet', 'sign in: tailscale up (add --socket <path> for a userspace daemon)');
  ok('tailscale answers via', `${ts}${tsArgs.length ? ` ${tsArgs.join(' ')}` : ' (default socket)'}`);
  if (process.platform === 'darwin' && !fs.existsSync('/Applications/Tailscale.app/Contents/MacOS/Tailscale')) {
    // Neutral here on purpose: a Homebrew/userspace setup serves the
    // tailnet fine. Whether PUBLIC Funnel works on it is decided by the
    // probe below, and only a failing probe earns the variant warning.
    ok('tailscale runs without Tailscale.app', tsArgs.includes('--socket') ? 'Homebrew CLI + userspace daemon socket' : 'Homebrew CLI, default socket');
  }

  try {
    const serve = sh(ts, [...tsArgs, 'serve', 'status']);
    if (serve.includes(String(port))) ok(`tailscale serve points at ${port}`);
    else runtimeBad('tailscale serve is not pointing at this server', `${ts} serve --bg ${port}`);
    if (serve.includes(String(pairPort))) {
      bad(
        `tailscale serve exposes the pairing port ${pairPort}`,
        `remove that rule now: ${ts} serve --https=443 off`,
      );
    }
  } catch {
    warn('could not read the tailscale serve config', `${ts} serve status`);
  }
}

// --- 5b. the public relays the phone actually uses -------------------------
section('Public relays');

const relayFunnelOn = config?.miniapp?.relayFunnel !== false;
const relayNgrokOn = config?.miniapp?.relayNgrok !== false;
if (!relayFunnelOn) warn('funnel relay is disabled in config', 'miniapp.relay_funnel or MINIAPP_RELAY_FUNNEL=0');
if (!relayNgrokOn) warn('ngrok relay is disabled in config', 'miniapp.relay_ngrok or MINIAPP_RELAY_NGROK=0');

if (relayFunnelOn) {
  if (!status) {
    warn('cannot verify funnel: Tailscale status unreadable', 'start a tailscaled (Tailscale.app or your userspace daemon), then rerun the doctor');
  } else {
    let servesAppPort = false;
    try {
      const doc = JSON.parse(sh(ts, [...tsArgs, 'serve', 'status', '--json']));
      const funnelOn = doc?.AllowFunnel && Object.keys(doc.AllowFunnel).length > 0;
      let ours = false;
      const web = doc?.Web || {};
      for (const site of Object.values(web)) {
        for (const handler of Object.values(site?.Handlers || {})) {
          if (typeof handler?.Proxy === 'string' && handler.Proxy.endsWith(`:${port}`)) ours = true;
          if (typeof handler?.Proxy === 'string' && handler.Proxy.endsWith(`:${pairPort}`)) {
            bad(`a tailscale rule exposes the pairing port ${pairPort}`, `remove that rule now: ${ts} serve reset`);
          }
        }
      }
      if (ours && funnelOn && tailnetHost) {
        ok('funnel serves this server', `https://${tailnetHost}`);
        servesAppPort = true;
      }
      else if (ours && !funnelOn) warn('app port is served to the tailnet only, not funneled', 'the server enables funnel itself when relay_funnel is on; if it stays off, enable Funnel in the Tailscale admin console');
      else runtimeBad('funnel is not serving this server yet', 'start the server and give it 30s to verify, then rerun the doctor');
    } catch (err) {
      const msg = String(err?.message || '');
      if (/funnel/i.test(msg) && /not enabled|no-funnel/i.test(msg)) {
        warn('funnel is not enabled for this tailnet', 'Tailscale admin console -> Settings -> Funnel: On');
      } else {
        warn('could not read the funnel status', `${ts} serve status --json`);
      }
    }
    /*
     * The config is only half the story: serve status has said Funnel is
     * on while the public TLS handshake stalled with zero bytes and no
     * phone request ever arrived. Walk the phone's path for real --
     * public DNS, TCP, TLS with SNI, /api/health -- and fail LOUD when
     * the URL the pairing page prints does not answer.
     */
    if (servesAppPort) {
      try {
        const { verifyPublicEndpoint } = await import(pathToFileURL(path.join(miniapp, 'server/dist/publicprobe.js')).href);
        const probe = await verifyPublicEndpoint(`https://${tailnetHost}`, { timeoutMs: 12000 });
        if (probe.ok) {
          ok('funnel answers over the public internet', `${probe.viaIp}${probe.publicPath ? '' : ' (tailnet path only)'}`);
          if (!probe.publicPath) {
            warn('the probe tested the tailnet path, not the public one', 'public DNS did not answer here; confirm from a phone off the tailnet');
          }
        } else {
          const noApp =
            process.platform === 'darwin' &&
            !fs.existsSync('/Applications/Tailscale.app/Contents/MacOS/Tailscale');
          const fix =
            probe.stage === 'dns'
              ? 'public DNS has no record yet (up to ~10 min after enabling) or the name is wrong; wait and rerun'
              : probe.stage === 'tcp'
                ? `the Funnel edge is unreachable from here (${probe.viaIp}); check this Mac's internet route, then rerun`
                : probe.stage === 'tls' && noApp
                  ? 'public TLS never completes and this Mac has no Tailscale.app (Homebrew/userspace daemon): Funnel port-sharing on macOS requires the App Store or Standalone app'
                  : probe.stage === 'tls'
                    ? `public TLS fails (${probe.detail}); check tailnet HTTPS certificates: ${ts} cert ${tailnetHost}`
                    : `the relay answers but not as this app (${probe.detail}); look for another serve rule on 443: ${ts} serve status`;
          runtimeBad(`funnel does not answer: ${probe.stage}: ${probe.detail}`, fix);
        }
      } catch (err) {
        warn('could not probe the public URL', `is the server built? ${err.message}`);
      }
    }
  }
}

if (relayNgrokOn) {
  const ngrokDomain = String(config?.miniapp?.ngrokDomain || '');
  const ngrokToken = String(process.env.NGROK_AUTHTOKEN || config?.miniapp?.ngrokAuthtoken || '');
  let ngrokBin = process.env.NGROK_BIN || 'ngrok';
  try {
    sh(ngrokBin, ['version']);
    ok('ngrok installed', ngrokBin);
  } catch {
    warn('ngrok not found', hint('brew install ngrok', 'winget install ngrok.ngrok') + '; optional, the other relays work without it');
    ngrokBin = '';
  }
  if (!ngrokDomain) warn('no ngrok static domain configured', 'reserve one free at ngrok.com, then set miniapp.ngrok_domain');
  else ok('ngrok static domain', ngrokDomain);
  if (!ngrokToken) warn('NGROK_AUTHTOKEN is not set', 'free at ngrok.com; export it where the server runs');
  if (ngrokBin && ngrokDomain && ngrokToken) {
    try {
      const res = await fetch('http://127.0.0.1:4040/api/tunnels');
      const doc = await res.json();
      const urls = (doc?.tunnels || []).map((x) => x?.public_url).filter(Boolean);
      if (urls.includes(`https://${ngrokDomain}`)) ok('ngrok tunnel is up', `https://${ngrokDomain}`);
      else warn('ngrok is configured but its tunnel is not up', 'the server starts it; check the server log for [ngrok]');
    } catch {
      warn('ngrok agent API is not answering', 'the server starts ngrok itself; check the server log for [ngrok]');
    }
  }
}

// --- 6. background service -----------------------------------------------
section('Background service');

if (WIN) {
  const { runnerPid, readService, logDir } = await import(pathToFileURL(path.join(here, 'winservice.mjs')).href);
  const pid = runnerPid();
  const jobs = Object.keys(readService().jobs);
  if (pid) ok('login runner is running', `pid ${pid}; jobs: ${jobs.join(', ') || 'none'}`);
  else runtimeBad('login runner is not running', 'npm run service');
  if (jobs.includes('frontdoor')) ok('front door supervisor is configured');
  else warn('no front door configured', 'npm run frontdoor  (or use Tailscale)');
  ok('logs', logDir());
} else if (process.platform === 'darwin') {
  const plist = path.join(os.homedir(), 'Library/LaunchAgents/com.aside.mobile.plist');
  if (fs.existsSync(plist)) ok('launchd job installed', plist);
  else runtimeBad('no launchd job', 'npm run service');
  if (fs.existsSync(path.join(os.homedir(), 'Library/LaunchAgents/com.aside.frontdoor.plist'))) ok('front door supervisor installed');
  else warn('no front door configured', 'npm run frontdoor  (or use Tailscale)');
} else {
  warn('no background service support on this platform', 'run npm start under your own service manager');
}

// --- verdict --------------------------------------------------------------
console.log('');
if (failures === 0 && warnings === 0) console.log('All checks passed.');
else console.log(`${failures} failure(s), ${warnings} warning(s).`);
if (!setupOnly && failures === 0 && health === 200 && tailnetHost) {
  console.log(`\nNext: open http://127.0.0.1:${pairPort}/pair on this computer and pair your phone.`);
}
process.exit(Math.min(failures, 125));
