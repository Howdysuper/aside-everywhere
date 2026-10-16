/**
 * PushJobs — the bridge that makes reminders survive a sleeping computer.
 *
 * The local server owns every push decision (nextpush.ts), but it only runs
 * while the machine is awake. So on every minute pass it ALSO publishes its
 * plan to the front door Worker:
 *
 *   - jobs: the pushes we would send if we were awake at their fire time
 *       (due-soon at T-2h, a "was due" ping at due+1h, the 3-week heads-up,
 *        tomorrow's 6:50 AM digest), each with the SAME dedupe key the local
 *        scheduler uses, minus everything already sent.
 *   - subs: current push subscriptions, so the Worker can encrypt at fire
 *       time (RFC 8291) with the VAPID key from its own secret.
 *   - sent: the local dedupe ledger (last 48h), so the Worker never fires
 *       something the machine already delivered.
 *   - lastSweepAt + a ready-made stall payload: if the Worker's cron sees no
 *       Schoology refresh for 26h it nags once a day, even mid-outage.
 *
 * The Worker stands down while it sees fresh heartbeats (< 4 min old), so the
 * two senders never race. Its "fired" ledger comes back on every upload and
 * is merged into the local state, so nothing is ever sent twice. Job ids are
 * the exact keys runPush() writes into state.sent (`soon|id|dueISO` etc.).
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { NextItem } from './next.js';
import {
  SANE_END,
  SANE_START,
  actionable,
  buildDigest,
  dayKey,
  latePush,
  readState,
  soonPush,
  w3Push,
  writeState,
} from './nextpush.js';

const DAY_MS = 86_400_000;
const MIN_MS = 60_000;
/** Heartbeat even when nothing changed: keeps the Worker stood down. */
const HEARTBEAT_MS = 2 * MIN_MS;
/** How much of the sent ledger travels to the Worker (its prune horizon). */
const SENT_WINDOW_MS = 48 * 3600_000;
/** Never schedule a job firing this close (the machine handles those). */
const MIN_LEAD_MS = MIN_MS;
const MAX_JOBS = 200;

export interface PushJob {
  id: string;
  fireAt: number;
  t: string;
  b: string;
  tag: string;
  url: string;
}

export interface PushJobsConfig {
  /** Miniapp state dir (.aside-mobile): push-state.json, push-subs.json, front-door/. */
  stateDir: string;
  items: () => NextItem[];
  /** Schoology export file; its mtime becomes lastSweepAt. */
  schoologyStatePath?: string;
  log?: (msg: string, extra?: unknown) => void;
}

/** Move a fire time into 06:45-22:30 local; night pings wait for morning. */
function clampSane(ts: number): number {
  const d = new Date(ts);
  const mins = d.getHours() * 60 + d.getMinutes();
  if (mins >= SANE_START && mins <= SANE_END) return ts;
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 6, 45, 0, 0);
  if (mins >= SANE_START) target.setDate(target.getDate() + 1); // past 22:30 -> tomorrow
  return target.getTime();
}

/** Next 6:50 AM local on or after now (the Worker's digest slot; the machine
 * normally sends its own digest first, right after the 6:15-6:45 wake sweep). */
function nextDigestTime(now: Date): number {
  const t = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 6, 50, 0, 0);
  if (t.getTime() <= now.getTime()) t.setDate(t.getDate() + 1);
  return t.getTime();
}

/** The desired schedule for right now: every push we would want fired by
 *  someone awake 24/7, minus everything already sent. Copy and deep links
 *  come from the shared builders in nextpush.ts, computed against each
 *  job's fire time, so a Worker-fired reminder reads exactly like a local
 *  one. */
export function buildJobs(items: NextItem[], now: Date, sent: Record<string, number>): PushJob[] {
  const jobs: PushJob[] = [];
  const open = items.filter(actionable);
  for (const it of open) {
    const due = new Date(it.dueISO as string).getTime();

    const soonKey = `soon|${it.id}|${it.dueISO}`;
    const soonAt = clampSane(due - 2 * 3600_000);
    if (soonAt > now.getTime() + MIN_LEAD_MS && !(soonKey in sent)) {
      const p = soonPush(it, new Date(soonAt));
      jobs.push({ id: soonKey, fireAt: soonAt, t: p.t, b: p.b, tag: p.tag, url: p.url });
    }

    const lateKey = `late|${it.id}|${it.dueISO}`;
    const lateAt = clampSane(due + 3600_000);
    if (lateAt > now.getTime() + MIN_LEAD_MS && !(lateKey in sent)) {
      const p = latePush(it, new Date(lateAt));
      jobs.push({ id: lateKey, fireAt: lateAt, t: p.t, b: p.b, tag: p.tag, url: p.url });
    }

    const w3Key = `w3|${it.id}|${it.dueISO}`;
    const w3At = clampSane(due - 21 * DAY_MS);
    if (w3At > now.getTime() + MIN_LEAD_MS && !(w3Key in sent)) {
      const p = w3Push(it, Math.ceil((due - w3At) / DAY_MS));
      jobs.push({ id: w3Key, fireAt: w3At, t: p.t, b: p.b, tag: p.tag, url: p.url });
    }
    if (jobs.length >= MAX_JOBS) return jobs;
  }

  const digestAt = nextDigestTime(now);
  const digestKey = `digest|${dayKey(new Date(digestAt))}`;
  if (!(digestKey in sent)) {
    const digest = buildDigest(open, new Date(digestAt));
    if (digest) {
      jobs.push({ id: digestKey, fireAt: digestAt, t: digest.title, b: digest.body, tag: 'digest', url: '/app' });
    }
  }
  return jobs;
}

interface UploadResult {
  ok?: boolean;
  uploadedAt?: number;
  fired?: Record<string, number>;
  dead?: string[];
}

export class PushJobs {
  private lastHash = '';
  private lastUploadAt = 0;

  constructor(private readonly cfg: PushJobsConfig) {}

  /** Front door base URL + bearer secret from the front-door install. */
  private front(): { url: string; secret: string } | null {
    try {
      const dir = path.join(this.cfg.stateDir, 'front-door');
      const front = (JSON.parse(fs.readFileSync(path.join(dir, 'frontdoor.json'), 'utf8')) as { front?: string }).front;
      const secret = fs.readFileSync(path.join(dir, 'secret'), 'utf8').trim();
      if (!front || !secret) return null;
      return { url: front.replace(/\/+$/, ''), secret };
    } catch {
      return null; // front door not installed: local-only behavior
    }
  }

  private subs(): Array<{ endpoint: string; keys: { p256dh: string; auth: string } }> {
    try {
      const list = JSON.parse(fs.readFileSync(path.join(this.cfg.stateDir, 'push-subs.json'), 'utf8'));
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  /** Called every minute right after NextPush.run(). Cheap when nothing changed. */
  async sync(): Promise<void> {
    const now = new Date();
    const subs = this.subs();
    if (!subs.length) return;
    const front = this.front();
    if (!front) return;

    const stateDir = this.cfg.stateDir;
    const st = readState(stateDir);

    let lastSweepAt: number | null = null;
    if (this.cfg.schoologyStatePath) {
      try {
        lastSweepAt = fs.statSync(this.cfg.schoologyStatePath).mtimeMs;
      } catch {
        lastSweepAt = null;
      }
    }

    const sentWindow: Record<string, number> = {};
    const cutoff = now.getTime() - SENT_WINDOW_MS;
    for (const [k, v] of Object.entries(st.sent)) {
      if (v >= cutoff) sentWindow[k] = v;
    }

    const doc = {
      jobs: buildJobs(this.cfg.items(), now, st.sent),
      subs,
      sent: sentWindow,
      lastSweepAt,
      stall: {
        t: 'Schoology stopped syncing',
        b: 'No refresh in over a day — sign in on your computer when you can.',
        tag: 'stall',
        url: '/app',
      },
    };
    const hash = crypto.createHash('sha256').update(JSON.stringify(doc)).digest('hex');
    if (hash === this.lastHash && now.getTime() - this.lastUploadAt < HEARTBEAT_MS) return;

    const res = await fetch(`${front.url}/__frontdoor/push-schedule`, {
      method: 'POST',
      headers: { authorization: `Bearer ${front.secret}`, 'content-type': 'application/json' },
      body: JSON.stringify(doc),
    });
    if (!res.ok) {
      this.cfg.log?.('push schedule upload failed', { status: res.status });
      return;
    }
    const out = (await res.json()) as UploadResult;

    // Merge the Worker's fired ledger so the machine never re-sends them.
    let merged = 0;
    for (const [id, at] of Object.entries(out.fired ?? {})) {
      if (!(id in st.sent)) {
        st.sent[id] = at;
        merged += 1;
      }
    }
    if (merged) writeState(stateDir, st);

    // Prune subscriptions the push service reported as gone.
    const dead = new Set(out.dead ?? []);
    if (dead.size && subs.some((s) => dead.has(s.endpoint))) {
      const alive = subs.filter((s) => !dead.has(s.endpoint));
      fs.writeFileSync(path.join(this.cfg.stateDir, 'push-subs.json'), JSON.stringify(alive, null, 2));
      this.cfg.log?.('pruned dead push subscriptions', { count: subs.length - alive.length });
    }

    this.lastHash = hash;
    this.lastUploadAt = now.getTime();
  }
}
