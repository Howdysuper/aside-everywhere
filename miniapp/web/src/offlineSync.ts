/**
 * Flushing the outbox.
 *
 * The queue is only half of the feature; the other half is that a change
 * made while the computer was asleep actually leaves the phone, without the
 * person reopening anything or asking for it. This module owns that.
 *
 * It runs on the events that mean "the computer might be back" rather than
 * on a fast timer, because every attempt while the Mac is away is a wasted
 * round trip on a phone that may be on cellular:
 *
 *   the browser's own `online` event,
 *   the page becoming visible again (coming back to the app),
 *   a slow sweep as a safety net for an `online` event that never fired,
 *   and one attempt right after boot, because the common case is opening
 *   the app again after the computer woke up.
 *
 * One flush at a time, and never while the browser says it is offline: a
 * flush that is already in flight must not be joined by a second one that
 * would replay the same action twice.
 */
import { api, replayQueued } from './api';
import { flushOutbox, initOutbox, pendingCount, type FlushResult } from './offlineQueue';

/** Safety-net cadence. The event hooks handle the normal case. */
const SWEEP_MS = 20_000;

let running = false;
let armed = false;
let timer: number | undefined;
/** Bumped whenever a flush finishes, so the UI can render a change. */
let lastResult: FlushResult | null = null;
const listeners = new Set<() => void>();
/** Everything to unhook on teardown, so stopping is not hand-written twice. */
const teardown: Array<() => void> = [];

function emit(): void {
  for (const cb of listeners) cb();
}

/** Subscribe to sync outcomes (for the pending badge and toasts). */
export function onSyncChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function lastSync(): FlushResult | null {
  return lastResult;
}

export function isSyncing(): boolean {
  return running;
}

/**
 * Try to deliver everything waiting. Safe to call often; overlapping calls
 * collapse into the one already in flight.
 */
export async function syncNow(): Promise<FlushResult | null> {
  if (running) return null;
  if (pendingCount() === 0) return null;
  // The browser knows it is offline. Attempting anyway is a guaranteed
  // failure and, on a phone, a wasted wakeup.
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return null;

  running = true;
  emit();
  try {
    const result = await flushOutbox(replayQueued);
    lastResult = result;
    if (result.sent > 0 || result.rejected > 0) {
      // A plan action landed, so what the phone is showing is stale. The
      // live-plan hook polls on its own; this just moves it sooner.
      if (result.planTouched) void api.next().catch(() => undefined);
    }
    emit();
    return result;
  } catch {
    return null;
  } finally {
    running = false;
    emit();
  }
}

/** Load the queue and start listening. Called once at boot. */
export async function startOutboxSync(): Promise<void> {
  await initOutbox();
  if (typeof window === 'undefined') return;
  // This runs at boot, when no flush can legitimately be in flight, so a
  // `running` left true is a flush that never settled. Before the replay
  // timeout existed that state was permanent and the outbox would never send
  // again without a reload; clearing it here makes boot self-healing.
  running = false;
  if (armed) return;
  armed = true;

  const kick = (): void => void syncNow();
  const onVisible = (): void => {
    if (document.visibilityState === 'visible') kick();
  };

  teardown.push(() => window.removeEventListener('online', kick));
  teardown.push(() => document.removeEventListener('visibilitychange', onVisible));

  window.addEventListener('online', kick);
  // Coming back to the app is the strongest signal there is: the person is
  // looking at the screen right now and wants to see their change landed.
  document.addEventListener('visibilitychange', onVisible);

  // The safety net, and also the path that picks up a flush that failed
  // while the page was in the background. Unref'd so it can never be the
  // reason a process stays alive.
  timer = window.setInterval(kick, SWEEP_MS);
  (timer as unknown as { unref?: () => void }).unref?.();

  // One attempt at boot. If the computer came back while the phone was
  // closed, this is what sends the backlog.
  kick();
}

/*
 * A queue change deliberately does not trigger a flush of its own.
 *
 * It looked harmless and it was not: the flush emits when it removes an
 * action, that emit reached this hook, and the hook started another flush,
 * which emitted again. When the queue could not drain in one pass the whole
 * thing became a microtask loop that never yielded -- no timer fired, so a
 * test timeout could not interrupt it, and a phone would have seen a frozen
 * tab rather than a retry.
 *
 * The three triggers that remain -- boot, `online`, and becoming visible --
 * cover every real case, and none of them can be reached from inside a
 * flush.
 */

/** Stop listening. Used by tests and by a full app teardown. */
export function stopOutboxSync(): void {
  // Unconditional on purpose. An early return keyed on `armed` used to leave
  // a live interval behind whenever teardown ran after a failed start, and a
  // timer nobody owns keeps the process awake forever.
  armed = false;
  for (const fn of teardown) fn();
  teardown.length = 0;
  if (timer !== undefined) window.clearInterval(timer);
  timer = undefined;
  listeners.clear();
}
