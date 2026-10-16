#!/usr/bin/env node
/**
 * Windows version of install.sh: one command for a permanent phone address.
 *
 *   phone ──https──> <name>.<you>.workers.dev (Cloudflare Worker, free)
 *                         │ forwards to the current
 *                         ▼
 *                    Cloudflare quick tunnel (free, rotates) ──> this PC :8790
 *
 * Usage (from miniapp\):  npm run frontdoor            install or update
 *                         npm run frontdoor -- off     remove from this PC
 * Safe to re-run. Needs a free Cloudflare account; no domain, no card.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { frontdoorDir, newSecret } from './supervisor.mjs';
import { install, readService, waitHealthy, writeService } from '../scripts/winservice.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const miniapp = path.dirname(here);
const NAME = process.env.FRONTDOOR_NAME || 'aside-frontdoor';
// An exact, tested wrangler release (it runs with your Cloudflare login), never "latest 4.x".
const WRANGLER = 'wrangler@4.142.0';
const PINS = { MINIAPP_TUNNEL: 'external', MINIAPP_RELAY_FUNNEL: '0', MINIAPP_RELAY_NGROK: '0' };

const step = (s) => console.log(`\n== ${s}`);
function die(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

/*
 * This machine: npm .cmd shims (npx, tsc, ...) all fail with "The system
 * cannot find the path specified", so wrangler runs as node + the pinned
 * package's js entry from a private install under the state dir. Every
 * argument here is fixed or validated, same as before.
 */
const wranglerJs = path.join(os.homedir(), '.aside-mobile', 'wrangler-pkg',
  'node_modules', 'wrangler', 'bin', 'wrangler.js');
function wrangler(args, opts = {}) {
  return spawnSync(process.execPath, [wranglerJs, ...args], {
    cwd: here,
    encoding: 'utf8',
    ...opts,
  });
}

if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(NAME)) die(`FRONTDOOR_NAME must be lowercase letters, digits and dashes: ${NAME}`);
if (process.platform !== 'win32') die('install.mjs is the Windows installer. On macOS run: npm run frontdoor');

const D = frontdoorDir();

if (process.argv.includes('off')) {
  const service = readService();
  delete service.jobs.frontdoor;
  if (service.jobs.server?.env) {
    for (const k of [...Object.keys(PINS), 'MINIAPP_TUNNEL_HOSTNAME']) delete service.jobs.server.env[k];
  }
  writeService(service);
  console.log('Removed the front door from this PC (the server restarts without it in a few seconds).');
  console.log(`The Worker stays in your Cloudflare account; delete it there (or: cd "${here}" && npx wrangler delete --name ${NAME}).`);
  process.exit(0);
}

if (!fs.existsSync(path.join(miniapp, 'server', 'dist', 'index.js'))) die('the server is not built. Run: npm run build');

step('cloudflared (pinned release, SHA-256 checked)');
const { ensureCloudflared } = await import(pathToFileURL(path.join(miniapp, 'server', 'dist', 'tunnel.js')).href);
const stateDir = process.env.MINIAPP_STATE_DIR || path.join(os.homedir(), '.aside-mobile');
const CF = process.env.MINIAPP_CLOUDFLARED_PATH || (await ensureCloudflared(path.join(stateDir, 'bin'), (m) => console.log(m)));
console.log(`using ${CF}`);

step('Cloudflare login');
if (!/You are logged in/.test(String(wrangler(['whoami']).stdout))) {
  console.log('A browser window will open. Sign in or create a free Cloudflare account.');
  if (wrangler(['login'], { stdio: 'inherit' }).status !== 0) die('Cloudflare login did not finish.');
}

step(`Deploy the Worker (${NAME})`);
const dep = wrangler(['deploy', '--name', NAME]);
const depOut = `${dep.stdout || ''}${dep.stderr || ''}`;
if (dep.status !== 0) {
  console.log(depOut);
  die('deploy failed. If it mentions a workers.dev subdomain, open the Cloudflare dashboard > Workers & Pages once to claim one, then rerun.');
}
const FRONT = (/https:\/\/[A-Za-z0-9.-]+\.workers\.dev/.exec(depOut) || [])[0];
if (!FRONT) {
  console.log(depOut);
  die('could not read the workers.dev URL from the deploy output.');
}
console.log(`permanent address: ${FRONT}`);

step('Shared secret');
fs.mkdirSync(D, { recursive: true, mode: 0o700 });
const secretFile = path.join(D, 'secret');
let fresh = false;
if (!fs.existsSync(secretFile) || !fs.readFileSync(secretFile, 'utf8').trim()) {
  fs.writeFileSync(secretFile, newSecret(), { mode: 0o600 });
  fresh = true;
}
// Always (re)send it: a fresh or renamed Worker has no secret yet.
const put = wrangler(['secret', 'put', 'UPDATE_SECRET', '--name', NAME], { input: fs.readFileSync(secretFile, 'utf8').trim() });
if (put.status !== 0) die(`could not store the secret on the Worker:\n${put.stdout}${put.stderr}`);
console.log(`stored (local copy: ${secretFile}, readable only by your Windows user)${fresh ? ', newly generated' : ''}`);

step('Point the app server at the front door and start everything');
const port = Number(process.env.MINIAPP_PORT) || 8790;
fs.writeFileSync(path.join(D, 'frontdoor.json'), JSON.stringify({ front: FRONT, cf: CF, local: `http://127.0.0.1:${port}` }, null, 2));
const { up } = await install({
  extraEnv: { ...PINS, MINIAPP_TUNNEL_HOSTNAME: FRONT.replace(/^https:\/\//, '') },
  extraJobs: {
    frontdoor: { command: process.execPath, args: [path.join(here, 'supervisor.mjs')], cwd: here, env: {} },
  },
});
if (!up) die('the app server did not start. Check %LOCALAPPDATA%\\AsideMobile\\Logs\\server.log');

step(`Waiting for ${FRONT} (up to ~2 minutes)`);
if (await waitHealthy(`${FRONT}/api/health`, 120_000)) {
  console.log(`\nReady. Your phone web address is ${FRONT}/app`);
  console.log(`Pair a phone: open http://127.0.0.1:${process.env.MINIAPP_PAIR_PORT || 8791}/pair on this PC and scan the QR code.`);
  process.exit(0);
}
die('not reachable yet. Check %LOCALAPPDATA%\\AsideMobile\\Logs\\frontdoor.log and server.log');
