/*
 * Detecting a Schoology sweep that stopped running.
 *
 * A refresh is visible as an mtime change, so a *failure* is invisible: a
 * file nobody writes never changes, and the guard routine's own report of
 * success is prose, not evidence. This decides when a silent file has been
 * silent long enough to be worth a phone notification, and what it says.
 */

/** How long without a refresh before we nag. Sweeps run every few hours. */
export const SCHOOLOGY_STALE_MS = 6 * 60 * 60 * 1000;

/**
 * Nag once per stale episode, not once per minute. `naggedFor` is the mtime
 * already nagged about; a fresh write resets it to 0 and re-arms the alarm.
 */
export function shouldNagStale(mtime: number, now: number, naggedFor: number, thresholdMs = SCHOOLOGY_STALE_MS): boolean {
  if (!Number.isFinite(mtime) || !Number.isFinite(now)) return false;
  if (naggedFor === mtime) return false;
  // A file in the future (clock skew) is not evidence of a stall.
  if (now <= mtime) return false;
  return now - mtime > thresholdMs;
}

/** The push body: what happened, when it last worked, and what to check. */
export function staleMessage(mtime: number, now: number): string {
  const hours = Math.max(1, Math.round((now - mtime) / 3600000));
  const lastAt = new Date(mtime).toLocaleString('en-US', {
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  return `Schoology has not refreshed in ${hours}h (last write ${lastAt}). The sweep is failing, so your homework list is out of date. Check that you are signed in to wcschools.schoology.com in the Aside Browser, and that the Aside Vault is unlocked so the automatic re-login can run.`;
}
