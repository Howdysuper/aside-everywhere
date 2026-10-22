import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const replay = vi.fn();
const nextMock = vi.fn().mockResolvedValue({});

vi.mock('../src/api', () => ({
  api: { next: () => nextMock() },
  replayQueued: (p: string, m: string, b: string) => replay(p, m, b),
  setAuthToken: () => {},
  setUnauthorizedHandler: () => {},
  handleUnauthorized: () => {},
  currentAuthToken: () => '',
}));

const { enqueueAction, initOutbox, pendingCount } = await import('../src/offlineQueue');
const { syncNow, startOutboxSync, stopOutboxSync, isSyncing, lastSync, onSyncChange } = await import('../src/offlineSync');

function online(value: boolean): void {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => value });
}

beforeEach(async () => {
  localStorage.clear();
  await initOutbox();
  replay.mockReset();
  nextMock.mockClear();
  online(true);
  stopOutboxSync();
});

afterEach(() => {
  stopOutboxSync();
  vi.useRealTimers();
});

describe('syncNow', () => {
  it('does nothing when the queue is empty', async () => {
    const r = await syncNow();
    expect(r).toBeNull();
    expect(replay).not.toHaveBeenCalled();
  });

  it('does not attempt anything while the browser knows it is offline', async () => {
    online(false);
    await enqueueAction({ label: 'a', method: 'POST', path: '/api/next/tasks', body: '{}' });
    const r = await syncNow();
    expect(r).toBeNull();
    expect(replay).not.toHaveBeenCalled();
    expect(pendingCount()).toBe(1);
  });

  it('delivers what is waiting and reports it', async () => {
    replay.mockResolvedValue(new Response('{}', { status: 200 }));
    await enqueueAction({ label: 'Marked done', method: 'POST', path: '/api/next/x/action', body: '"done"' });
    const r = await syncNow();
    expect(r?.sent).toBe(1);
    expect(pendingCount()).toBe(0);
    expect(replay).toHaveBeenCalledWith('/api/next/x/action', 'POST', '"done"');
  });

  it('re-reads the plan after a plan action lands', async () => {
    replay.mockResolvedValue(new Response('{}', { status: 200 }));
    await enqueueAction({ label: 'Marked done', method: 'POST', path: '/api/next/x/action', body: '"done"' });
    await syncNow();
    expect(nextMock).toHaveBeenCalled();
  });

  it('does not re-read the plan for a chat message', async () => {
    replay.mockResolvedValue(new Response('{}', { status: 200 }));
    await enqueueAction({ label: 'Message: hi', method: 'POST', path: '/api/sessions/s1/send', body: '{"text":"hi"}' });
    await syncNow();
    expect(nextMock).not.toHaveBeenCalled();
  });

  it('collapses overlapping calls so an action is never replayed twice', async () => {
    let resolve!: (r: Response) => void;
    replay.mockImplementation(() => new Promise<Response>((r) => (resolve = r)));
    await enqueueAction({ label: 'a', method: 'POST', path: '/api/next/tasks', body: '{}' });
    const first = syncNow();
    // The flush reads the queue before it calls the network, so wait until it
    // is genuinely waiting on the response before starting the overlap. Handing
    // over `resolve` early would run before the executor ever assigned it.
    await vi.waitFor(() => expect(replay).toHaveBeenCalled());
    const second = await syncNow();
    expect(second).toBeNull();
    expect(isSyncing()).toBe(true);
    resolve(new Response('{}', { status: 200 }));
    const a = await first;
    expect(a?.sent).toBe(1);
    expect(replay).toHaveBeenCalledTimes(1);
    expect(isSyncing()).toBe(false);
  });

  it('reports the outcome to subscribers', async () => {
    replay.mockResolvedValue(new Response('{}', { status: 200 }));
    await enqueueAction({ label: 'a', method: 'POST', path: '/api/next/tasks', body: '{}' });
    const seen: unknown[] = [];
    const off = onSyncChange(() => seen.push(isSyncing()));
    await syncNow();
    off();
    expect(seen.length).toBeGreaterThan(0);
    expect(lastSync()?.sent).toBe(1);
  });
});

describe('startOutboxSync', () => {
  it('loads the queue and makes one attempt at boot', async () => {
    await enqueueAction({ label: 'Marked done', method: 'POST', path: '/api/next/x/action', body: '"done"' });
    replay.mockResolvedValue(new Response('{}', { status: 200 }));
    await startOutboxSync();
    await vi.waitFor(() => expect(replay).toHaveBeenCalled());
    stopOutboxSync();
  });

  it('retries when the browser comes back online', async () => {
    replay.mockRejectedValue(new TypeError('offline'));
    await enqueueAction({ label: 'a', method: 'POST', path: '/api/next/tasks', body: '{}' });
    await startOutboxSync();
    expect(pendingCount()).toBe(1);
    replay.mockResolvedValue(new Response('{}', { status: 200 }));
    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(pendingCount()).toBe(0));
    stopOutboxSync();
  });

  it('retries when the page becomes visible again', async () => {
    replay.mockRejectedValue(new TypeError('offline'));
    await enqueueAction({ label: 'a', method: 'POST', path: '/api/next/tasks', body: '{}' });
    await startOutboxSync();
    replay.mockResolvedValue(new Response('{}', { status: 200 }));
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(pendingCount()).toBe(0));
    stopOutboxSync();
  });

  it('is idempotent: starting twice does not double the listeners', async () => {
    // Count registrations rather than observe a flush: the property is that a
    // second start is a no-op, and a flush's own timing is a different claim.
    const added: string[] = [];
    const realAdd = window.addEventListener.bind(window);
    vi.spyOn(window, 'addEventListener').mockImplementation((type: string, fn: never, opts?: never) => {
      added.push(type);
      return realAdd(type, fn, opts);
    });
    await startOutboxSync();
    await startOutboxSync();
    const onlineListeners = added.filter((t) => t === 'online').length;
    expect(onlineListeners).toBe(1);
    stopOutboxSync();
    vi.restoreAllMocks();
  });
});
