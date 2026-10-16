/**
 * System issues: one file, one push each.
 *
 * Anything that breaks anywhere on this Mac - a model call that failed,
 * a Jev door that paused or ran out of budget, a sweep that could not
 * finish, the tunnel dropping - calls `note()`. Each issue is:
 *
 *   1. Appended to <stateDir>/issues.jsonl, one JSON object per line,
 *      never truncated, so the whole history is there to hand to the
 *      agent when something needs fixing.
 *   2. Pushed to the phone as a "Problem: <where>" notification, once.
 *      The dedupe key is `where` + the message text; the same issue
 *      pushes again only after DEDUPE_MS, so a flapping failure pushes
 *      every few hours instead of every minute.
 *
 * Pushes are never quiet-gated: a broken school-homework feed at 2 AM
 * is exactly when he wants to hear about it. Delivery failures
 * themselves are not re-noted (that would loop), just logged.
 *
 * Nothing here judges severity or decides anything: it is plumbing for
 * the record and the notification.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface IssuePush {
  title: string;
  body: string;
  tag?: string;
  url?: string;
}

/** Send a push to every subscriber. Returns the number delivered. */
export type PushFn = (p: IssuePush) => Promise<number> | number;

const DEDUPE_MS = 6 * 60 * 60 * 1000;
const MAX_BODY = 180;

export const clipIssue = (s: string, n = MAX_BODY): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  return `${t.slice(0, Math.max(1, n - 3)).replace(/\s+\S*$/, '')}...`;
};

interface IssueLine {
  at: string;
  where: string;
  msg: string;
  /** Small structured detail, JSON-safe only. */
  extra?: unknown;
}

export interface IssuesOptions {
  /** Test seam: capture pushes instead of sending. */
  push?: PushFn;
  /** Test seam: skip the file entirely. */
  filePath?: string;
  now?: () => number;
}

export class Issues {
  private lastPushAt = new Map<string, number>();
  private readonly filePath: string | null;
  private readonly push: PushFn | null;
  private readonly now: () => number;

  constructor(
    stateDir: string | null,
    private readonly log?: (msg: string, extra?: unknown) => void,
    o: IssuesOptions = {},
  ) {
    this.filePath = o.filePath ?? (stateDir ? path.join(stateDir, 'issues.jsonl') : null);
    this.push = o.push ?? null;
    this.now = o.now ?? Date.now;
  }

  /**
   * Record one issue and push it (deduped). Never throws: the recording
   * path must not itself break the thing it is recording.
   */
  note(where: string, msg: string, extra?: unknown): void {
    try {
      const line: IssueLine = { at: new Date(this.now()).toISOString(), where, msg: clipIssue(msg, 400) };
      if (extra !== undefined) line.extra = extra;
      if (this.filePath) {
        try {
          fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
          fs.appendFileSync(this.filePath, `${JSON.stringify(line)}\n`);
        } catch (err) {
          this.log?.('issues append failed', err);
        }
      }
      this.log?.(`issue ${where}: ${clipIssue(msg)}`);
      if (!this.push) return;
      const key = `${where}|${clipIssue(msg, 120)}`;
      const last = this.lastPushAt.get(key);
      const t = this.now();
      if (last && t - last < DEDUPE_MS) return;
      this.lastPushAt.set(key, t);
      const tag = `issue:${where}`;
      void Promise.resolve(this.push({ title: `Problem: ${where}`, body: clipIssue(msg), tag, url: '/app' })).catch(
        (err) => this.log?.('issue push failed', err),
      );
    } catch {
      /* a recorder that can throw is worse than no recorder */
    }
  }

  /**
   * Deliver recent lines written by anyone (another process included)
   * that this recorder has not pushed yet. The 2-minute window means a
   * restart does not replay the tail of the log, and note()'s own dedupe
   * map keeps the app's own notes from doubling.
   */
  pushUnseen(maxAgeMs = 120_000): void {
    if (!this.push) return;
    const t = this.now();
    for (const line of this.read()) {
      const at = Date.parse(line.at);
      if (!Number.isFinite(at) || t - at > maxAgeMs) continue;
      const key = `${line.where}|${clipIssue(line.msg, 120)}`;
      const last = this.lastPushAt.get(key);
      if (last && t - last < DEDUPE_MS) continue;
      this.lastPushAt.set(key, t);
      void Promise.resolve(
        this.push({ title: `Problem: ${line.where}`, body: clipIssue(line.msg), tag: `issue:${line.where}`, url: '/app' }),
      ).catch((err) => this.log?.('issue push failed', err));
    }
  }

  /** Every issue recorded so far, oldest last. */
  read(): IssueLine[] {
    if (!this.filePath) return [];
    try {
      return fs
        .readFileSync(this.filePath, 'utf8')
        .split('\n')
        .filter((l) => l.trim().startsWith('{'))
        .map((l) => {
          try {
            return JSON.parse(l) as IssueLine;
          } catch {
            return null;
          }
        })
        .filter((x): x is IssueLine => x !== null);
    } catch {
      return [];
    }
  }
}

/**
 * Append one issue line from anywhere, including a process that cannot
 * push (the tunnel supervisor in index.ts has no access to the push
 * sender). The app's minute loop calls `pushUnseen` to deliver these.
 */
export function appendIssue(stateDir: string, where: string, msg: string): void {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    const line: IssueLine = { at: new Date().toISOString(), where, msg: clipIssue(msg, 400) };
    fs.appendFileSync(path.join(stateDir, 'issues.jsonl'), `${JSON.stringify(line)}\n`);
  } catch {
    /* recording must never break the caller */
  }
}

/** Dedupe window exposed for tests. */
export const ISSUE_DEDUPE_MS = DEDUPE_MS;
