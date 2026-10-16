/**
 * Offline scheduler test for runPush. Fake sender records every payload;
 * deterministic clock injected. Covers: prime, new, due-soon, late catch-up,
 * 3-week heads-up, quiet hold + release, digest (incl. wake-late catch-up),
 * sync-stall nag, daily cap.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runPush } from 'file:///C:/Users/shaur/aside-phone/miniapp/server/dist/nextpush.js';

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-test-'));
const stallFile = path.join(dir, 'item-notes.json');
fs.writeFileSync(stallFile, '{}');

const sent = [];
const fakeSender = { sendAll: async (p) => { sent.push(p); return 1; }, count: () => 1 };
const at = (h, m, day = 14) => new Date(2026, 9, day, h, m, 0); // Oct 2026; the 14th is a Wednesday

const mk = (id, dueISO, extra = {}) => ({
  id, source: 'schoology', space: 'school', title: `Item ${id}`,
  context: 'AP Chem', dueISO, estMinutes: null, lane: 'homework', why: '', url: null,
  steps: [], confidence: 1, score: 50, overdue: false, lateConfirmed: false,
  status: 'open', closedBy: null, closedAt: null, snoozedUntil: null, sessionId: null,
  kind: 'homework', brief: null, trail: null, taint: null, flag: null, flagReason: null, link: null,
  ...extra,
});

const iso = (h, m, day = 14) => new Date(2026, 9, day, h, m, 0).toISOString();

// Fresh stall file mtime (now)
fs.utimesSync(stallFile, new Date(), new Date());

console.log('1. prime run: nothing announced as new; one first-run digest is fine');
{
  const items = [mk('A', iso(23, 55, 17))]; // due in 3 days
  await runPush(items, { dir, sender: fakeSender, now: at(7, 0), schoologyStatePath: stallFile });
  ok('prime: no new-item push', !sent.some((p) => p.tag === 'new'), JSON.stringify(sent.map((p) => p.tag)));
  ok('prime: first-run digest allowed', sent.filter((p) => p.tag === 'digest').length <= 1);
}

console.log('2. new item after school fires immediately (7 AM is quiet/school)');
{
  sent.length = 0;
  const items = [mk('A', iso(23, 55, 17)), mk('B', iso(23, 55))];
  await runPush(items, { dir, sender: fakeSender, now: at(16, 0), schoologyStatePath: stallFile });
  const push = sent.find((p) => p.tag === 'new');
  ok('new push sent', Boolean(push), JSON.stringify(sent.map((p) => p.tag)));
  ok('new copy', push.body === 'Item B, AP Chem — due 11:55 PM today', push.body);
}

console.log('3. due-soon at T-2h (exempt from quiet — school afternoon)');
{
  sent.length = 0;
  const items = [mk('A', iso(23, 55, 17)), mk('B', iso(16, 0))];
  await runPush(items, { dir, sender: fakeSender, now: at(14, 0), schoologyStatePath: stallFile });
  const push = sent.find((p) => p.tag === 'soon-B');
  ok('due-soon during school hours', Boolean(push), JSON.stringify(sent.map((p) => p.tag)));
  ok('due-soon title', push.title === 'Due soon: Item B', push.title);
  ok('due-soon copy', push.body === 'AP Chem - due today at 4:00 PM', push.body);
  ok('due-soon deep link', push.url === '/app?item=B', push.url);
  await runPush(items, { dir, sender: fakeSender, now: at(14, 30), schoologyStatePath: stallFile });
  ok('due-soon not repeated', sent.filter((p) => p.tag === 'soon-B').length === 1);
}

console.log('4. late catch-up after sleep');
{
  sent.length = 0;
  const items = [mk('A', iso(23, 55, 17)), mk('B', iso(16, 0))];
  // Machine "slept" through the T-2h ping; wakes 5h after due.
  await runPush(items, { dir, sender: fakeSender, now: at(21, 0), schoologyStatePath: stallFile });
  const push = sent.find((p) => p.tag === 'late');
  ok('late push sent', Boolean(push), JSON.stringify(sent.map((p) => p.tag)));
  ok('late title', push.title === 'Now late: Item B', push.title);
  ok('late copy', push.body === 'AP Chem - was due today at 4:00 PM', push.body);
  ok('late deep link', push.url === '/app?item=B', push.url);
}

console.log('5. three-week heads-up (skipped for brand-new items, fires next pass)');
{
  sent.length = 0;
  const items = [mk('A', iso(23, 55, 17)), mk('B', iso(16, 0)), mk('C', iso(15, 0, 14 + 20))]; // C: 20 days out
  await runPush(items, { dir, sender: fakeSender, now: at(16, 0), schoologyStatePath: stallFile });
  ok('C announced as new, not double-pinged', !sent.some((p) => p.tag === 'w3-C') && sent.some((p) => p.tag === 'new'), JSON.stringify(sent.map((p) => p.tag)));
  await runPush(items, { dir, sender: fakeSender, now: at(16, 5), schoologyStatePath: stallFile });
  const push = sent.find((p) => p.tag === 'w3-C');
  ok('w3 push sent once', Boolean(push), JSON.stringify(sent.map((p) => p.tag)));
  ok('w3 title', push.title === 'Coming up: Item C', push.title);
  ok('w3 copy', push.body === 'AP Chem - due Tue 11/3 (20 days out)', push.body);
  ok('w3 deep link', push.url === '/app?item=C', push.url);
  await runPush(items, { dir, sender: fakeSender, now: at(16, 10), schoologyStatePath: stallFile });
  ok('w3 not repeated', sent.filter((p) => p.tag === 'w3-C').length === 1);
}

console.log('6. quiet holds new items, releases after school');
{
  sent.length = 0;
  const items = [mk('A', iso(23, 55, 17)), mk('B', iso(16, 0)), mk('C', iso(15, 0, 16 + 20)), mk('D', iso(23, 0, 20))];
  await runPush(items, { dir, sender: fakeSender, now: at(9, 0), schoologyStatePath: stallFile });
  ok('held during school', !sent.some((p) => p.tag === 'new'));
  await runPush(items, { dir, sender: fakeSender, now: at(16, 0), schoologyStatePath: stallFile });
  const rel = sent.find((p) => p.tag === 'new');
  ok('released after school', Boolean(rel), JSON.stringify(sent.map((p) => p.tag)));
  ok('release copy', rel.body.includes('Item D'), rel.body);
}

console.log('7. morning digest with missing/today/coming-up; wake-late catch-up');
{
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'push-test2-'));
  sent.length = 0;
  const items = [
    mk('M1', iso(9, 0, 12), { title: 'Missing WS' }), // schoology, past due = missing
    mk('T1', iso(20, 0, 14), { title: 'Tonight quiz' }),
    mk('U1', iso(12, 0, 19), { title: 'Next week lab' }),
  ];
  // Computer woke at 8:00 AM, well past the 6:45 digest window.
  await runPush(items, { dir: dir2, sender: fakeSender, now: at(8, 0), schoologyStatePath: stallFile });
  const dig = sent.find((p) => p.tag === 'digest');
  ok('digest fired after late wake', Boolean(dig), JSON.stringify(sent.map((p) => p.tag)));
  ok('digest title counts', dig.title === '1 missing, 1 due today', dig.title);
  ok('digest missing section', dig.body.includes('Missing: Missing WS'), dig.body);
  ok('digest today section', dig.body.includes('Due today: Tonight quiz (8:00 PM)'), dig.body);
  ok('digest coming up', dig.body.includes('Coming up: Next week lab Mon 10/19'), dig.body);
  await runPush(items, { dir: dir2, sender: fakeSender, now: at(8, 5), schoologyStatePath: stallFile });
  ok('digest once per day', sent.filter((p) => p.tag === 'digest').length === 1);
}

console.log('8. sync-stall nag');
{
  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'push-test3-'));
  sent.length = 0;
  const old = new Date(at(10, 0).getTime() - 48 * 3600 * 1000);
  fs.utimesSync(stallFile, old, old);
  await runPush([], { dir: dir3, sender: fakeSender, now: at(10, 0), schoologyStatePath: stallFile });
  const nag = sent.find((p) => p.tag === 'stall');
  ok('stall nag sent', Boolean(nag), JSON.stringify(sent.map((p) => p.tag)));
  ok('stall copy', (nag?.body ?? '').includes('sign in again'), nag?.body);
  await runPush([], { dir: dir3, sender: fakeSender, now: at(11, 0), schoologyStatePath: stallFile });
  ok('stall nag once per day', sent.filter((p) => p.tag === 'stall').length === 1);
}

console.log('9. daily cap');
{
  const dir4 = fs.mkdtempSync(path.join(os.tmpdir(), 'push-test4-'));
  sent.length = 0;
  for (let i = 0; i < 20; i++) {
    // Each run introduces a fresh item -> a fresh new-item push, same day.
    const items = Array.from({ length: i + 1 }, (_, j) => mk(`X${j}`, iso(23, 55, 17)));
    await runPush(items, { dir: dir4, sender: fakeSender, now: at(16, 0, 15), schoologyStatePath: stallFile });
  }
  ok('capped at 15 sends/day', sent.length <= 15, String(sent.length));
  ok('cap actually engaged (15 sends, not 0/20)', sent.length === 15, String(sent.length));
}

console.log('10. announcements: primed once, then new posts push (quiet holds them)');
{
  const dir5 = fs.mkdtempSync(path.join(os.tmpdir(), 'push-test5-'));
  sent.length = 0;
  const notes = [{ id: 'schoology-groups:1', title: 'Practice moved to 5' }];
  await runPush([], { dir: dir5, sender: fakeSender, now: at(16, 0), notices: notes, schoologyStatePath: stallFile });
  ok('notices primed without announcing', !sent.some((p) => p.tag === 'new'), JSON.stringify(sent.map((p) => p.tag)));
  const notes2 = [...notes, { id: 'schoology-groups:2', title: 'Field trip form due Fri' }];
  await runPush([], { dir: dir5, sender: fakeSender, now: at(16, 1), notices: notes2, schoologyStatePath: stallFile });
  const ann = sent.find((p) => p.tag === 'new');
  ok('new announcement pushed', Boolean(ann) && ann.title === 'New announcement', JSON.stringify(sent.map((p) => p.tag)));
  ok('announcement copy', (ann?.body ?? '').includes('Field trip form due Fri'), ann?.body);
  await runPush([], { dir: dir5, sender: fakeSender, now: at(16, 2), notices: [...notes2, { id: 'schoology-groups:3', title: 'Snow day' }], schoologyStatePath: stallFile });
  const news = sent.filter((p) => p.tag === 'new');
  ok('seen posts never re-announce, new ones do', news.length === 2 && news[1].body.includes('Snow day') && !news[1].body.includes('Field trip form due Fri'), JSON.stringify(news.map((p) => p.body)));
}

console.log('11. announcements during quiet are held, then released');
{
  const dir6 = fs.mkdtempSync(path.join(os.tmpdir(), 'push-test6-'));
  sent.length = 0;
  await runPush([], { dir: dir6, sender: fakeSender, now: at(16, 0), notices: [], schoologyStatePath: stallFile }); // prime
  await runPush([], { dir: dir6, sender: fakeSender, now: at(9, 0), notices: [{ id: 'schoology-groups:9', title: 'Assembly schedule' }], schoologyStatePath: stallFile });
  ok('held during school', !sent.some((p) => p.tag === 'new'), JSON.stringify(sent.map((p) => p.tag)));
  await runPush([], { dir: dir6, sender: fakeSender, now: at(16, 1), notices: [], schoologyStatePath: stallFile });
  const rel = sent.find((p) => p.tag === 'new');
  ok('released after school', Boolean(rel), JSON.stringify(sent.map((p) => p.tag)));
  ok('release carries the announcement', (rel?.body ?? '').includes('Assembly schedule'), rel?.body);
}

console.log('12. overnight arrivals are held, never swallowed');
{
  const dir7 = fs.mkdtempSync(path.join(os.tmpdir(), 'push-test7-'));
  sent.length = 0;
  await runPush([], { dir: dir7, sender: fakeSender, now: at(16, 0), schoologyStatePath: stallFile }); // prime
  const late = [mk('OVERNIGHT', iso(23, 55, 15))];
  await runPush(late, { dir: dir7, sender: fakeSender, now: at(23, 30), schoologyStatePath: stallFile });
  ok('no new-item push at 11:30 PM', !sent.some((p) => p.tag === 'new' || p.tag === 'soon' || p.tag === 'late'), JSON.stringify(sent.map((p) => p.tag)));
  await runPush(late, { dir: dir7, sender: fakeSender, now: at(16, 5, 15), schoologyStatePath: stallFile });
  ok('overnight item released next afternoon', sent.some((p) => p.tag === 'new'), JSON.stringify(sent.map((p) => p.tag)));
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
