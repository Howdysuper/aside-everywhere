/*
 * The "it ran" report.
 *
 * Failures push the moment they happen, and a check that succeeds stays
 * quiet, so the only signals the phone ever showed were problems. That
 * reads as broken even when it isn't. This builds the one line that closes
 * the loop: when each check last ran, and whether it worked.
 */

export interface CheckEntry {
  kind?: string;
  at?: string;
  summary?: string;
}

/** Ordered so the most school-relevant checks come first on screen. */
export const CHECK_LABELS: Record<string, string> = {
  'schoology.refresh': 'Schoology',
  'mail.sweep': 'School email',
  'mail.personal': 'Personal Gmail',
  'groupme.read': 'GroupMe groups',
  'groupme.dm': 'GroupMe DMs',
};

/** Reads between the lines of a summary for the reason a check failed. */
export function failureReasonOf(summary: string): string | null {
  const m = /did not finish|did not run|threw/i.exec(summary);
  if (!m) return null;
  // "...; it retries in half an hour." is boilerplate on every feed, not a reason.
  let rest = summary.slice(m.index + m[0].length).replace(/^\s*[:–-\u2013-]\s*/, '').trim();
  rest = rest.replace(/^[;,]\s*/, '');
  const reason = rest.split(/\.\s/)[0].trim();
  if (!reason || /it retries|it tries again|re-?login|next pass|waiting|back ?off/i.test(reason)) return 'unknown reason';
  return reason.slice(0, 90);
}

/**
 * How long a feed may go silent before "ok" becomes a lie. These are set
 * well above each feed's real cadence, so a single missed pass is ignored
 * and a genuinely stuck feed is not.
 */
const STALE_AFTER_MS: Record<string, number> = {
  'schoology.refresh': 8 * 3600_000,
  'mail.sweep': 4 * 3600_000,
  'mail.personal': 2 * 3600_000,
  'groupme.read': 2 * 3600_000,
  'groupme.dm': 60 * 60_000,
};

/** A feed whose last entry is older than its own threshold has stopped. */
export function isStale(kind: string, at: string, now: number): boolean {
  const limit = STALE_AFTER_MS[kind];
  if (!limit) return false;
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return false;
  return now - t > limit;
}

export function ageOf(at: string, now: number): string {
  const mins = Math.max(0, Math.round((now - Date.parse(at)) / 60_000));
  if (!Number.isFinite(mins)) return 'just now';
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  return `${hours}h ago`;
}

/**
 * One push per call, or null when the ledger had nothing to report. Entries
 * are expected newest-first, as Ledger.list returns them.
 */
export function buildCheckReport(entries: CheckEntry[], now = Date.now()): { title: string; body: string; tag: string; url: string } | null {
  // Newest per kind by timestamp, not by position: a later line for a feed
  // always beats an earlier one even if the list order surprises us.
  const seen = new Map<string, { e: CheckEntry; at: number }>();
  for (const e of entries) {
    if (!e?.kind || !e.at) continue;
    const at = Date.parse(e.at);
    if (!Number.isFinite(at)) continue;
    const have = seen.get(e.kind);
    if (!have || at > have.at) seen.set(e.kind, { e, at });
  }
  const parts: string[] = [];
  for (const [kind, label] of Object.entries(CHECK_LABELS)) {
    const found = seen.get(kind);
    if (!found) continue;
    const e = found.e;
    const reason = failureReasonOf(String(e.summary ?? ''));
    // A stale feed is the failure that never gets recorded: the last line in
    // the ledger is a success from days ago, so it must be said out loud.
    const stale = isStale(kind, String(e.at), now);
    const state = reason ? `${label} FAILED: ${reason}` : stale ? `${label} STALE` : `${label} ok`;
    parts.push(`${state} (${ageOf(String(e.at), now)})`);
  }
  if (!parts.length) return null;
  return { title: 'Everything is checked', body: parts.join(' · '), tag: 'check:heartbeat', url: '/next' };
}

/** Hours between reports; 0 disables. Overridable without a rebuild. */
export function checkReportHours(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.CHECK_REPORT_HOURS ?? 2);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 24) : 0;
}
