#!/usr/bin/env node
/**
 * Windows port of supervisor.sh (macOS keeps the bash original). Same job:
 * keep a Cloudflare quick tunnel to the app alive and tell the front-door
 * Worker its current hostname. Run as a job by win-runner.mjs.
 *
 * Outbound-only HTTPS (http2 over 443): no port is opened on this machine.
 * When the network path changes (VPN, Wi-Fi, wake) the tunnel's single
 * connection can die silently, so a change triggers a make-before-break
 * rebuild: new tunnel up and verified, Worker switched, then the old one
 * stopped.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const frontdoorDir = (env = process.env) =>
  env.FRONTDOOR_DIR || path.join(env.MINIAPP_STATE_DIR || path.join(os.homedir(), '.aside-mobile'), 'front-door');

const say = (m) => console.log(`${new Date().toISOString()} ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * A real quick-tunnel host is a hyphenated slug (brave-otter-12...). Requiring
 * the hyphen skips api.trycloudflare.com, which cloudflared prints in its own
 * error text when registration fails (same rule as server/src/tunnel.ts).
 */
export const TUNNEL_URL_RE = /https:\/\/[a-z0-9]+(?:-[a-z0-9]+)+\.trycloudflare\.com/;

/** Changes whenever the way out changes: interfaces and their addresses. */
export function netSig(ifaces = os.networkInterfaces()) {
  const parts = [];
  for (const [name, list] of Object.entries(ifaces)) {
    for (const a of list || []) if (!a.internal) parts.push(`${name}=${a.address}`);
  }
  return parts.sort().join('|');
}

async function getText(url, { ip, timeoutMs = 8000, headers = {} } = {}) {
  const u = new URL(url);
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'GET',
        headers,
        timeout: timeoutMs,
        servername: u.hostname,
        // Some VPN resolvers negative-cache brand-new hostnames: when we
        // already resolved it over DNS-over-HTTPS, connect to that IP.
        ...(ip ? { lookup: (_h, opts, cb) => (opts && opts.all ? cb(null, [{ address: ip, family: 4 }]) : cb(null, ip, 4)) } : {}),
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c.length < 65536 ? c : ''));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.end();
  });
}

async function dohA(host) {
  const r = await getText(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=A`, {
    headers: { accept: 'application/dns-json' },
    timeoutMs: 5000,
  });
  try {
    return (JSON.parse(r.body).Answer || []).map((a) => a.data).find((d) => /^\d+\.\d+\.\d+\.\d+$/.test(d)) || null;
  } catch {
    return null;
  }
}

const healthy = (r) => r.status === 200 && r.body.includes('"ok":true');

async function tunnelOk(url) {
  const ip = await dohA(new URL(url).hostname);
  return healthy(await getText(`${url}/api/health`, { ip }));
}

export class Supervisor {
  constructor({ dir = frontdoorDir(), log = say } = {}) {
    this.dir = dir;
    this.log = log;
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'frontdoor.json'), 'utf8'));
    this.front = String(cfg.front).replace(/\/+$/, '');
    this.cf = cfg.cf;
    this.local = cfg.local || 'http://127.0.0.1:8790';
    this.secret = fs.readFileSync(path.join(dir, 'secret'), 'utf8').trim();
    this.child = null;
    this.url = '';
  }

  async publish() {
    try {
      const res = await fetch(`${this.front}/__frontdoor/origin`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.secret}`, 'content-type': 'application/json' },
        body: JSON.stringify({ url: this.url }),
        signal: AbortSignal.timeout(20_000),
      });
      return res.status;
    } catch {
      return 0;
    }
  }

  /** New tunnel, verified end to end, Worker switched, then the old one stopped. */
  async rebuild() {
    const child = spawn(this.cf, ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', this.local], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    const grab = (c) => {
      if (out.length < 200_000) out += c;
    };
    child.stdout.on('data', grab);
    child.stderr.on('data', grab);
    let alive = true;
    child.on('exit', () => (alive = false));
    child.on('error', () => (alive = false));

    let url = '';
    for (let i = 0; i < 60 && alive && !url; i++) {
      url = (TUNNEL_URL_RE.exec(out) || [''])[0];
      if (!url) await sleep(1000);
    }
    if (!url) {
      this.log('new tunnel gave no URL');
      child.kill();
      return false;
    }
    let ok = 0;
    for (let i = 0; i < 45 && alive && ok < 3; i++) {
      ok = (await tunnelOk(url)) ? ok + 1 : 0;
      if (ok < 3) await sleep(2000);
    }
    const old = this.child;
    if (!alive || (ok < 3 && old)) {
      // Never swap a working tunnel for one that died or never answered.
      this.log(`new tunnel ${alive ? 'never answered' : 'exited'}; keeping the current one`);
      child.kill();
      return false;
    }
    this.child = child;
    this.url = url;
    child.on('exit', () => {
      if (this.child === child) this.child = null;
    });
    let code = 0;
    for (let i = 0; i < 6; i++) {
      code = await this.publish();
      if (code === 200) break;
      await sleep(5000);
    }
    this.log(`tunnel up: ${url} (pid ${child.pid}, ready=${ok}, published=${code})`);
    if (old && old !== child) old.kill();
    return true;
  }

  async loop() {
    let sig = netSig();
    let fails = 0;
    let tick = 0;
    for (;;) {
      if (!this.child) {
        if (!(await this.rebuild())) {
          await sleep(10_000);
          continue;
        }
        fails = 0;
        tick = 0;
        sig = netSig();
      }
      await sleep(15_000);
      tick++;
      const now = netSig();
      if (now !== sig) {
        this.log('network changed; rebuilding tunnel');
        await sleep(4000);
        if (await this.rebuild()) {
          fails = 0;
          tick = 0;
        }
        sig = netSig();
        continue;
      }
      if (tick % 20 === 0) await this.publish();
      // Judge the tunnel only when the app and the internet are both fine.
      const appUp = (await fetch(`${this.local}/api/health`, { signal: AbortSignal.timeout(5000) }).catch(() => null))?.ok;
      const netUp = (await getText('https://www.cloudflare.com/cdn-cgi/trace', { timeoutMs: 8000 })).status === 200;
      if (!appUp || !netUp) continue;
      if ((await tunnelOk(this.url)) && healthy(await getText(`${this.front}/api/health`, { timeoutMs: 12_000 }))) {
        fails = 0;
      } else if (++fails >= 2) {
        this.log('rebuilding stale tunnel');
        if (await this.rebuild()) fails = 0;
      } else {
        this.log(`health check failed (${fails})`);
      }
    }
  }
}

/** A fresh 32-byte hex secret, as the bash installer's `openssl rand -hex 32`. */
export const newSecret = () => crypto.randomBytes(32).toString('hex');

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const s = new Supervisor();
  const stop = () => {
    s.child?.kill();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('SIGBREAK', stop);
  s.loop().catch((err) => {
    say(`supervisor crashed: ${err && err.message}`);
    s.child?.kill();
    process.exit(1);
  });
}
