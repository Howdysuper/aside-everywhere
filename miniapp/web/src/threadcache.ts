/**
 * Thread cache: the last full thread this device saw, per session, in
 * IndexedDB.
 *
 * Chat apps open instantly and work offline because history is a local
 * read; the network only settles what changed. Threads are the one payload
 * here that runs to hundreds of kilobytes, and localStorage is both too
 * small for several of them and synchronous on the launch path, so they
 * live in IndexedDB instead.
 *
 * Cached copies carry the server's `rev` (see ThreadStore.keyFor), which
 * is what lets the refresh ask "has it moved since X" and skip the transfer
 * entirely when it has not.
 */
import type { ThreadResponse } from './types';

const DB_NAME = 'aside-cache';
const STORE = 'threads';
const DB_VERSION = 1;
/** Retained threads. One entry is a whole parsed thread; a small bound. */
const MAX_THREADS = 24;

interface CachedThread {
  id: string;
  at: number;
  response: ThreadResponse;
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
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
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

/**
 * The last cached thread for a session, or null. Private-mode browsers
 * throw on IndexedDB entirely; every failure reads as "no cache".
 */
export async function readThreadCache(sessionId: string): Promise<CachedThread | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(sessionId);
      req.onsuccess = () => {
        const hit = req.result as CachedThread | undefined;
        resolve(hit && hit.response && Array.isArray(hit.response.items) ? hit : null);
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/** Store a full thread response. Never throws: a failed write is a miss. */
export async function writeThreadCache(sessionId: string, response: ThreadResponse): Promise<void> {
  const db = await openDb();
  if (!db) return;
  const record: CachedThread = { id: sessionId, at: Date.now(), response };
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
  // Evict beyond the bound, oldest first. Best-effort by design.
  try {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const all = store.getAll();
    all.onsuccess = () => {
      const entries = (all.result as CachedThread[]) ?? [];
      if (entries.length <= MAX_THREADS) return;
      entries.sort((a, b) => a.at - b.at);
      for (const e of entries.slice(0, entries.length - MAX_THREADS)) {
        store.delete(e.id);
      }
    };
  } catch {
    /* retention is best-effort */
  }
}
