/**
 * NextPush — school-work push notifications for the installed phone PWA.
 *
 * Two halves:
 *  1. WebPushSender — VAPID keys, subscription store, delivery through the
 *     `web-push` npm package. Keys live in the miniapp state dir and are never
 *     logged. Dead endpoints (404/410) are pruned automatically.
 *  2. runPush — the scheduler rules, plain code, no model calls:
 *     - NEW: newly-seen actionable items -> "New on your list" (batched).
 *     - DUE SOON: T-2h before a due time (dedupe id|dueISO|soon). Exempt from
 *       quiet hours - a 1:00 PM ping must go out.
 *     - LATE CATCH-UP: 0-12h past due, once - covers machines that slept
 *       through the T-2h ping.
 *     - THREE-WEEK HEADS-UP: once when an item enters the 21-day window.
 *     - MORNING DIGEST: once/day, first pass after 06:45 the day hasn't had
 *       one. Deliberately not quiet-gated: when the computer slept through
 *       the morning it doubles as the catch-up summary. Sections: Missing /
 *       Due today / Tomorrow / Coming up. Skipped silently if all empty.
 *     - SYNC STALL: Schoology export older than ~26h -> one nag/day to
 *       re-sign-in.
 *     Quiet hours (nextnotify.quiet) hold NEW/LATE/3-week pings during school
 *     and overnight; held items release as one batch when quiet ends.
 *
 * The server owns judgment and copy; the service worker owns display.
 */

import webpush from 'web-push';
import fs from 'node:fs';
import path from 'node:path';
import type { NextItem } from './next.js';
import { quiet } from './nextnotify.js';

// ---------------------------------------------------------------------------
// Sender seam
// ---------------------------------------------------------------------------

export interface PushPayload {
  title: string;
  body: string;
  tag?: string;
  url?: string;
}

export interface Sender {
  /** Deliver to every subscriber; resolves after all attempts. */
  sendAll(p: PushPayload): Promise<number>;
  /** Number of live subscriptions. */
  count(): number;
}

// ---------------------------------------------------------------------------
// Web Push delivery
// ---------------------------------------------------------------------------

interface StoredSub {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export class WebPushSender implements Sender {
  private keys: { publicKey: string; privateKey: string } | null = null;
  private subs: StoredSub[] | null = null;
  private loaded = false;

  constructor(
    private readonly vapidPath: string,
    private readonly subsPath: string,
    private readonly log?: (msg: string, extra?: unknown) => void,
  ) {}

  private ensure(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      this.keys = JSON.parse(fs.readFileSync(this.vapidPath, 'utf8'));
    } catch {
      const fresh = webpush.generateVAPIDKeys();
      fs.mkdirSync(path.dirname(this.vapidPath), { recursive: true });
      fs.writeFileSync(this.vapidPath, JSON.stringify(fresh, null, 2));
      try { fs.chmodSync(this.vapidPath, 0o600); } catch { /* Windows */ }
      this.keys = fresh;
    }
    const keys = this.keys;
    if (!keys) throw new Error('VAPID keys missing after ensure()');
    // Apple's web push (iOS home-screen PWA) rejects placeholder subjects
    // like mailto:aside-local@localhost with a silent 403, so this must be
    // a real address; it matches VAPID_SUBJECT in the front door worker.
    webpush.setVapidDetails('mailto:shaurya.nadagoudra@gmail.com', keys.publicKey, keys.privateKey);
    try {
      this.subs = JSON.parse(fs.readFileSync(this.subsPath, 'utf8'));
      if (!Array.isArray(this.subs)) this.subs = [];
    } catch {
      this.subs = [];
    }
  }

  publicKey(): string {
    this.ensure();
    const k = this.keys;
    if (!k) throw new Error('VAPID keys missing after ensure()');
    return k.publicKey;
  }

  /** Subscriptions arrive as loose JSON from the client; shape-check inside. */
  saveSub(sub: { endpoint: string; keys?: unknown }): void {
    this.ensure();
    const keys = sub.keys as StoredSub['keys'] | undefined;
    if (!keys || !keys.p256dh || !keys.auth) throw new Error('bad_subscription');
    const typed = { endpoint: sub.endpoint, keys };
    const list = this.subs as StoredSub[];
    const at = list.findIndex((s) => s.endpoint === typed.endpoint);
    if (at >= 0) list[at] = typed;
    else list.push(typed);
    fs.mkdirSync(path.dirname(this.subsPath), { recursive: true });
    fs.writeFileSync(this.subsPath, JSON.stringify(list, null, 2));
  }

  count(): number {
    this.ensure();
    return (this.subs as StoredSub[]).length;
  }

  async sendAll(p: PushPayload): Promise<number> {
    this.ensure();
    const list = this.subs as StoredSub[];
    if (!list.length) return 0;
    const payload = JSON.stringify({ t: p.title, b: p.body, tag: p.tag, url: p.url });
    let ok = 0;
    let pruned = false;
    await Promise.all(
      list.map(async (sub, i) => {
        try {
          await webpush.sendNotification(sub, payload, { TTL: 24 * 60 * 60, urgency: 'normal' });
          ok += 1;
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            list.splice(i, 1);
            pruned = true;
          } else if (this.log) {
            this.log('push send failed', { status, endpointHost: new URL(sub.endpoint).host });
          }
        }
      }),
    );
    if (pruned) {
      fs.writeFileSync(this.subsPath, JSON.stringify(list, null, 2));
    }
    return ok;
  }
}

// ---------------------------------------------------------------------------
// Scheduler rules
// ---------------------------------------------------------------------------

export interface NextPushOpts {
  now?: Date;
  /** Directory for push-state.json (seen/sent/held/day/daily counters). */
  dir: string;
  /** Delivery. Tests pass a fake; the server passes a WebPushSender. */
  sender: Sender;
  /** Never deliver (tests, dry runs). */
  dry?: boolean;
  /** Absolute path to the Schoology sweep export; enables the sync-stall nag. */
  schoologyStatePath?: string;
  /** Notices lane (group posts, announcements) to watch for new posts. */
  notices?: Array<{ id: string; title: string }>;
}

export interface State {
  /** `id|dueISO|kind` -> ms timestamp of the send (recent window kept only). */
  sent: Record<string, number>;
  /** Item ids already announced as new. */
  seen: Record<string, number>;
  /** Body lines held while quiet; flushed as one batch when quiet ends. */
  held: string[];
  /** YYYY-MM-DD of the last morning digest. */
  day: string;
  /** YYYY-MM-DD of the last sync-stall nag. */
  stallDay: string;
  /** YYYY-MM-DD -> sends that day (daily cap). */
  daily: Record<string, number>;
  /** First run primes `seen` from the live set instead of replaying history. */
  primed: boolean;
  /** First run primes `seen` from the notices lane too, without announcing. */
  noticed: boolean;
}

export interface PushState extends State {}
export const SANE_START = 6 * 60 + 45; // 06:45
export const SANE_END = 22 * 60 + 30; // 22:30
const DIGEST_AFTER = 6 * 60 + 45; // earliest morning digest
const DAILY_CAP = 15;
// Half a day, not 26 hours: the sweep runs every few hours, so 26 h meant
// five-plus missed passes before the phone said anything at all.
const STALL_AFTER_MS = 12 * 60 * 60 * 1000;
const SOON_MS = 2 * 60 * 60 * 1000;
const LATE_MS = 12 * 60 * 60 * 1000;
const W3_MS = 21 * 86400000;
const DAY_MS = 86400000;

export function readState(dir: string): State {
  const fresh: State = { sent: {}, seen: {}, held: [], day: '', stallDay: '', daily: {}, primed: false, noticed: false };
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'push-state.json'), 'utf8')) as Partial<State>;
    // Field-by-field with type guards: an older scheduler wrote `daily` as
    // a plain number, and a naive spread let that through and crashed every
    // push pass at the daily-cap check. A corrupt field resets, it never
    // takes the whole reminder system down.
    const st: State = { ...fresh };
    if (raw.sent && typeof raw.sent === 'object') st.sent = raw.sent;
    if (raw.seen && typeof raw.seen === 'object') st.seen = raw.seen;
    if (Array.isArray(raw.held)) st.held = raw.held;
    if (raw.daily && typeof raw.daily === 'object') st.daily = raw.daily;
    if (typeof raw.day === 'string') st.day = raw.day;
    if (typeof raw.stallDay === 'string') st.stallDay = raw.stallDay;
    if (typeof raw.primed === 'boolean') st.primed = raw.primed;
    if (typeof raw.noticed === 'boolean') st.noticed = raw.noticed;
    return st;
  } catch {
    return fresh;
  }
}

export function writeState(dir: string, st: State): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'push-state.json'), JSON.stringify(st, null, 2));
}

export const pad = (n: number): string => String(n).padStart(2, '0');
export const dayKey = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function clock(d: Date): string {
  let h = d.getHours();
  const m = pad(d.getMinutes());
  const ap = h < 12 ? 'AM' : 'PM';
  h = h % 12 === 0 ? 12 : h % 12;
  return `${h}:${m} ${ap}`;
}

function dayDiff(due: Date, now: Date): number {
  const a = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const b = new Date(due.getFullYear(), due.getMonth(), due.getDate()).getTime();
  return Math.round((b - a) / DAY_MS);
}

/** "today 3:00 PM" | "tomorrow 8:00 AM" | "Fri 3:00 PM" */
export function whenText(dueISO: string, now: Date): { rel: string; clockStr: string } {
  const due = new Date(dueISO);
  const diff = dayDiff(due, now);
  const clockStr = clock(due);
  let rel = 'today';
  if (diff === 1) rel = 'tomorrow';
  else if (diff > 1) rel = WD[due.getDay()];
  return { rel, clockStr };
}

/** "Mon 10/19" */
export function shortDate(dueISO: string): string {
  const due = new Date(dueISO);
  return `${WD[due.getDay()]} ${due.getMonth() + 1}/${due.getDate()}`;
}

export const clip = (s: string, n: number): string =>
  s.length <= n ? s : `${s.slice(0, Math.max(1, n - 3))}...`;

/** Deep link into the app: opens that item's sheet (NextScreen reads it). */
export const itemLink = (id: string): string => `/app?item=${encodeURIComponent(id)}`;

const courseLabel = (it: NextItem): string => {
  const c = (it.context || '').trim();
  return c ? clip(c, 48) : 'School work';
};

/** "today at 4:00 PM" | "yesterday at 11:59 PM" | "tomorrow at 9:00 AM" | "Fri at 3:00 PM" */
export function dueWhen(dueISO: string, ref: Date): string {
  const due = new Date(dueISO);
  const t = clock(due);
  const a = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate()).getTime();
  const b = new Date(due.getFullYear(), due.getMonth(), due.getDate()).getTime();
  const diff = Math.round((b - a) / DAY_MS);
  if (diff === 0) return `today at ${t}`;
  if (diff === -1) return `yesterday at ${t}`;
  if (diff === 1) return `tomorrow at ${t}`;
  return `${WD[due.getDay()]} at ${t}`;
}

export interface PushCopy {
  t: string;
  b: string;
  tag: string;
  url: string;
}

/**
 * Per-item reminder copy, shared by the live scheduler (runPush) and the
 * front door Worker's asleep schedule (pushjobs), so a reminder reads the
 * same no matter which side fires it. `ref` is the moment it fires.
 * Title = what to do, body = course + when it's due, url = the item.
 */
export function soonPush(it: NextItem, ref: Date): PushCopy {
  return {
    t: `Due soon: ${clip(it.title, 52)}`,
    b: `${courseLabel(it)} - due ${dueWhen(it.dueISO as string, ref)}`,
    tag: `soon-${it.id}`,
    url: itemLink(it.id),
  };
}

export function latePush(it: NextItem, ref: Date): PushCopy {
  return {
    t: `Now late: ${clip(it.title, 52)}`,
    b: `${courseLabel(it)} - was due ${dueWhen(it.dueISO as string, ref)}`,
    tag: 'late',
    url: itemLink(it.id),
  };
}

export function w3Push(it: NextItem, days: number): PushCopy {
  return {
    t: `Coming up: ${clip(it.title, 52)}`,
    b: `${courseLabel(it)} - due ${shortDate(it.dueISO as string)} (${days} days out)`,
    tag: `w3-${it.id}`,
    url: itemLink(it.id),
  };
}

/** School-work item worth pushes: open, real (not trial/flagged), has a due date. */
export function actionable(item: NextItem): boolean {
  if (item.trial || item.flag) return false;
  if (item.status !== 'open') return false;
  return Boolean(item.dueISO);
}

/** Schoology homework, not turned in, past due = the "missing" bucket. */
export function isMissing(item: NextItem, now: Date): boolean {
  if (item.source !== 'schoology') return false;
  if (item.status !== 'open' || item.flag || item.trial) return false;
  if (!item.dueISO) return false;
  return new Date(item.dueISO).getTime() <= now.getTime();
}

/** "Equilibrium WS, AP Chem — due Fri 3:00 PM" */
export function line(item: NextItem, now: Date, duePrefix = 'due'): string {
  const { rel, clockStr } = whenText(item.dueISO as string, now);
  const ctx = item.context && item.context.length <= 24 ? `, ${item.context}` : '';
  const when = rel === 'today' ? `${clockStr} today` : `${rel} ${clockStr}`;
  const base = `${item.title}${ctx} — ${duePrefix} ${when}`;
  return base.length <= 140 ? base : `${base.slice(0, 137)}...`;
}

function pushBody(lines: string[], prefix: string): string {
  if (lines.length <= 3) return lines.join('\n');
  return `${lines.slice(0, 3).join('\n')}\n${prefix}${lines.length - 3} more`;
}

/**
 * Digest content for a reference moment (the send time): sections
 * Missing / Due today / Tomorrow / Coming up. Null when all empty.
 * Shared by runPush (sends it live) and pushjobs (schedules the worker's
 * asleep copy for the next 6:50 AM).
 */
export function buildDigest(open: NextItem[], ref: Date): { title: string; body: string } | null {
  const missing = open.filter((it) => isMissing(it, ref));
  const dueToday = open.filter((it) => {
    const d = new Date(it.dueISO as string);
    return d.getTime() > ref.getTime() && dayDiff(d, ref) === 0;
  });
  const dueTomorrow = open.filter((it) => {
    const d = new Date(it.dueISO as string);
    return d.getTime() > ref.getTime() && dayDiff(d, ref) === 1;
  });
  const upcoming = open.filter((it) => {
    const t = new Date(it.dueISO as string).getTime() - ref.getTime();
    if (!(t > 0 && t <= 7 * DAY_MS)) return false;
    return dayDiff(new Date(it.dueISO as string), ref) > 1;
  });
  const sections: string[] = [];
  if (missing.length) {
    const names = missing.slice(0, 2).map((it) => it.title).join(', ');
    sections.push(`Missing: ${names}${missing.length > 2 ? ` +${missing.length - 2}` : ''}`);
  }
  if (dueToday.length) {
    const names = dueToday.slice(0, 3).map((it) => `${it.title} (${clock(new Date(it.dueISO as string))})`).join(', ');
    sections.push(`Due today: ${names}`);
  }
  if (dueTomorrow.length) {
    const names = dueTomorrow.slice(0, 3).map((it) => it.title).join(', ');
    sections.push(`Tomorrow: ${names}`);
  }
  if (upcoming.length) {
    const names = upcoming.slice(0, 2).map((it) => `${it.title} ${shortDate(it.dueISO as string)}`).join(', ');
    sections.push(`Coming up: ${names}`);
  }
  if (!sections.length) return null;
  const counts: string[] = [];
  if (missing.length) counts.push(`${missing.length} missing`);
  if (dueToday.length) counts.push(`${dueToday.length} due today`);
  if (!counts.length) counts.push('a look ahead');
  return { title: counts.join(', '), body: sections.slice(0, 4).join('\n') };
}

/**
 * One scheduler pass. The server calls this every minute via NextPush.run();
 * tests call it directly with a fixed clock and a fake sender.
 */
export async function runPush(items: NextItem[], opts: NextPushOpts): Promise<void> {
  const now = opts.now ?? new Date();
  const st = readState(opts.dir);
  const day = dayKey(now);

  if (!st.primed) {
    // First run after enabling: mark everything already known so we don't
    // replay history as "new". Fresh announcements start from the next sweep.
    for (const it of items) {
      if (actionable(it)) st.seen[it.id] = now.getTime();
    }
    st.primed = true;
    st.day = day;
  }
  if (st.day !== day) {
    st.day = day;
    const cutoff = now.getTime() - 14 * DAY_MS;
    for (const [k, v] of Object.entries(st.sent)) if (v < cutoff) delete st.sent[k];
  }

  if (!st.noticed) {
    // Same for the notices lane: what is already on the wall when this rule
    // first runs is history, not news. New posts announce from the next sweep.
    for (const n of opts.notices ?? []) st.seen[n.id] = now.getTime();
    st.noticed = true;
  }

  const mins = now.getHours() * 60 + now.getMinutes();
  const sane = mins >= SANE_START && mins <= SANE_END;
  const quietNow = quiet(now);
  const take = (): boolean => {
    // Live read: one pass can send several pushes; the cap must see them.
    const n = st.daily[day] ?? 0;
    if (n >= DAILY_CAP) return false;
    st.daily[day] = n + 1;
    return true;
  };

  const send = async (title: string, body: string, tag: string, url = '/app'): Promise<void> => {
    if (opts.dry || !take()) return;
    await opts.sender.sendAll({ title, body, tag, url });
  };

  const open = items.filter(actionable);

  // ---- NEW ---------------------------------------------------------------
  const newIds = new Set<string>();
  const newLines: string[] = [];
  for (const it of open) {
    if (it.id in st.seen) continue;
    st.seen[it.id] = now.getTime();
    newIds.add(it.id);
    newLines.push(line(it, now));
  }
  if (newLines.length && sane && !quietNow) {
    await send(newLines.length === 1 ? 'New on your list' : `${newLines.length} new on your list`, pushBody(newLines, 'and '), 'new');
  } else if (newLines.length) {
    // Quiet or overnight: never swallow. The batch releases when quiet ends.
    st.held.push(...newLines);
  }

  // ---- ANNOUNCEMENTS (group posts and other notices) ----------------------
  const noticeLines: string[] = [];
  for (const n of opts.notices ?? []) {
    if (n.id in st.seen) continue;
    st.seen[n.id] = now.getTime();
    noticeLines.push(n.title);
  }
  if (noticeLines.length && sane && !quietNow) {
    const shown = noticeLines.slice(0, 4);
    const title = noticeLines.length === 1 ? 'New announcement' : `${noticeLines.length} new announcements`;
    const body = shown.length === noticeLines.length ? pushBody(shown, 'and ') : `${shown.join(', ')} and more`;
    await send(title, body, 'new', '/app?tab=today');
  } else if (noticeLines.length) {
    st.held.push(...noticeLines.slice(0, 4).map((t) => `Announcement: ${t}`));
  }

  // ---- DUE SOON (T-2h) — exempt from quiet; class-time pings must go out --
  for (const it of open) {
    const due = new Date(it.dueISO as string).getTime();
    const until = due - now.getTime();
    const key = `soon|${it.id}|${it.dueISO}`;
    if (until <= SOON_MS && until > -5 * 60_000 && !(key in st.sent)) {
      if (!sane) continue;
      st.sent[key] = now.getTime();
      const p = soonPush(it, now);
      await send(p.t, p.b, p.tag, p.url);
    }
  }

  // ---- LATE CATCH-UP (0-12h past due, once, one deep-linked push each) -----
  for (const it of open) {
    const due = new Date(it.dueISO as string).getTime();
    const past = now.getTime() - due;
    const key = `late|${it.id}|${it.dueISO}`;
    if (past > 0 && past <= LATE_MS && !(key in st.sent)) {
      st.sent[key] = now.getTime();
      if (!sane || quietNow) continue; // the digest covers it meanwhile
      const p = latePush(it, now);
      await send(p.t, p.b, p.tag, p.url);
    }
  }

  // ---- THREE-WEEK HEADS-UP -------------------------------------------------
  for (const it of open) {
    // Freshly announced this pass: the "new" push already carries the due date.
    if (newIds.has(it.id)) continue;
    const until = new Date(it.dueISO as string).getTime() - now.getTime();
    const key = `w3|${it.id}|${it.dueISO}`;
    if (until > 0 && until <= W3_MS && !(key in st.sent)) {
      st.sent[key] = now.getTime();
      if (!sane || quietNow) continue; // digests cover it meanwhile
      const p = w3Push(it, Math.ceil(until / DAY_MS));
      await send(p.t, p.b, p.tag, p.url);
    }
  }

  // ---- HELD RELEASE ----------------------------------------------------------
  if (st.held.length && !quietNow) {
    const lines = st.held.splice(0, st.held.length);
    if (lines.length) {
      await send(lines.length === 1 ? 'New on your list' : `${lines.length} new on your list`, pushBody(lines, 'and '), 'new');
    }
  }

  // ---- MORNING DIGEST (catch-up capable, not quiet-gated) -------------------
  const digestKey = `digest|${day}`;
  const digSentToday = st.daily[day] ?? 0;
  if (!(digestKey in st.sent) && mins >= DIGEST_AFTER && digSentToday < DAILY_CAP) {
    const digest = buildDigest(open, now);
    if (digest) {
      st.sent[digestKey] = now.getTime();
      await send(digest.title, digest.body, 'digest');
    }
  }

  // ---- SYNC STALL NAG --------------------------------------------------------
  if (opts.schoologyStatePath && st.stallDay !== day && sane) {
    try {
      const age = now.getTime() - fs.statSync(opts.schoologyStatePath).mtimeMs;
      if (age > STALL_AFTER_MS) {
        st.stallDay = day;
        // Same key the front door cron checks, so the Worker never repeats a
        // stall nag that was already delivered while the machine was awake.
        st.sent[`stall|${day}`] = now.getTime();
        await send('Schoology stopped syncing', `Last refreshed ${Math.floor(age / 3600000)}h ago — open the app and sign in again`, 'stall');
      }
    } catch {
      // No export file yet: nothing to nag about.
    }
  }

  writeState(opts.dir, st);
}

// ---------------------------------------------------------------------------
// NextPush — the object the server wires up (app.ts)
// ---------------------------------------------------------------------------

export interface NextPushConfig {
  vapidPath: string;
  subsPath: string;
  /** Full path of push-state.json; the ledger lives beside it. */
  statePath: string;
  items: () => NextItem[];
  /** Notices lane (group posts, announcements) to watch for new posts. */
  notices?: () => Array<{ id: string; title: string }>;
  log?: (msg: string, extra?: unknown) => void;
  /** Schoology export file; enables the sync-stall nag. */
  schoologyStatePath?: string;
}

export class NextPush {
  private readonly sender: WebPushSender;

  constructor(private readonly cfg: NextPushConfig) {
    this.sender = new WebPushSender(cfg.vapidPath, cfg.subsPath, cfg.log);
  }

  get publicKey(): string {
    return this.sender.publicKey();
  }

  saveSub(sub: { endpoint: string; keys?: unknown }): void {
    this.sender.saveSub(sub);
  }

  count(): number {
    return this.sender.count();
  }

  async test(): Promise<boolean> {
    const ok = await this.sender.sendAll({ title: 'Aside', body: 'Reminders are on — test ping', tag: 'test', url: '/app' });
    return ok > 0;
  }

  /*
   * An immediate push outside the scheduler: a session waiting on you,
   * an error, a finished turn, research landing. The scheduler owns
   * school-work rhythm and quiet hours; these are event pushes, so
   * callers decide their own urgency (waiting/error are never
   * quiet-gated, results are).
   */
  async push(p: PushPayload): Promise<number> {
    return this.sender.sendAll(p);
  }

  async run(): Promise<void> {
    await runPush(this.cfg.items(), {
      dir: path.dirname(this.cfg.statePath),
      sender: this.sender,
      schoologyStatePath: this.cfg.schoologyStatePath,
      notices: this.cfg.notices?.(),
    });
  }
}
