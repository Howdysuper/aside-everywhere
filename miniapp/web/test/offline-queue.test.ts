import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  enqueueAction,
  flushOutbox,
  initOutbox,
  isQueueable,
  kindFor,
  onQueueChange,
  pendingCount,
  pendingActions,
  type FlushResult,
} from '../src/offlineQueue';
import { OfflineQueuedError, api, queuedLabel } from '../src/api';

/** jsdom has no IndexedDB, so these exercise the localStorage floor. */
async function resetQueue(): Promise<void> {
  localStorage.clear();
  // The module keeps an in-memory mirror for synchronous reads; without this
  // the previous test's actions would still be in it.
  await initOutbox();
}

beforeEach(async () => {
  await resetQueue();
  vi.restoreAllMocks();
});

describe('isQueueable', () => {
  it('accepts the actions a person takes from the phone', () => {
    expect(isQueueable('POST', '/api/sessions/s1/send')).toBe(true);
    expect(isQueueable('POST', '/api/sessions/s1/steer')).toBe(true);
    expect(isQueueable('POST', '/api/next/item-7/action')).toBe(true);
    expect(isQueueable('POST', '/api/next/tasks')).toBe(true);
    expect(isQueueable('PATCH', '/api/next/tasks/item-7')).toBe(true);
    expect(isQueueable('POST', '/api/next/pause')).toBe(true);
    expect(isQueueable('POST', '/api/next/projects')).toBe(true);
    expect(isQueueable('POST', '/api/next/projects/p1/milestones')).toBe(true);
    expect(isQueueable('PATCH', '/api/next/projects/p1/milestones/m1')).toBe(true);
    expect(isQueueable('DELETE', '/api/next/projects/p1/milestones/m1')).toBe(true);
    expect(isQueueable('POST', '/api/next/projects/p1/proposal/apply')).toBe(true);
  });

  it('refuses anything that would do unattended work on the computer', () => {
    // Agent launches: real side effects, and a surprise hours later.
    expect(isQueueable('POST', '/api/next/item-7/start')).toBe(false);
    expect(isQueueable('POST', '/api/next/item-7/start/cancel')).toBe(false);
    // Sweep triggers: pointless to replay, the server runs them itself.
    expect(isQueueable('POST', '/api/next/refresh')).toBe(false);
    expect(isQueueable('POST', '/api/next/personal/refresh')).toBe(false);
    // A pure lookup is not a mutation at all.
    expect(isQueueable('POST', '/api/next/suggest-space')).toBe(false);
  });

  it('never queues a read', () => {
    expect(isQueueable('GET', '/api/next')).toBe(false);
    expect(isQueueable('GET', '/api/next/tasks')).toBe(false);
  });
});

describe('kindFor', () => {
  it('splits chat from plan', () => {
    expect(kindFor('/api/sessions/s1/send')).toBe('chat');
    expect(kindFor('/api/next/tasks')).toBe('plan');
    expect(kindFor('/api/settings')).toBe('other');
  });
});

describe('queuedLabel', () => {
  it('names each action the way the person thinks of it', () => {
    // Both the home composer's new chat and a reply inside a thread read as
    // the same thing to the person who typed them.
    expect(queuedLabel('/api/sessions/new', JSON.stringify({ text: 'start my essay' }))).toBe('New chat: start my essay');
    expect(queuedLabel('/api/sessions/s1/send', JSON.stringify({ text: 'finish the essay' }))).toBe('New chat: finish the essay');
    expect(queuedLabel('/api/sessions/s1/steer', JSON.stringify({ text: 'stop' }))).toBe('Steer: stop');
    expect(queuedLabel('/api/next/tasks', JSON.stringify({ title: 'Read chapter 4' }))).toBe('New task: Read chapter 4');
    expect(queuedLabel('/api/next/x/action', JSON.stringify({ action: 'done' }))).toBe('Marked done');
    expect(queuedLabel('/api/next/x/action', JSON.stringify({ action: 'dismiss' }))).toBe('Dismissed');
    expect(queuedLabel('/api/next/x/action', JSON.stringify({ action: 'later' }))).toBe('Moved to later');
    expect(queuedLabel('/api/next/pause', JSON.stringify({ paused: true }))).toBe('Paused the planner');
    expect(queuedLabel('/api/next/pause', JSON.stringify({ paused: false }))).toBe('Resumed the planner');
  });

  it('survives a body it cannot parse', () => {
    expect(queuedLabel('/api/sessions/s1/send', 'not json')).toBe('New chat: (no text)');
  });
});

describe('enqueueAction', () => {
  it('stores an action and reports it as pending', async () => {
    const a = await enqueueAction({ label: 'Marked done', method: 'POST', path: '/api/next/x/action', body: '{}' });
    expect(a).not.toBeNull();
    expect(pendingCount()).toBe(1);
    expect(pendingActions()[0].label).toBe('Marked done');
    expect(pendingActions()[0].kind).toBe('plan');
  });

  it('drops an immediate double-tap of the same action', async () => {
    await enqueueAction({ label: 'New task: X', method: 'POST', path: '/api/next/tasks', body: JSON.stringify({ title: 'X' }) });
    const second = await enqueueAction({ label: 'New task: X', method: 'POST', path: '/api/next/tasks', body: JSON.stringify({ title: 'X' }) });
    expect(second).toBeNull();
    expect(pendingCount()).toBe(1);
  });

  it('keeps the same action sent again after the dedupe window', async () => {
    await enqueueAction({ label: 'New task: X', method: 'POST', path: '/api/next/tasks', body: '{"title":"X"}' });
    const aged = pendingActions()[0];
    // Reach into the mirror through a second enqueue after time passes.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 10_000);
    const again = await enqueueAction({ label: 'New task: X', method: 'POST', path: '/api/next/tasks', body: '{"title":"X"}' });
    vi.useRealTimers();
    expect(again).not.toBeNull();
    expect(pendingCount()).toBe(2);
    expect(aged.label).toBe('New task: X');
  });

  it('notifies subscribers', async () => {
    const seen: number[] = [];
    const off = onQueueChange(() => seen.push(pendingCount()));
    await enqueueAction({ label: 'a', method: 'POST', path: '/api/next/tasks', body: '{}' });
    await enqueueAction({ label: 'b', method: 'POST', path: '/api/next/tasks', body: '{"x":1}' });
    off();
    expect(seen).toEqual([1, 2]);
  });

  it('reloads what survived a restart', async () => {
    await enqueueAction({ label: 'Marked done', method: 'POST', path: '/api/next/x/action', body: '{}' });
    const reloaded = await initOutbox();
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0].label).toBe('Marked done');
  });
});

describe('flushOutbox', () => {
  async function seed(n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      await enqueueAction({ label: `a${i}`, method: 'POST', path: '/api/next/tasks', body: `{"i":${i}}` });
    }
  }

  function ok(): Response {
    return new Response('{}', { status: 200 });
  }

  it('delivers in oldest-first order and empties the queue', async () => {
    await seed(3);
    const order: string[] = [];
    const res = await flushOutbox(async (path, method, body) => {
      order.push(body);
      return ok();
    });
    expect(order).toEqual(['{"i":0}', '{"i":1}', '{"i":2}']);
    expect(res.sent).toBe(3);
    expect(res.remaining).toBe(0);
    expect(pendingCount()).toBe(0);
  });

  it('says the plan needs re-reading when a plan action was sent', async () => {
    await seed(1);
    const res = await flushOutbox(async () => ok());
    expect(res.planTouched).toBe(true);
  });

  it('stops and keeps everything when the computer is still away', async () => {
    await seed(3);
    const res = await flushOutbox(async () => {
      throw new TypeError('fetch failed');
    });
    expect(res.offline).toBe(true);
    expect(res.sent).toBe(0);
    expect(res.remaining).toBe(3);
    expect(pendingCount()).toBe(3);
  });

  it('stops on a 401 so auth can handle it, without losing the queue', async () => {
    await seed(2);
    const res = await flushOutbox(async () => new Response('', { status: 401 }));
    expect(res.sent).toBe(0);
    expect(res.remaining).toBe(2);
    expect(res.lastError).toMatch(/paired again/i);
  });

  it('drops a 4xx so one bad action cannot jam the ones behind it', async () => {
    await seed(3);
    let n = 0;
    const res = await flushOutbox(async () => {
      n += 1;
      return n === 1 ? new Response(JSON.stringify({ reason: 'already done' }), { status: 409 }) : ok();
    });
    expect(res.rejected).toBe(1);
    expect(res.sent).toBe(2);
    expect(res.remaining).toBe(0);
    expect(res.lastError).toMatch(/already done/);
  });

  it('leaves a 5xx queued and stops, because order matters', async () => {
    await seed(3);
    const res = await flushOutbox(async () => new Response('', { status: 503 }));
    expect(res.sent).toBe(0);
    expect(res.remaining).toBe(3);
    expect(res.lastError).toMatch(/retry/i);
  });

  it('treats a chat send as not needing a plan refresh', async () => {
    await enqueueAction({ label: 'Message: hi', method: 'POST', path: '/api/sessions/s1/send', body: '{"text":"hi"}' });
    const res = await flushOutbox(async () => ok());
    expect(res.sent).toBe(1);
    expect(res.planTouched).toBe(false);
  });
});

describe('api integration', () => {
  it('queues a brand-new chat started from the home composer', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    await expect(api.newSession({ text: 'start my essay' })).rejects.toBeInstanceOf(OfflineQueuedError);
    expect(pendingCount()).toBe(1);
    expect(pendingActions()[0].path).toBe('/api/sessions/new');
    expect(pendingActions()[0].label).toBe('New chat: start my essay');
  });

  it('queues a send when the computer does not answer, instead of throwing it away', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    await expect(api.send('s1', { text: 'do the homework' })).rejects.toBeInstanceOf(OfflineQueuedError);
    expect(pendingCount()).toBe(1);
    expect(pendingActions()[0].kind).toBe('chat');
    expect(pendingActions()[0].path).toBe('/api/sessions/s1/send');
  });

  it('queues marking an item done', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    await expect(api.nextAction('item-7', 'done' as never)).rejects.toBeInstanceOf(OfflineQueuedError);
    expect(pendingActions()[0].label).toBe('Marked done');
    expect(pendingActions()[0].kind).toBe('plan');
  });

  it('still throws a plain error for a route that is not queued', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    await expect(api.nextStart('item-7')).rejects.not.toBeInstanceOf(OfflineQueuedError);
    expect(pendingCount()).toBe(0);
  });

  it('does not queue a request the user aborted', async () => {
    const err = new DOMException('aborted', 'AbortError');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(err));
    await expect(api.send('s1', { text: 'never mind' })).rejects.toBeInstanceOf(DOMException);
    expect(pendingCount()).toBe(0);
  });

  it('does not queue when the server answers with an error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ reason: 'bad model' }), { status: 400 })),
    );
    await expect(api.send('s1', { text: 'hello' })).rejects.toBeInstanceOf(Error);
    expect(pendingCount()).toBe(0);
  });
});
