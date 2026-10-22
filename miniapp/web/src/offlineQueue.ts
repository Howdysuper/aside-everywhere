/**
 * The outbox: what the phone did while the computer was unreachable.
 *
 * The app already opens offline. The service worker caches the shell and
 * the hashed assets, and `useLivePlan` paints the last plan it saw from
 * localStorage before the network is ever consulted. So when the Mac is
 * asleep the phone boots, shows real data, and then fails on the first
 * thing you *do* -- a chat message, a tap on "done", a new task -- with a
 * dead fetch. Reads were solved; writes were not.
 *
 * This module is the write half. A mutation that cannot reach the server is
 * recorded here instead of thrown away, so the tap is never lost, and
 * replayed in order the moment the computer answers again.
 *
 * Two rules keep it from becoming a liability:
 *
 *   Only a known-safe route is queued. A mutation that launches an agent or
 *   triggers a sweep does real work on the computer, and replaying it
 *   unattended hours later is a decision the person should make while the
 *   computer is on. Those keep failing loudly, as they do today.
 *
 *   Order is preserved and a failure stops the flush. Actions are replayed
 *   oldest-first because "mark done" then "move to next week" means
 *   something different the other way round, and one unreachable origin
 *   must not silently skip past the actions behind it.
 */
import { readLocal, writeLocal } from './utils/storage';

export type QueuedKind = 'chat' | 'plan' | 'other';

export interface QueuedAction {
  /** Unique per queue entry, not per intent. */
  id: string;
  /** ms epoch when the action was taken on the phone. Replay order. */
  at: number;
  kind: QueuedKind;
  /** What the phone shows the user while this waits. */
  label: string;
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  /** Raw JSON string, exactly as it was going to be sent. */
  body: string;
}

const DB_NAME = 'aside-outbox';
const STORE = 'pending';
const DB_VERSION = 1;
const LS_KEY = 'aside.outbox.v1';

/** Cap on stored actions. A phone that never reconnects must not grow without bound. */
const MAX_PENDING = 200;

/** Identical action inside this window is a double-tap, not a second intent. */
const DEDUPE_MS = 2_000;

/*
 * The routes worth replaying.
 *
 * Matched by shape rather than by the api.ts method name so the list is
 * auditable in one place. `/api/sessions/:id/send`, `/steer` and the Next
 * plan's own mutations are safe to repeat: the server treats a repeated
 * "done" as already-done and a repeated task create as a duplicate row,
 * neither of which corrupts anything. `/api/next/:id/start` and the refresh
 * triggers are deliberately absent.
 */
const QUEUEABLE: Array<{ method: QueuedAction['method']; re: RegExp }> = [
  // A brand-new thread started from the home composer. Same shape as a send
  // as far as the computer is concerned, and the most common thing a person
  // does with their phone.
  { method: 'POST', re: /^\/api\/sessions\/new$/ },
  { method: 'POST', re: /^\/api\/sessions\/[^/]+\/(send|steer|answer)$/ },
  { method: 'POST', re: /^\/api\/next\/[^/]+\/action$/ },
  { method: 'POST', re: /^\/api\/next\/tasks$/ },
  { method: 'PATCH', re: /^\/api\/next\/tasks\/[^/]+$/ },
  { method: 'POST', re: /^\/api\/next\/pause$/ },
  { method: 'POST', re: /^\/api\/next\/research$/ },
  { method: 'POST', re: /^\/api\/next\/research\/[^/]+\/dismiss$/ },
  { method: 'POST', re: /^\/api\/next\/projects$/ },
  { method: 'PATCH', re: /^\/api\/next\/projects\/[^/]+$/ },
  { method: 'POST', re: /^\/api\/next\/projects\/[^/]+\/milestones$/ },
  { method: 'PATCH', re: /^\/api\/next\/projects\/[^/]+\/milestones\/[^/]+$/ },
  { method: 'DELETE', re: /^\/api\/next\/projects\/[^/]+\/milestones\/[^/]+$/ },
  { method: 'POST', re: /^\/api\/next\/projects\/[^/]+\/proposal\/(apply|discard)$/ },
];

/** True when a failed request should be recorded rather than reported as lost. */
export function isQueueable(method: string, path: string): boolean {
  return QUEUEABLE.some((r) => r.method === method && r.re.test(path));
}

export function kindFor(path: string): QueuedKind {
  if (/^\/api\/sessions\//.test(path)) return 'chat';
  if (/^\/api\/next\//.test(path)) return 'plan';
  return 'other';
}

// --------------------------------------------------------------------------
// Storage: IndexedDB, with a localStorage floor.

interface Row {
  id: string;
  at: number;
  kind: QueuedKind;
  label: string;
  method: QueuedAction['method'];
  path: string;
  body: string;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => {
      req.result.onversionchange = () => req.result.close();
      resolve(req.result);
    };
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

async function readAll(): Promise<QueuedAction[]> {
  const db = await openDb();
  if (db) {
    const rows = await new Promise<Row[]>((resolve) => {
      try {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).getAll();
        req.onsuccess = () => resolve((req.result as Row[]) ?? []);
        req.onerror = () => resolve([]);
      } catch {
        resolve([]);
      }
    });
    return rows.map(toAction).sort((a, b) => a.at - b.at);
  }
  // No IndexedDB: private mode, or a browser that refuses it. The queue
  // still works for this session, and localStorage keeps it across reloads
  // when that is available.
  const raw = readLocal(LS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as QueuedAction[];
    return Array.isArray(parsed) ? parsed.sort((a, b) => a.at - b.at) : [];
  } catch {
    return [];
  }
}

function toAction(r: Row): QueuedAction {
  return { id: r.id, at: r.at, kind: r.kind, label: r.label, method: r.method, path: r.path, body: r.body };
}

async function writeAll(rows: QueuedAction[]): Promise<void> {
  const db = await openDb();
  if (db) {
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        store.clear();
        for (const a of rows) store.put(toRow(a));
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      } catch {
        resolve();
      }
    });
  } else {
    writeLocal(LS_KEY, JSON.stringify(rows.slice(0, MAX_PENDING)));
  }
}

function toRow(a: QueuedAction): Row {
  return { id: a.id, at: a.at, kind: a.kind, label: a.label, method: a.method, path: a.path, body: a.body };
}

async function remove(id: string): Promise<void> {
  const db = await openDb();
  if (db) {
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      } catch {
        resolve();
      }
    });
  } else {
    const rows = (await readAll()).filter((a) => a.id !== id);
    writeLocal(LS_KEY, JSON.stringify(rows));
  }
}

// --------------------------------------------------------------------------
// The in-memory mirror, so the UI can show a count without an await.

let mirror: QueuedAction[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const cb of listeners) cb();
}

/** Load what survived a reload. Call once at boot. */
export async function initOutbox(): Promise<QueuedAction[]> {
  mirror = await readAll();
  emit();
  return mirror;
}

export function pendingActions(): QueuedAction[] {
  return mirror;
}

export function pendingCount(): number {
  return mirror.length;
}

/** Subscribe to queue changes; returns an unsubscribe function. */
export function onQueueChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * Record an action that could not be delivered.
 *
 * The double-tap window is the one piece of judgement here: two identical
 * requests within two seconds are almost always the same finger, and
 * replaying both would create a duplicate task. Two genuinely identical
 * messages typed minutes apart are kept, because the window has closed.
 */
export async function enqueueAction(
  input: Omit<QueuedAction, 'id' | 'at' | 'kind'> & { kind?: QueuedKind },
): Promise<QueuedAction | null> {
  const now = Date.now();
  const dup = mirror.find(
    (a) => a.path === input.path && a.method === input.method && a.body === input.body && now - a.at < DEDUPE_MS,
  );
  if (dup) return null;

  const action: QueuedAction = {
    id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    at: now,
    kind: input.kind ?? kindFor(input.path),
    label: input.label,
    method: input.method,
    path: input.path,
    body: input.body,
  };
  mirror = [...mirror, action].slice(-MAX_PENDING);
  await writeAll(mirror);
  emit();
  return action;
}

export async function dropAction(id: string): Promise<void> {
  mirror = mirror.filter((a) => a.id !== id);
  await remove(id);
  emit();
}

// --------------------------------------------------------------------------
// Replay.

export interface FlushResult {
  /** Delivered and removed from the queue. */
  sent: number;
  /** Rejected by the server with a verdict; dropped so the queue cannot jam. */
  rejected: number;
  /** Still waiting. */
  remaining: number;
  /** True when the computer is still unreachable, so nothing was attempted. */
  offline: boolean;
  /** True when a plan route was delivered, so the caller should re-read the plan. */
  planTouched: boolean;
  /** Set when a request was rejected; the human detail. */
  lastError?: string;
}

export type Sender = (path: string, method: string, body: string) => Promise<Response>;

/**
 * Replay the queue, oldest first, stopping at the first action that cannot
 * be delivered.
 *
 * The verdicts are worth separating. A network failure means the computer
 * is still away: stop, keep everything, try again later. A 401 means the
 * credential is the problem, not the computer: stop and let auth handle it.
 * A 4xx means the server looked at this action and refused it -- retrying
 * an identically-shaped request will get the same answer forever, so the
 * action is dropped with its reason surfaced rather than jamming every
 * action behind it. A 5xx is the server having a moment, so it stays.
 */
export async function flushOutbox(send: Sender): Promise<FlushResult> {
  const queue = await readAll();
  const result: FlushResult = { sent: 0, rejected: 0, remaining: queue.length, offline: false, planTouched: false };

  for (const action of queue) {
    let res: Response;
    try {
      res = await send(action.path, action.method, action.body);
    } catch {
      // Origin still unreachable. Keep this action and everything after it.
      result.offline = true;
      break;
    }

    if (res.status === 401) {
      result.offline = false;
      result.lastError = 'Your phone needs to be paired again before the queued changes can send.';
      break;
    }

    if (!res.ok) {
      if (res.status >= 500) {
        // Transient server-side problem: leave it queued and stop here so
        // order is preserved.
        result.lastError = `The computer refused one queued change (${res.status}). It will retry.`;
        break;
      }
      // A verdict. Retrying cannot change it, so drop it and carry on with
      // the rest of the queue.
      let why = `${res.status}`;
      try {
        const text = await res.text();
        const parsed = text ? JSON.parse(text) : {};
        why = parsed.reason || parsed.error || why;
      } catch {
        /* keep the status code */
      }
      result.rejected += 1;
      result.lastError = `One queued change was rejected: ${why}`;
      mirror = mirror.filter((a) => a.id !== action.id);
      await remove(action.id);
      continue;
    }

    mirror = mirror.filter((a) => a.id !== action.id);
    await remove(action.id);
    result.sent += 1;
    if (action.kind === 'plan') result.planTouched = true;
  }

  result.remaining = mirror.length;
  emit();
  return result;
}
