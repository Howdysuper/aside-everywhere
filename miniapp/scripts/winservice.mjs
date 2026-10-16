#!/usr/bin/env node
/**
 * Windows: keep the server (and the front door, once installed) running
 * across logouts and reboots, without administrator rights.
 *
 *   npm run service              install and start
 *   npm run service -- status    is it running and answering?
 *   npm run service -- restart   restart everything
 *   npm run service -- stop      stop until next login (or `npm run service`)
 *   npm run service -- off       stop and remove from login
 *
 * How it works: `win-runner.mjs` is a small supervisor that starts each job
 * in service.json hidden, restarts it if it exits, and writes its output to
 * %LOCALAPPDATA%\AsideMobile\Logs\<job>.log. A per-user Run entry
 * (HKCU\...\CurrentVersion\Run\AsideMobile) starts the runner at login. No
 * service, no scheduled task, no elevation, nothing machine-wide.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
export const miniapp = path.resolve(here, '..');
export const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
export const RUN_VALUE = 'AsideMobile';

export function stateDir(env = process.env) {
  return env.MINIAPP_STATE_DIR || path.join(os.homedir(), '.aside-mobile');
}
export function serviceDir(env = process.env) {
  return path.join(stateDir(env), 'service');
}
export function serviceFile(env = process.env) {
  return path.join(serviceDir(env), 'service.json');
}
export function pidFile(env = process.env) {
  return path.join(serviceDir(env), 'runner.pid');
}
export function logDir(env = process.env) {
  const base = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'AsideMobile', 'Logs');
}

/**
 * Only documented path/behavior overrides are carried into the background
 * job, never arbitrary variables or tokens. Same list as the macOS plist.
 */
export const FORWARDED = [
  'ASIDE_HOME', 'ASIDE_HISTORY_DB', 'ASIDE_OWNER_TZ', 'ASIDE_TAILNET_HOST', 'TAILSCALE_CLI',
  'NGROK_BIN',
  'MINIAPP_ASIDE_CLI', 'MINIAPP_ASIDE_ROOT', 'MINIAPP_CONFIG',
  'MINIAPP_CREDENTIALS', 'MINIAPP_HOST', 'MINIAPP_LOG', 'MINIAPP_MEDIA_DIR',
  'MINIAPP_NGROK_DOMAIN',
  'MINIAPP_PAIR_PORT', 'MINIAPP_PORT', 'MINIAPP_RELAY_FUNNEL',
  'MINIAPP_RELAY_NGROK', 'MINIAPP_SECRET_PATH',
  'MINIAPP_SESSIONS_DIR', 'MINIAPP_SETTINGS_PATH', 'MINIAPP_SOFT_CONFIRM_PATH',
  'MINIAPP_STATE_DB', 'MINIAPP_STATE_DIR', 'MINIAPP_UPLOADS_DIR',
  'MINIAPP_TUNNEL', 'MINIAPP_TUNNEL_HOSTNAME', 'MINIAPP_CLOUDFLARED_PATH',
  'MINIAPP_WEB_DIST', 'MINIAPP_WHISPER_MODEL',
];

/**
 * Windows' own variables a background job needs to run (PATH, profile and
 * temp folders, ...). Jobs get these plus FORWARDED and nothing else, so a
 * token exported in the shell that ran `npm run service` never reaches them.
 */
export const BASE_ENV = [
  'ALLUSERSPROFILE', 'APPDATA', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)', 'COMMONPROGRAMW6432',
  'COMPUTERNAME', 'COMSPEC', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'NUMBER_OF_PROCESSORS', 'OS',
  'PATH', 'PATHEXT', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'PROGRAMDATA', 'PROGRAMFILES',
  'PROGRAMFILES(X86)', 'PROGRAMW6432', 'PUBLIC', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'TMP',
  'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR',
];

/** The environment a job starts from (names are case-insensitive on Windows). */
export function jobBaseEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    const K = k.toUpperCase();
    if (BASE_ENV.includes(K) || FORWARDED.includes(K)) out[k] = String(v);
  }
  return out;
}

export function pickEnv(env = process.env, extra = {}) {
  const out = {};
  for (const k of FORWARDED) if (env[k] !== undefined) out[k] = String(env[k]);
  for (const [k, v] of Object.entries(extra)) {
    if (!FORWARDED.includes(k)) throw new Error(`not a forwarded setting: ${k}`);
    out[k] = String(v);
  }
  return out;
}

export function readService(env = process.env) {
  try {
    const s = JSON.parse(fs.readFileSync(serviceFile(env), 'utf8'));
    return s && typeof s === 'object' && s.jobs && typeof s.jobs === 'object' ? s : { jobs: {} };
  } catch {
    return { jobs: {} };
  }
}

export function writeService(service, env = process.env) {
  fs.mkdirSync(serviceDir(env), { recursive: true });
  const file = serviceFile(env);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(service, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** The server job. `extraEnv` lets the front-door installer pin its settings. */
export function serverJob(env = process.env, extraEnv = {}, previous = null) {
  return {
    command: process.execPath,
    args: [path.join(miniapp, 'server', 'dist', 'index.js')],
    cwd: path.join(miniapp, 'server'),
    // Keep settings a previous install pinned (the front door's), then
    // layer what this shell exports, then what the caller insists on.
    env: { ...(previous?.env ?? {}), ...pickEnv(env), ...extraEnv },
  };
}

/** PowerShell single-quoted string. */
export const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

/**
 * The login command. node.exe is a console program, so starting it straight
 * from the Run key would leave a console window open all day; PowerShell
 * starts it hidden instead. -Command (not -File) so it works under the
 * default "Restricted" execution policy: no script file runs and no policy
 * is bypassed.
 */
export function runCommand(nodeBin = process.execPath, runner = path.join(here, 'win-runner.mjs')) {
  const ps = `Start-Process -WindowStyle Hidden -FilePath ${psQuote(nodeBin)} -ArgumentList ${psQuote(`"${runner}"`)}`;
  return `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -Command "${ps.replace(/"/g, '\\"')}"`;
}

function sh(cmd, args) {
  try {
    return { ok: true, out: execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }) };
  } catch (err) {
    return { ok: false, out: String(err.stderr || err.message) };
  }
}

/**
 * True when `pid` is really our runner. Windows reuses PIDs, so a stale
 * runner.pid can name an unrelated program; never stop (or defer to) that.
 */
export function isRunnerProcess(pid, platform = process.platform) {
  if (platform !== 'win32') return true;
  const r = sh('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `(Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(pid)}').CommandLine`,
  ]);
  return r.ok && r.out.includes('win-runner.mjs');
}

export function runnerPid(env = process.env) {
  try {
    const pid = Number(fs.readFileSync(pidFile(env), 'utf8').trim());
    if (!Number.isInteger(pid) || pid <= 0) return null;
    process.kill(pid, 0);
    return isRunnerProcess(pid) ? pid : null;
  } catch {
    return null;
  }
}

export function stopRunner(env = process.env) {
  const pid = runnerPid(env);
  if (!pid) return false;
  // /T takes the runner's children (server, tunnel) with it.
  sh('taskkill', ['/PID', String(pid), '/T', '/F']);
  try {
    fs.unlinkSync(pidFile(env));
  } catch {
    /* already gone */
  }
  return true;
}

export function startRunner() {
  const child = spawn(process.execPath, [path.join(here, 'win-runner.mjs')], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

export async function waitHealthy(url, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok && (await res.text()).includes('"ok":true')) return true;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

export function registerLogin() {
  const r = sh('reg', ['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', runCommand(), '/f']);
  if (!r.ok) throw new Error(`could not add the login entry: ${r.out.trim()}`);
}

export function unregisterLogin() {
  sh('reg', ['delete', RUN_KEY, '/v', RUN_VALUE, '/f']);
}

/** (Re)write the server job, (re)start the runner, and wait for health. */
export async function install({ extraEnv = {}, extraJobs = {} } = {}) {
  const entry = path.join(miniapp, 'server', 'dist', 'index.js');
  if (!fs.existsSync(entry)) {
    throw new Error(`server is not built: ${entry}\nrun: npm run build`);
  }
  const service = readService();
  service.jobs.server = serverJob(process.env, extraEnv, service.jobs.server);
  Object.assign(service.jobs, extraJobs);
  writeService(service);
  fs.mkdirSync(logDir(), { recursive: true });
  registerLogin();
  stopRunner();
  startRunner();
  const port = Number(service.jobs.server.env.MINIAPP_PORT || process.env.MINIAPP_PORT) || 8790;
  return { port, up: await waitHealthy(`http://127.0.0.1:${port}/api/health`) };
}

async function main() {
  if (process.platform !== 'win32') {
    console.error('winservice.mjs is for Windows. On macOS use: npm run launchd');
    process.exit(1);
  }
  const cmd = process.argv[2] || 'install';
  const logs = logDir();
  if (cmd === 'off') {
    stopRunner();
    unregisterLogin();
    console.log('Stopped and removed from login. Settings stay in', serviceFile());
    return;
  }
  if (cmd === 'stop') {
    console.log(stopRunner() ? 'stopped' : 'was not running');
    return;
  }
  if (cmd === 'status') {
    const pid = runnerPid();
    const port = Number(readService().jobs.server?.env?.MINIAPP_PORT) || 8790;
    const up = await waitHealthy(`http://127.0.0.1:${port}/api/health`, 2000);
    console.log(`runner: ${pid ? `running (pid ${pid})` : 'not running'}`);
    console.log(`server: ${up ? `answering on ${port}` : 'not answering'}`);
    console.log(`jobs:   ${Object.keys(readService().jobs).join(', ') || 'none'}`);
    console.log(`logs:   ${logs}`);
    process.exit(pid && up ? 0 : 1);
  }
  if (cmd === 'restart') {
    stopRunner();
    startRunner();
    const port = Number(readService().jobs.server?.env?.MINIAPP_PORT) || 8790;
    const up = await waitHealthy(`http://127.0.0.1:${port}/api/health`);
    console.log(up ? `restarted; answering on ${port}` : `restarted, but nothing answered on ${port}; see ${logs}`);
    process.exit(up ? 0 : 1);
  }
  if (cmd !== 'install') {
    console.error(`unknown command: ${cmd} (install | status | restart | stop | off)`);
    process.exit(2);
  }
  const { port, up } = await install();
  if (up) {
    console.log(`Aside Mobile is running and answering on ${port}. It starts again at every login.`);
    console.log(`logs: ${logs}`);
  } else {
    console.error(`Started, but nothing answered on ${port} within 20 s. Check ${path.join(logs, 'server.log')}`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
