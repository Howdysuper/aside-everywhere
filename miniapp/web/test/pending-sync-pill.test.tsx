/**
 * The "N changes waiting" pill.
 *
 * It is the visible half of the offline queue, so what matters is not its
 * look but what it says and when it says nothing: it must be absent when the
 * outbox is empty, it must name each waiting action rather than just count
 * them, and a tap must actually try to send. A count nobody can expand is
 * another number to trust, which is the thing this app has been burned by.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

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

const { enqueueAction, initOutbox } = await import('../src/offlineQueue');
const { startOutboxSync, stopOutboxSync } = await import('../src/offlineSync');
const { PendingSyncPill } = await import('../src/components/PendingSyncPill');

beforeEach(async () => {
  localStorage.clear();
  await initOutbox();
  replay.mockReset();
  nextMock.mockClear();
  stopOutboxSync();
});

afterEach(() => {
  cleanup();
  stopOutboxSync();
});

describe('PendingSyncPill', () => {
  it('renders nothing when the outbox is empty', async () => {
    render(<PendingSyncPill />);
    expect(screen.queryByText(/waiting for your computer/i)).toBeNull();
  });

  it('names what is waiting, not just how many', async () => {
    await enqueueAction({ label: 'Marked done', method: 'POST', path: '/api/next/x/action', body: '"done"' });
    await enqueueAction({ label: 'New chat: start my essay', method: 'POST', path: '/api/sessions/new', body: '{"text":"start my essay"}' });
    render(<PendingSyncPill />);

    expect(screen.getByText(/2 changes waiting for your computer/i)).toBeTruthy();
    // Expand: the list is the whole point.
    fireEvent.click(screen.getByRole('button', { name: /2 changes waiting/i }));
    expect(screen.getByText('Marked done')).toBeTruthy();
    expect(screen.getByText('New chat: start my essay')).toBeTruthy();
    // And it says what will happen without being asked.
    expect(screen.getByText(/send automatically/i)).toBeTruthy();
  });

  it('tries to send now when the button is pressed', async () => {
    replay.mockResolvedValue(new Response('{}', { status: 200 }));
    await enqueueAction({ label: 'Marked done', method: 'POST', path: '/api/next/x/action', body: '"done"' });
    render(<PendingSyncPill />);
    fireEvent.click(screen.getByRole('button', { name: /1 change waiting/i }));
    fireEvent.click(screen.getByRole('button', { name: /send now/i }));
    await waitFor(() => expect(replay).toHaveBeenCalledWith('/api/next/x/action', 'POST', '"done"'));
  });

  it('disappears once everything has sent', async () => {
    replay.mockResolvedValue(new Response('{}', { status: 200 }));
    await enqueueAction({ label: 'Marked done', method: 'POST', path: '/api/next/x/action', body: '"done"' });
    render(<PendingSyncPill />);
    fireEvent.click(screen.getByRole('button', { name: /1 change waiting/i }));
    fireEvent.click(screen.getByRole('button', { name: /send now/i }));
    await waitFor(() => expect(screen.queryByText(/waiting for your computer/i)).toBeNull());
  });

  it('says the computer is still away instead of pretending it worked', async () => {
    replay.mockRejectedValue(new TypeError('fetch failed'));
    await enqueueAction({ label: 'Marked done', method: 'POST', path: '/api/next/x/action', body: '"done"' });
    render(<PendingSyncPill />);
    fireEvent.click(screen.getByRole('button', { name: /1 change waiting/i }));
    fireEvent.click(screen.getByRole('button', { name: /send now/i }));
    await waitFor(() => expect(screen.getByText(/1 change waiting/i)).toBeTruthy());
    expect(replay).toHaveBeenCalled();
  });

  it('picks up an action queued by another part of the app while it is open', async () => {
    render(<PendingSyncPill />);
    expect(screen.queryByText(/waiting for your computer/i)).toBeNull();
    // Queue something the way the api layer does, then notify subscribers the
    // way the queue does.
    await enqueueAction({ label: 'New chat: hi', method: 'POST', path: '/api/sessions/new', body: '{"text":"hi"}' });
    await waitFor(() => expect(screen.getByText(/1 change waiting/i)).toBeTruthy());
  });
});
