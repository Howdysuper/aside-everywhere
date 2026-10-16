#!/usr/bin/env node
/**
 * The Windows stand-in for launchd's KeepAlive. Started hidden at login by
 * the Run entry that `npm run service` writes (see winservice.mjs).
 *
 *  - One copy at a time (runner.pid).
 *  - Starts every job in service.json hidden, restarts it when it exits
 *    (10 s, backing off to 60 s if it keeps dying fast).
 *  - Re-reads service.json every 5 s: a changed job is restarted with its
 *    new settings, a removed job is stopped. That is how the front-door
 *    installer and its config guard repair the server's settings.
 *  - Each job's output goes to %LOCALAPPDATA%\AsideMobile\Logs\<job>.log,
 *    rotated at 2 MB (one .1 kept).
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { jobBaseEnv, logDir, pidFile, readService, runnerPid, serviceDir } from './winservice.mjs';

const MAX_LOG = 2 * 1024 * 1024;

const other = runnerPid();
if (other && other !== process.pid) process.exit(0);
fs.mkdirSync(serviceDir(), { recursive: true });
fs.writeFileSync(pidFile(), String(process.pid));
fs.mkdirSync(logDir(), { recursive: true });

/** @type {Map<string, {def: string, child: import('node:child_process').ChildProcess | null, startedAt: number, delay: number, nextAt: number}>} */
const jobs = new Map();

function logWriter(name) {
  const file = path.join(logDir(), `${name.replace(/[^\w.-]/g, '_')}.log`);
  return (chunk) => {
    try {
      const st = fs.statSync(file, { throwIfNoEntry: false });
      if (st && st.size > MAX_LOG) fs.renameSync(file, `${file}.1`);
      fs.appendFileSync(file, chunk);
    } catch {
      /* logging must never take a job down */
    }
  };
}

function stamp(name, msg) {
  logWriter(name)(`${new Date().toISOString()} [runner] ${msg}\n`);
}

function start(name, job) {
  const def = JSON.parse(job.def);
  const write = logWriter(name);
  let child;
  try {
    child = spawn(def.command, def.args || [], {
      cwd: def.cwd || undefined,
      // Windows basics plus the job's own settings, never the whole shell this was started from.
      env: { ...jobBaseEnv(), ...(def.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (err) {
    stamp(name, `could not start: ${err.message}`);
    job.nextAt = Date.now() + job.delay;
    return;
  }
  job.child = child;
  job.startedAt = Date.now();
  stamp(name, `started pid ${child.pid}`);
  child.stdout.on('data', write);
  child.stderr.on('data', write);
  child.on('error', (err) => stamp(name, `error: ${err.message}`));
  child.on('exit', (code, signal) => {
    if (job.child !== child) return;
    job.child = null;
    const quick = Date.now() - job.startedAt < 30_000;
    job.delay = quick ? Math.min(job.delay * 2, 60_000) : 10_000;
    job.nextAt = Date.now() + job.delay;
    stamp(name, `exited (${signal || code}); restarting in ${Math.round(job.delay / 1000)} s`);
  });
}

function stop(job) {
  const c = job.child;
  job.child = null;
  if (c && c.exitCode === null) {
    // kill() on Windows ends only this process. /T also ends what it started,
    // so stopping the front door never leaves its cloudflared tunnel running.
    if (process.platform === 'win32' && c.pid) {
      try {
        execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        return;
      } catch {
        /* fall through */
      }
    }
    try {
      c.kill();
    } catch {
      /* already gone */
    }
  }
}

function tick() {
  const wanted = readService().jobs;
  for (const [name, job] of jobs) {
    if (!wanted[name]) {
      stamp(name, 'removed from service.json; stopping');
      stop(job);
      jobs.delete(name);
    }
  }
  for (const [name, def] of Object.entries(wanted)) {
    if (!def || typeof def.command !== 'string') continue;
    const text = JSON.stringify(def);
    let job = jobs.get(name);
    if (!job) {
      job = { def: text, child: null, startedAt: 0, delay: 10_000, nextAt: 0 };
      jobs.set(name, job);
    } else if (job.def !== text) {
      stamp(name, 'settings changed; restarting');
      job.def = text;
      stop(job);
      job.delay = 10_000;
      job.nextAt = 0;
    }
    if (!job.child && Date.now() >= job.nextAt) start(name, job);
  }
}

function shutdown() {
  for (const job of jobs.values()) stop(job);
  try {
    if (Number(fs.readFileSync(pidFile(), 'utf8')) === process.pid) fs.unlinkSync(pidFile());
  } catch {
    /* fine */
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGBREAK', shutdown);

tick();
setInterval(tick, 5000);
