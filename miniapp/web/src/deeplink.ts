/**
 * Deep links from notification taps.
 *
 * A notification carries /app?item=<id>. Getting from the tap to the item's
 * sheet has three different wake paths, and iOS makes each of them behave
 * differently, so the intent is funneled through this tiny shared store:
 *
 *   cold start   the URL (with query) is loaded fresh: App.tsx parses it.
 *   iOS resume   a suspended home-screen app resumes WITHOUT loading any
 *                URL at all, so the service worker stashes the tapped
 *                destination in the Cache API; App.tsx checks it on
 *                visibility change and at mount.
 *   live page    the service worker also postMessage's the URL; App.tsx
 *                listens, for taps that arrive while the app is fully alive.
 *
 * App.tsx decides to open the planner screen; NextScreen consumes the id
 * and opens the item's sheet once the plan data contains it.
 */
let pendingItem: string | null = null;
const listeners = new Set<(item: string | null) => void>();

/*
 * Mirrored into sessionStorage (10-minute TTL) so the link survives the
 * reloadOnceForNewBuild dance: right after a deploy the shell can come from
 * the old cached build, whose chunk requests 404 and trigger a single
 * reload - by which point the URL query may already be gone. The copy is
 * cleared when the item sheet actually opens.
 */
const SS_KEY = 'aside.pending-item';
const TTL_MS = 10 * 60_000;

const readSession = (): string | null => {
  try {
    const raw = sessionStorage.getItem(SS_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { id?: unknown; at?: unknown };
    if (typeof v.id !== 'string' || typeof v.at !== 'number') return null;
    if (Date.now() - v.at > TTL_MS) return null;
    return v.id;
  } catch {
    return null;
  }
};

const writeSession = (id: string | null): void => {
  try {
    if (id) sessionStorage.setItem(SS_KEY, JSON.stringify({ id, at: Date.now() }));
    else sessionStorage.removeItem(SS_KEY);
  } catch {
    /* private mode: the in-memory copy still works for this visit */
  }
};

export const deepLinkItem = {
  get(): string | null {
    if (pendingItem) return pendingItem;
    const fromSession = readSession();
    if (fromSession) {
      pendingItem = fromSession;
      writeSession(fromSession); // refresh the TTL
    }
    return pendingItem;
  },
  set(item: string | null): void {
    pendingItem = item;
    writeSession(item);
    for (const l of [...listeners]) l(item);
  },
  subscribe(l: (item: string | null) => void): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

/** The item id out of an /app?item=<id> URL (from a notification payload). */
export function itemIdFromUrl(url: string): string | null {
  const q = url.split('?')[1] ?? '';
  if (!q) return null;
  try {
    return new URLSearchParams(q).get('item');
  } catch {
    return null;
  }
}

/*
 * Thread and planner-tab targets from notification URLs. The planner-item
 * store above stays untouched (NextScreen consumes it); this one covers
 * "open this chat" (?session=<id>) and "open Research" (?tab=research)
 * links from waiting-on-you, error, and research pushes. Same three wake
 * paths as the item store: cold-start URL, iOS-resume stash, live message.
 */
export interface NavTarget {
  thread: string | null;
  tab: string | null;
}

const EMPTY_NAV: NavTarget = { thread: null, tab: null };
let pendingNav: NavTarget = EMPTY_NAV;
const navListeners = new Set<(v: NavTarget) => void>();
const NAV_KEY = 'aside.pending-nav';

const readNavSession = (): NavTarget => {
  try {
    const raw = sessionStorage.getItem(NAV_KEY);
    if (!raw) return EMPTY_NAV;
    const v = JSON.parse(raw) as { thread?: unknown; tab?: unknown; at?: unknown };
    if (typeof v.at !== 'number' || Date.now() - v.at > TTL_MS) return EMPTY_NAV;
    return {
      thread: typeof v.thread === 'string' ? v.thread : null,
      tab: typeof v.tab === 'string' ? v.tab : null,
    };
  } catch {
    return EMPTY_NAV;
  }
};

const writeNavSession = (v: NavTarget): void => {
  try {
    if (v.thread || v.tab) {
      sessionStorage.setItem(NAV_KEY, JSON.stringify({ ...v, at: Date.now() }));
    } else {
      sessionStorage.removeItem(NAV_KEY);
    }
  } catch {
    /* private mode: the in-memory copy still works for this visit */
  }
};

export const deepLinkNav = {
  get(): NavTarget {
    if (pendingNav.thread || pendingNav.tab) return pendingNav;
    const fromSession = readNavSession();
    if (fromSession.thread || fromSession.tab) {
      pendingNav = fromSession;
      writeNavSession(fromSession); // refresh the TTL
    }
    return pendingNav;
  },
  set(v: NavTarget): void {
    pendingNav = v;
    writeNavSession(v);
    for (const l of [...navListeners]) l(v);
  },
  subscribe(l: (v: NavTarget) => void): () => void {
    navListeners.add(l);
    return () => navListeners.delete(l);
  },
};

/** The ?session= and ?tab= targets out of a notification URL. */
export function navFromUrl(url: string): NavTarget | null {
  const q = url.split('?')[1] ?? '';
  if (!q) return null;
  try {
    const p = new URLSearchParams(q);
    const session = p.get('session');
    const tab = p.get('tab');
    if (!session && !tab) return null;
    return { thread: session, tab };
  } catch {
    return null;
  }
}
