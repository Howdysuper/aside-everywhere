/*
 * Front door for the Aside mobile app.
 *
 * The phone only ever knows this Worker's fixed workers.dev URL. Behind it,
 * the Mac runs a Cloudflare quick tunnel whose hostname rotates on every
 * restart; the Mac's supervisor reports each new hostname to
 * POST /__frontdoor/origin (bearer secret), stored in a Durable Object
 * (strongly consistent, unlike KV's ~60s edge staleness). Everything else is
 * proxied verbatim, WebSockets included. Auth, pairing and sessions are all
 * enforced by the Mac app itself; this layer adds no trust.
 *
 * Push scheduling (2026-10-14): the Mac's server owns every decision, but it
 * sleeps. While awake it uploads the current push plan (jobs, subscriptions,
 * dedupe ledger) to POST /__frontdoor/push-schedule; a once-a-minute cron
 * fires due jobs so reminders go out even when the computer is off. The
 * machine stays the boss: a fresh heartbeat (< 4 min) makes the cron stand
 * down, and the Mac merges the worker's "fired" ledger into its own dedupe
 * state, so nothing is ever sent twice. Payloads are encrypted here with
 * push-crypto.js (RFC 8291/8292, WebCrypto); the VAPID private key lives in
 * the VAPID_JWK secret of this Worker (the user's own Cloudflare account).
 */
import { DurableObject } from 'cloudflare:workers';
import { deliver } from './push-crypto.js';

const CONTROL = '/__frontdoor/';
// Hyphenated quick-tunnel slugs only: never api./www. infrastructure hosts.
const TUNNEL_RE = /^https:\/\/[a-z0-9]+(?:-[a-z0-9]+)+\.trycloudflare\.com$/;
// Rotations are rare and a dead origin triggers a fresh read anyway, so a
// long memo just saves a Durable Object round trip on almost every request.
const MEMO_MS = 60_000;
// Content-hashed build output never changes under the same name.
const EDGE_CACHEABLE = /^\/(assets|art|icons|splash)\//;

// Push scheduling: a heartbeat newer than this means the machine is awake
// and delivering its own notifications; the cron steps aside.
const AWAKE_STANDDOWN_MS = 4 * 60_000;
// Same threshold as the server's sync-stall rule: no Schoology refresh for
// 26h means the computer is off or Schoology needs a re-login.
const STALL_AFTER_MS = 26 * 3600_000;
const VAPID_SUBJECT = 'mailto:shaurya.nadagoudra@gmail.com';

let memo = null;
let memoAt = 0;

/** One global instance holds the current origin; reads/writes are strongly consistent. */
export class OriginStore extends DurableObject {
  async read() {
    return (await this.ctx.storage.get('origin')) || null;
  }
  async write(url) {
    const record = { url, at: new Date().toISOString() };
    await this.ctx.storage.put('origin', record);
    return record;
  }
  // Last 60 non-asset requests (no bodies, no headers, no tokens) for debugging.
  async log(entry) {
    const list = (await this.ctx.storage.get('log')) || [];
    list.push(entry);
    await this.ctx.storage.put('log', list.slice(-60));
  }
  async readLog() {
    return (await this.ctx.storage.get('log')) || [];
  }

  // ---- Push schedule (worker-side firing while the computer sleeps) ----
  async putPushDoc(doc) {
    const record = { ...doc, uploadedAt: Date.now() };
    await this.ctx.storage.put('push:doc', record);
    return record;
  }
  async getPushDoc() {
    return (await this.ctx.storage.get('push:doc')) || null;
  }
  async putFired(id, at) {
    await this.ctx.storage.put('push:fired:' + id, at);
  }
  async getFired() {
    const out = {};
    const list = await this.ctx.storage.list({ prefix: 'push:fired:' });
    for (const [k, v] of list) out[k.slice('push:fired:'.length)] = v;
    return out;
  }
  async pruneFired(cutoff) {
    const list = await this.ctx.storage.list({ prefix: 'push:fired:' });
    const dead = [...list].filter(([, v]) => v < cutoff).map(([k]) => k);
    await Promise.all(dead.map((k) => this.ctx.storage.delete(k)));
  }
  async putDead(endpoint) {
    await this.ctx.storage.put('push:dead:' + endpoint, Date.now());
  }
  async getDead() {
    const out = [];
    const list = await this.ctx.storage.list({ prefix: 'push:dead:' });
    for (const k of list.keys()) out.push(k.slice('push:dead:'.length));
    return out;
  }
  async getStallDay() {
    return (await this.ctx.storage.get('push:stallDay')) || '';
  }
  async setStallDay(day) {
    await this.ctx.storage.put('push:stallDay', day);
  }
}

const store = (env) => env.ORIGIN.get(env.ORIGIN.idFromName('main'));

async function readOrigin(env, fresh) {
  if (!fresh && memo && Date.now() - memoAt < MEMO_MS) return memo;
  const record = await store(env).read();
  const value = record ? record.url : null;
  memo = value && TUNNEL_RE.test(value) ? value : null;
  memoAt = Date.now();
  return memo;
}

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

async function authorized(request, env) {
  const header = request.headers.get('authorization') || '';
  if (!env.UPDATE_SECRET || !header.startsWith('Bearer ')) return false;
  const [a, b] = await Promise.all([sha256(header.slice(7)), sha256(env.UPDATE_SECRET)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function offline(request) {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/') || request.headers.get('upgrade')) {
    return json(503, { error: 'mac_offline' });
  }
  const html = `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
<title>Mac offline</title><body style="font-family:system-ui;padding:2rem;max-width:32rem;margin:auto">
<h2>Your Mac is offline</h2><p>It is asleep, has no internet, or the app is restarting.
Wake it or check its connection; this page reconnects on its own.</p>
<script>setTimeout(()=>location.reload(),15000)</script>`;
  return new Response(html, {
    status: 503,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '15' },
  });
}

async function control(request, env, url) {
  if (!(await authorized(request, env))) return json(401, { error: 'unauthorized' });
  if (url.pathname === CONTROL + 'origin' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const next = String(body.url || '').replace(/\/+$/, '');
    if (!TUNNEL_RE.test(next)) return json(400, { error: 'bad_url' });
    await store(env).write(next);
    memo = next;
    memoAt = Date.now();
    return json(200, { ok: true, url: next });
  }
  if (url.pathname === CONTROL + 'status' && request.method === 'GET') {
    return json(200, (await store(env).read()) || { url: null });
  }
  if (url.pathname === CONTROL + 'log' && request.method === 'GET') {
    return json(200, await store(env).readLog());
  }
  if (url.pathname === CONTROL + 'push-schedule' && request.method === 'POST') {
    const body = await request.json().catch(() => null);
    if (!body || !Array.isArray(body.jobs) || !Array.isArray(body.subs)) {
      return json(400, { error: 'bad_body' });
    }
    const doc = await store(env).putPushDoc(body);
    const [fired, dead] = await Promise.all([store(env).getFired(), store(env).getDead()]);
    return json(200, { ok: true, uploadedAt: doc.uploadedAt, fired, dead });
  }
  if (url.pathname === CONTROL + 'push-schedule' && request.method === 'GET') {
    const [doc, fired, dead] = await Promise.all([
      store(env).getPushDoc(), store(env).getFired(), store(env).getDead(),
    ]);
    return json(200, { doc, fired, dead });
  }
  return json(404, { error: 'not_found' });
}

// A tunnel whose single connection died silently (e.g. the Mac's VPN
// switched) makes fetch hang instead of fail. Reads get a deadline for
// response headers; writes never do, because replaying a POST that might
// have landed could run an action twice.
const READ_DEADLINE_MS = 15_000;

async function forward(request, body, target, url) {
  const upstream = new URL(url.pathname + url.search, target);
  const headers = new Headers(request.headers);
  headers.set('x-forwarded-host', url.host);
  const deadline =
    (request.method === 'GET' || request.method === 'HEAD') && !request.headers.get('upgrade');
  const ctrl = deadline ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), READ_DEADLINE_MS) : null;
  try {
    return await fetch(upstream.toString(), {
      method: request.method,
      headers,
      body,
      redirect: 'manual',
      signal: ctrl ? ctrl.signal : undefined,
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Small bodies are buffered so a request can be replayed once after a rotation.
const REPLAY_LIMIT = 1024 * 1024;

// 530 = Cloudflare "tunnel not connected" (error 1033); 502 = tunnel lost origin.
const DEAD = new Set([502, 530]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith(CONTROL)) return control(request, env, url);
    const started = Date.now();
    const response = await handleCached(request, env, url, ctx);
    const ms = Date.now() - started;
    // Log only what helps debugging, so 8-second polling cannot flush it.
    const notable =
      response.status >= 400 ||
      ms >= 1000 ||
      /^\/(app|api\/pair|api\/session)$/.test(url.pathname);
    if (notable) {
      ctx.waitUntil(
        store(env).log({
          t: new Date().toISOString(),
          m: request.method,
          p: url.pathname,
          s: response.status,
          ms,
          colo: request.cf && request.cf.colo,
          ua: (request.headers.get('user-agent') || '').slice(0, 60),
          ws: Boolean(request.headers.get('upgrade')),
        }).catch(() => undefined),
      );
    }
    return response;
  },

  /*
   * Once-a-minute cron (wrangler.toml triggers): fire the pushes the
   * machine scheduled but cannot deliver because it is asleep or off. The
   * awake-standdown check keeps this from ever racing the machine itself.
   */
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(pushCron(env));
  },
};

async function pushCron(env) {
  const s = store(env);
  const doc = await s.getPushDoc();
  if (!doc) return;
  const now = Date.now();
  // The machine uploads a heartbeat at least every couple of minutes while
  // awake; a fresh one means it is delivering its own notifications.
  if (now - (doc.uploadedAt || 0) < AWAKE_STANDDOWN_MS) return;
  const vapid = env.VAPID_JWK ? JSON.parse(env.VAPID_JWK) : null;
  if (!vapid || !Array.isArray(doc.subs) || !doc.subs.length) return;
  const fired = await s.getFired();
  const sent = doc.sent || {};
  const deliverAll = async (payload) => {
    for (const sub of doc.subs) {
      try {
        const r = await deliver(sub, payload, vapid, VAPID_SUBJECT);
        if (r.status === 404 || r.status === 410) await s.putDead(sub.endpoint);
      } catch {
        // One subscription failing must not block the others.
      }
    }
  };
  for (const job of doc.jobs || []) {
    if (typeof job.fireAt !== 'number' || job.fireAt > now) continue;
    if (sent[job.id] || fired[job.id]) continue;
    await deliverAll({ t: job.t, b: job.b, tag: job.tag, url: job.url || '/app' });
    await s.putFired(job.id, now);
  }
  // Stall nag: the doc carries the server's last Schoology sweep time and a
  // ready-made stall payload; no refresh for 26h means re-login is needed.
  if (doc.stall && doc.lastSweepAt && now - doc.lastSweepAt > STALL_AFTER_MS) {
    const day = new Date(now).toISOString().slice(0, 10);
    const stallId = 'stall|' + day;
    if ((await s.getStallDay()) !== day && !sent[stallId] && !fired[stallId]) {
      await deliverAll(doc.stall);
      await s.putFired(stallId, now);
      await s.setStallDay(day);
    }
  }
  await s.pruneFired(now - 48 * 3600_000).catch(() => undefined);
}

// Serve immutable static files from Cloudflare's edge cache; only a miss
// travels through the tunnel to the Mac.
async function handleCached(request, env, url, ctx) {
  if (request.method !== 'GET' || !EDGE_CACHEABLE.test(url.pathname)) {
    return handle(request, env, url);
  }
  const key = new Request(url.origin + url.pathname + url.search, { method: 'GET' });
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) return hit;
  const response = await handle(request, env, url);
  const cc = response.headers.get('cache-control') || '';
  if (response.status === 200 && /immutable|max-age=(\d{5,})/.test(cc) && !response.headers.get('set-cookie')) {
    ctx.waitUntil(cache.put(key, response.clone()).catch(() => undefined));
  }
  return response;
}

async function handle(request, env, url) {
  {

    let target = await readOrigin(env, false);
    if (!target) return offline(request);

    const bodyless = request.method === 'GET' || request.method === 'HEAD';
    const size = Number(request.headers.get('content-length') || NaN);
    const buffered = !bodyless && !request.headers.get('upgrade') && size <= REPLAY_LIMIT;
    const body = bodyless ? undefined : buffered ? await request.arrayBuffer() : request.body;
    const replayable = bodyless || buffered;

    let response;
    try {
      response = await forward(request, body, target, url);
    } catch {
      response = null;
    }

    // Retries: the Mac may have rotated tunnels since this isolate cached the
    // origin, or a brand-new tunnel is still propagating. A read that timed
    // out gets one retry (the Mac is rebuilding the tunnel); dead-status
    // responses never reached the Mac, so even writes may retry those.
    const timedOut = !response && bodyless;
    const maxRetries = timedOut ? 1 : 3;
    for (let attempt = 1; attempt <= maxRetries && replayable && (!response || DEAD.has(response.status)); attempt++) {
      if (!response && !bodyless) break;
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      target = (await readOrigin(env, true)) || target;
      try {
        response = await forward(request, body, target, url);
      } catch {
        response = null;
      }
    }
    if (!response || DEAD.has(response.status)) return offline(request);

    // Keep absolute redirects on the front door, never leak the tunnel host.
    const location = response.headers.get('location');
    if (location && location.startsWith(target)) {
      const patched = new Response(response.body, response);
      patched.headers.set('location', url.origin + location.slice(target.length));
      return patched;
    }
    return response;
  }
}
