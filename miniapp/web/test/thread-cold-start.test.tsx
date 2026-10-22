/**
 * A brand-new chat must survive being asked for before it exists.
 *
 * The server creates a session, answers `newSession` with the id, and writes
 * the transcript a moment later. The phone navigates on the id, so a thread
 * opened straight after a send can lose that race and get
 * `session_not_found` for a chat that is very much still there.
 *
 * That used to be terminal: one failed load, a permanent "this chat is no
 * longer on your computer", and no retry anywhere. What these lock in is
 * that a young chat says nothing and a genuinely gone chat still says so.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

const threadMock = vi.fn();

// A socket that never fires anything: these tests are about the REST load.
class QuietSocket {
  setRev(): void {}
  subscribe(): void {}
  connect(): void {}
  close(): void {}
}

vi.mock('../src/api', () => ({
  api: {
    thread: (id: string, rev?: string) => threadMock(id, rev),
    next: () => Promise.resolve({}),
  },
  TranscriptSocket: QuietSocket,
  replayQueued: () => Promise.resolve(new Response('{}', { status: 200 })),
  setAuthToken: () => {},
  setUnauthorizedHandler: () => {},
  handleUnauthorized: () => {},
  currentAuthToken: () => '',
}));

const { useThread } = await import('../src/hooks/useThread');

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('opening a brand-new chat', () => {
  it('retries a session_not_found instead of declaring the chat gone', async () => {
    // The cold-start race: first two attempts 404, then the file appears.
    let calls = 0;
    threadMock.mockImplementation(() => {
      calls += 1;
      if (calls <= 2) {
        return Promise.reject(Object.assign(new Error('404: session_not_found'), { status: 404 }));
      }
      return Promise.resolve({
        sessionId: 'brandnew',
        rev: '1',
        items: [{ id: 'u1', role: 'user', text: 'hello', at: 0 }],
        status: 'running',
        busy: true,
        title: 'hello',
        sources: [],
        stats: { calls: 0, cost: 0, tokens: 0 },
      });
    });

    const { result } = renderHook(() => useThread('brandnew'));

    // It keeps trying, and never shows the "chat is gone" card.
    await waitFor(() => expect(result.current.items.length).toBe(1), { timeout: 4000 });
    expect(result.current.error).toBeNull();
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it('still reports a chat that really is gone, once retries are spent', async () => {
    threadMock.mockImplementation(() =>
      Promise.reject(Object.assign(new Error('404: session_not_found'), { status: 404 })),
    );

    const { result } = renderHook(() => useThread('deleted'));
    // Four retries at up to a second each: the point is that it eventually
    // says so, not that it says so instantly.
    await waitFor(() => expect(result.current.error).toBe('This chat is no longer on your computer.'), { timeout: 15_000 });
  }, 20_000);
});
