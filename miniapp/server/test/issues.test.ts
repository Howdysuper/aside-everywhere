import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Issues, appendIssue, clipIssue } from '../src/issues.js';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'issues-test-'));
}

describe('issue recording', () => {
  it('writes one JSON line per issue and clips long text', () => {
    const d = tmp();
    const iss = new Issues(d, undefined, { now: () => Date.parse('2026-10-16T20:00:00Z') });
    iss.note('Jev', 'Jev is out of budget for today (240/240 used).');
    iss.note('Gmail', `A sweep threw with a very long message ${'x'.repeat(500)}`);
    const lines = iss.read();
    expect(lines).toHaveLength(2);
    expect(lines[0].where).toBe('Jev');
    expect(lines[1].msg.length).toBeLessThanOrEqual(400);
    expect(fs.statSync(path.join(d, 'issues.jsonl')).size).toBeGreaterThan(0);
  });

  it('pushes once per issue and dedupes within the window', () => {
    const d = tmp();
    const sent: Array<{ title: string; body: string; tag?: string }> = [];
    const iss = new Issues(d, undefined, { push: (p) => { sent.push(p); return 1; }, now: () => Date.parse('2026-10-16T20:00:00Z') });
    iss.note('Pushes', 'A push pass failed (boom).');
    iss.note('Pushes', 'A push pass failed (boom).');
    iss.note('Pushes', 'A push pass failed (boom).');
    expect(sent).toHaveLength(1);
    expect(sent[0].title).toBe('Problem: Pushes');
    expect(sent[0].tag).toBe('issue:Pushes');
    iss.note('Jev', 'A different problem entirely.');
    expect(sent).toHaveLength(2);
  });

  it('pushes again after the dedupe window passes', () => {
    const d = tmp();
    const sent: Array<{ title: string }> = [];
    let now = Date.parse('2026-10-16T20:00:00Z');
    const iss = new Issues(d, undefined, { push: (p) => { sent.push(p); return 1; }, now: () => now });
    iss.note('Gmail', 'flapping failure');
    now += 6 * 60 * 60 * 1000 + 1;
    iss.note('Gmail', 'flapping failure');
    expect(sent).toHaveLength(2);
  });

  it('delivers recent lines written by another process', () => {
    const d = tmp();
    const sent: Array<{ title: string; body: string }> = [];
    // The appended line is stamped with real time, so the recorder uses the
    // real clock for this one: the scan window is measured against now.
    const iss = new Issues(d, undefined, { push: (p) => { sent.push(p); return 1; } });
    // Another process (the tunnel supervisor) appends directly.
    appendIssue(d, 'Tunnel', 'cloudflared health check failed, respawning');
    expect(iss.read()).toHaveLength(1);
    iss.pushUnseen();
    expect(sent).toHaveLength(1);
    expect(sent[0].title).toBe('Problem: Tunnel');
    // A second scan does not repeat it.
    iss.pushUnseen();
    expect(sent).toHaveLength(1);
  });

  it('ignores old lines on a restart so history never replays', () => {
    const d = tmp();
    const old = { at: new Date(Date.now() - 60 * 60 * 1000).toISOString(), where: 'Tunnel', msg: 'an old failure from yesterday' };
    fs.writeFileSync(path.join(d, 'issues.jsonl'), `${JSON.stringify(old)}\n`);
    const sent: Array<{ title: string }> = [];
    const iss = new Issues(d, undefined, { push: (p) => { sent.push(p); return 1; } });
    iss.pushUnseen();
    expect(sent).toHaveLength(0);
  });

  it('never throws when the state dir cannot be created', () => {
    const d = tmp();
    // A regular FILE where the state dir should be: mkdir cannot make a dir
    // inside a file, so every write fails.
    const asFile = path.join(d, 'not-a-dir');
    fs.writeFileSync(asFile, 'x');
    const iss = new Issues(asFile, undefined, { push: () => 0 });
    expect(() => iss.note('Test', 'records nothing and survives')).not.toThrow();
    expect(iss.read()).toEqual([]);
  });

  it('clips gracefully', () => {
    expect(clipIssue('  spaced   out  ')).toBe('spaced out');
    expect(clipIssue('x'.repeat(300)).length).toBeLessThanOrEqual(180);
  });
});
