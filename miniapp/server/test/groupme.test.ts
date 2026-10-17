import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GroupMeSweeper,
  DmSweeper,
  GM_QUESTIONS,
  feedItem,
  dmFeedItem,
  fetchMessages,
  jevGroupMe,
  lastDmOf,
  listChats,
  listGroups,
  meId,
  messagesForModel,
  noiseReason,
  parseTasks,
  privateKindOf,
  readGroupMeConfig,
  readToken,
  type DmChat,
  type DmMessage,
  type GroupMeGate,
  type GroupMeGroup,
} from '../src/groupme.js';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gm-test-'));
}

function msg(id: string, text: string, at: number = Math.floor(now.getTime() / 1000) - 7200, name = 'Sam', system = false, attachments: string[] = []) {
  return { id, name, text, created_at: at, system, attachments, event: system ? { event_id: 'x' } : undefined };
}

function gmFetch(groups: unknown, pages: Record<string, unknown[][]>): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(typeof input === 'string' ? input : (input as URL).href);
    if (url.includes('/groups?') || url.endsWith('/groups')) {
      return new Response(JSON.stringify(groups), { status: 200 });
    }
    const m = /\/groups\/(\d+)\/messages/.exec(url);
    if (m) {
      const list = pages[m[1]]?.[0] ?? [];
      const before = /before_id=([^&]+)/.exec(url)?.[1];
      const rows = list as Array<Record<string, unknown>>;
      const page = before ? rows.slice(rows.findIndex((x) => String(x.id) === decodeURIComponent(before)) + 1) : list;
      return new Response(JSON.stringify({ response: { count: 100, messages: page } }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
}

const now = new Date('2026-10-16T20:00:00.000Z');
const nowFn = () => now;

describe('config', () => {
  it('returns null with no config file', () => {
    const d = tmp();
    expect(readGroupMeConfig(d, d)).toBeNull();
  });

  it('returns null with no token', () => {
    const d = tmp();
    fs.mkdirSync(path.join(d, 'next'), { recursive: true }); fs.writeFileSync(path.join(d, 'next', 'config.json'), JSON.stringify({ groupme: {} }));
    expect(readGroupMeConfig(d, d)).toBeNull();
  });

  it('reads the token and defaults', () => {
    const d = tmp();
    fs.mkdirSync(path.join(d, 'next'), { recursive: true }); fs.writeFileSync(path.join(d, 'next', 'config.json'), JSON.stringify({ groupme: { excludeGroups: ['IFC'] } }));
    fs.writeFileSync(path.join(d, 'groupme.json'), JSON.stringify({ token: 'a'.repeat(32) }), { mode: 0o600 });
    const c = readGroupMeConfig(d, d);
    expect(c).not.toBeNull();
    expect(c!.enabled).toBe(true);
    expect(c!.excludeGroups).toEqual(['IFC']);
    expect(c!.maxMessages).toBe(60);
    expect(c!.maxAgeDays).toBe(7);
    expect(readToken(d)).toBe('a'.repeat(32));
  });

  it('clamps wild numbers and honours disabled', () => {
    const d = tmp();
    fs.mkdirSync(path.join(d, 'next'), { recursive: true }); fs.writeFileSync(path.join(d, 'next', 'config.json'), JSON.stringify({ groupme: { maxMessages: 99999, maxAgeDays: 0 } }));
    fs.writeFileSync(path.join(d, 'groupme.json'), JSON.stringify({ token: 'b'.repeat(32) }));
    const c = readGroupMeConfig(d, d)!;
    expect(c.maxMessages).toBe(200);
    expect(c.maxAgeDays).toBe(1);
    fs.mkdirSync(path.join(d, 'next'), { recursive: true }); fs.writeFileSync(path.join(d, 'next', 'config.json'), JSON.stringify({ groupme: { enabled: false } }));
    expect(readGroupMeConfig(d, d)).toBeNull();
  });

  it('rejects a malformed token', () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'groupme.json'), JSON.stringify({ token: 'not-a-token' }));
    expect(readToken(d)).toBeNull();
  });
});

describe('fetch', () => {
  it('lists groups with member counts', async () => {
    const groups = await listGroups(
      gmFetch({ response: [{ id: '123', name: 'Quiz Bowl', members: { count: 41 } }] }, {}),
      'a'.repeat(32),
    );
    expect(groups).toEqual([{ id: '123', name: 'Quiz Bowl', members: 41 }]);
  });

  it('stops at the cursor so nothing re-reads', async () => {
    const group: GroupMeGroup = { id: '55', name: 'Club', members: 5 };
    const base = Math.floor(now.getTime() / 1000) - 7200;
    const pages = {
      55: [[msg('m3', 'third', base), msg('m2', 'second', base - 60), msg('m1', 'first', base - 120)]],
    };
    const first = await fetchMessages(gmFetch({ response: [] }, pages), 'a'.repeat(32), group, null, 60, now);
    expect(first.messages.map((m) => m.id)).toEqual(['m3', 'm2', 'm1']);
    const again = await fetchMessages(
      gmFetch({ response: [] }, pages),
      'a'.repeat(32),
      group,
      { lastId: 'm3', lastAt: base },
      60,
      now,
    );
    expect(again.messages).toEqual([]);
  });

  it('drops future and system events from noise filtering', () => {
    const at = Math.floor(now.getTime() / 1000) + 3600;
    expect(noiseReason({ id: 'f', groupId: '1', groupName: 'g', name: 'x', text: 'hi there', at, system: false, attachments: [] }, now, 365)).toBe(null);
    expect(noiseReason(
      { id: 's', groupId: '1', groupName: 'g', name: '', text: 'added Bob', at: 1_790_000_000, system: true, attachments: [] },
      now,
      7,
    )).toBe('system');
  });
});

describe('classification', () => {
  it('parses a clean task array and clamps', () => {
    const t = parseTasks('[{"m":1,"kind":"form","title":"Sign the NEHS sheet","ask":"Sign NEHS permission","why":"Counts toward service hours","deadline":"2026-10-20","minutes":5,"impact":9}]');
    expect(t).toHaveLength(1);
    expect(t[0].impact).toBe(5);
    expect(t[0].minutes).toBe(5);
    expect(t[0].deadline).toBe('2026-10-20');
  });

  it('rejects junk, bad kinds, and garbage', () => {
    expect(parseTasks('not json at all')).toEqual([]);
    expect(parseTasks('[{"m":0,"kind":"form","title":"x"}]')).toEqual([]);
    expect(parseTasks('[{"m":1,"kind":"nope","title":"x"}]')).toEqual([]);
    expect(parseTasks('[{"m":1,"kind":"event","title":""}]')).toEqual([]);
  });

  it('keeps no numbers or links in the model view', () => {
    const out = messagesForModel([{ name: 'Sam', text: 'Call me at 629-555-0134 or see https://example.com/secret for the code 913377' }]);
    expect(out).toContain('M1 [Sam]');
    expect(out).not.toContain('629');
    expect(out).not.toContain('https');
  });

  it('asks four typed questions', () => {
    expect(Object.keys(GM_QUESTIONS)).toEqual(['show', 'sensitive', 'ai_bait', 'phish']);
  });
});

describe('feed items', () => {
  const g: GroupMeGroup = { id: '999', name: 'STARS Club', members: 3 };
  const m = { id: '77', groupId: '999', groupName: 'STARS Club', name: 'Dana', text: 't', at: 1_790_000_000, system: false, attachments: [] as string[] };

  it('builds an adaptFeed-shaped item', () => {
    const it = feedItem(g, m, { m: 1, kind: 'reply', title: 'Reply to Dana about Thursday', ask: 'Answer Dana', why: 'She needs a yes', deadline: null, minutes: 10, impact: 2 }, '');
    expect(it.id).toBe('groupme:77');
    expect(it.source).toBe('groupme');
    expect(it.taint).toBe('email');
    expect(it.kind).toBe('errand');
    expect(it.url).toBe('https://groupme.com/group/999');
    expect(it.atISO).toBe(new Date(1_790_000_000_000).toISOString());
  });
});

describe('sweep', () => {
  const baseConfig = { enabled: true, excludeGroups: [] as string[], maxMessages: 60, maxAgeDays: 7 };

  function sweeper(d: string, decide: (s: string) => Promise<GroupMeGate | null>, complete = async () => '[{"m":1,"kind":"form","title":"Sign the NEHS sheet","ask":"Sign it","why":"Service hours","deadline":null,"minutes":10,"impact":3}]') {
    return new GroupMeSweeper({
      feedPath: path.join(d, 'feeds', 'groupme.json'),
      cachePath: path.join(d, 'groupme-cache.json'),
      complete,
      decide,
      config: baseConfig,
      token: 'a'.repeat(32),
      fetchImpl: gmFetch(
        { response: [{ id: '999', name: 'STARS Club', members: { count: 3 } }, { id: '111', name: 'IFC', members: { count: 2 } }] },
        { 999: [[msg('m1', 'Can you sign the NEHS permission sheet by Friday?')]], 111: [[msg('x1', 'football now?')]] },
      ),
      now: nowFn,
    });
  }

  it('gates with Jev then classifies, writes the feed, and advances the cursor', async () => {
    const d = tmp();
    const seen: string[] = [];
    const sw = sweeper(d, async (s) => {
      seen.push(s);
      // Realistic: the club's ask passes, the football chatter does not.
      return s.includes('NEHS')
        ? { show: 0.9, aiBait: 0.02, phish: 0.01, sensitive: 0.02 }
        : { show: 0.05, aiBait: 0.01, phish: 0.01, sensitive: 0.01 };
    });
    const r = await sw.sweep();
    expect(r.ok).toBe(true);
    expect(r.groups).toBe(2);
    expect(r.messages).toBe(2);
    expect(r.items).toBe(1);
    expect(r.waiting).toBe(0);
    expect(seen).toHaveLength(2);
    const feed = JSON.parse(fs.readFileSync(path.join(d, 'feeds', 'groupme.json'), 'utf8'));
    expect(feed.label).toBe('GroupMe');
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0].title).toBe('Sign the NEHS sheet');
    // Second sweep: cursor at the newest message means nothing new is read.
    const r2 = await sw.sweep();
    expect(r2.messages).toBe(0);
    expect(r2.items).toBe(0);
    const feed2 = JSON.parse(fs.readFileSync(path.join(d, 'feeds', 'groupme.json'), 'utf8'));
    expect(feed2.items).toHaveLength(1);
  });

  it('waits instead of classifying when Jev is down', async () => {
    const d = tmp();
    const sw = sweeper(d, async () => null);
    const r = await sw.sweep();
    expect(r.waiting).toBe(2);
    expect(r.items).toBe(0);
    expect(fs.existsSync(path.join(d, 'feeds', 'groupme.json'))).toBe(false);
  });

  it('drops a private or phishing group with no words kept', async () => {
    for (const gate of [
      { show: 0.9, aiBait: 0.01, phish: 0.01, sensitive: 0.97 },
      { show: 0.9, aiBait: 0.01, phish: 0.95, sensitive: 0.02 },
      { show: 0.9, aiBait: 0.9, phish: 0.01, sensitive: 0.02 },
    ]) {
      const d = tmp();
      const sw = sweeper(d, async () => gate);
      const r = await sw.sweep();
      expect(r.items).toBe(0);
      expect(fs.existsSync(path.join(d, 'feeds', 'groupme.json'))).toBe(false);
    }
  });

  it('skips a group with no ask, even though Jev is up', async () => {
    const d = tmp();
    const sw = sweeper(d, async () => ({ show: 0.1, aiBait: 0.0, phish: 0.0, sensitive: 0.0 }));
    const r = await sw.sweep();
    expect(r.messages).toBe(2);
    expect(r.items).toBe(0);
  });

  it('survives a classifier that returns junk', async () => {
    const d = tmp();
    const sw = sweeper(d, async () => ({ show: 0.9, aiBait: 0.0, phish: 0.0, sensitive: 0.0 }), async () => 'lol no');
    const r = await sw.sweep();
    expect(r.ok).toBe(true);
    expect(r.items).toBe(0);
  });
});

describe('direct messages', () => {
  const chat: DmChat = { id: '99', otherId: '99', otherName: 'Priya' };
  const dm = (id: string, text: string, mine = false, at = Math.floor(now.getTime() / 1000) - 1800) => ({
    id,
    text,
    created_at: at,
    name: mine ? 'Me' : 'Priya',
    sender_id: mine ? '1' : '99',
    recipient_id: mine ? '99' : '1',
  });

  function dmFetch(me: Record<string, unknown> | null, chats: unknown): typeof fetch {
    return (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(typeof input === 'string' ? input : (input as URL).href);
      if (url.includes('/users/me')) return new Response(JSON.stringify(me ? { response: me } : {}), { status: me ? 200 : 401 });
      if (url.includes('/chats?')) return new Response(JSON.stringify(chats), { status: 200 });
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
  }

  const chatsOf = (lastMessages: Array<Record<string, unknown> | null>): unknown => ({
    response: [
      { other_user: { id: '99', name: 'Priya' }, ...(lastMessages[0] ? { last_message: lastMessages[0] } : {}) },
      { other_user: { id: '77', name: 'Dev' }, ...(lastMessages[1] ? { last_message: lastMessages[1] } : {}) },
    ],
  });

  it('reads his own user id', async () => {
    expect(await meId(dmFetch({ id: '1' }, { response: [] }), 'a'.repeat(32))).toBe('1');
    expect(await meId(dmFetch(null, { response: [] }), 'a'.repeat(32))).toBeNull();
  });

  it('keys every chat by the other person and keeps the last message', async () => {
    const chats = await listChats(dmFetch({ id: '1' }, chatsOf([dm('c3', 'see you at practice'), null])), 'a'.repeat(32));
    expect(chats).toHaveLength(2);
    expect(chats[0].id).toBe('99');
    expect(chats[0].otherName).toBe('Priya');
    expect(chats[0].lastMessage?.id).toBe('c3');
    expect(chats[1].lastMessage).toBeUndefined();
  });

  it('marks his own reply as his, so nothing waits on him', () => {
    const own = lastDmOf({ id: '99', otherId: '99', otherName: 'Priya', lastMessage: dm('m1', 'yep i will be there', true) as never }, '1');
    expect(own?.mine).toBe(true);
    const theirs = lastDmOf({ id: '99', otherId: '99', otherName: 'Priya', lastMessage: dm('c9', 'can you come tonight?') as never }, '1');
    expect(theirs?.mine).toBe(false);
    expect(theirs?.text).toBe('can you come tonight?');
    expect(lastDmOf({ id: '99', otherId: '99', otherName: 'Priya' }, '1')).toBeNull();
  });

  it('flags codes, money, addresses and health in plain code', () => {
    expect(privateKindOf('your verification code is 918273')).toBe('codes');
    expect(privateKindOf('send it to my venmo')).toBe('money');
    expect(privateKindOf('my address is 412 Elm Street')).toBe('address');
    expect(privateKindOf('started a new prescription')).toBe('health');
    expect(privateKindOf('quiz bowl is at 3pm in room 214')).toBeNull();
  });

  it('builds a Respond-to item with the planner kind', () => {
    const m: DmMessage = { id: 'c9', chatId: '99', otherId: '99', otherName: 'Priya', name: 'Priya', text: 't', at: 1_790_000_000, mine: false };
    const plain = dmFeedItem(m, null) as Record<string, string>;
    expect(plain.id).toBe('groupme:dm:c9');
    expect(plain.title).toBe('Respond to Priya on GroupMe');
    expect(plain.source).toBe('groupme');
    expect(plain.url).toBe('https://groupme.com/chats/99');
    const asked = dmFeedItem(m, { m: 1, kind: 'meeting', title: 'Attend the NEHS meeting', ask: 'Come', why: 'Service hours', deadline: null, minutes: 30, impact: 3 }, '') as Record<string, string>;
    expect(asked.title).toBe('Attend the NEHS meeting');
    expect(asked.kind).toBe('schedule');
  });

  it('seeds history in silence, then pushes and files every genuinely new DM', async () => {
    const d = tmp();
    const pushed: string[] = [];
    const sw = (chats: unknown, complete = async () => '[]') =>
      new DmSweeper({
        feedPath: path.join(d, 'feeds', 'groupme.json'),
        cachePath: path.join(d, 'dm-cache.json'),
        complete,
        decide: async () => ({ show: 0.9, aiBait: 0.01, phish: 0.01, sensitive: 0.01 }),
        config: { enabled: true, excludeGroups: [] as string[], maxMessages: 60, maxAgeDays: 7 },
        token: 'a'.repeat(32),
        onNewDm: (m) => pushed.push(`respond:${m.otherName}`),
        fetchImpl: dmFetch({ id: '1' }, chats),
        now: nowFn,
      });
    // First sight: the current newest messages seed the cursors in silence.
    const first = await sw(chatsOf([dm('c3', 'see you at practice'), dm('d1', 'team dinner moved')])).sweep();
    expect(first.ok).toBe(true);
    expect(first.newDms).toBe(0);
    expect(pushed).toEqual([]);
    // A new DM arrives from Priya.
    const second = await sw(
      chatsOf([dm('c4', 'can you send me the form by friday?'), dm('d1', 'team dinner moved')]),
      async () => '[{"m":1,"kind":"form","title":"Send Priya the form","ask":"Send the form","why":"She needs it for Friday","deadline":null,"minutes":10,"impact":2}]',
    ).sweep();
    expect(second.newDms).toBe(1);
    expect(pushed).toEqual(['respond:Priya']);
    expect(second.items).toBe(1);
    const feed = JSON.parse(fs.readFileSync(path.join(d, 'feeds', 'groupme.json'), 'utf8'));
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0].id).toBe('groupme:dm:c4');
    expect(feed.items[0].title).toBe('Send Priya the form');
    // His own reply advances the cursor and pushes nothing.
    const third = await sw(chatsOf([dm('m1', 'just sent it', true), dm('d1', 'team dinner moved')])).sweep();
    expect(third.newDms).toBe(0);
    expect(pushed).toEqual(['respond:Priya']);
  });

  it('holds a private DM off every model but still says who wrote', async () => {
    const d = tmp();
    const pushed: string[] = [];
    const sw = (chats: unknown) =>
      new DmSweeper({
        feedPath: path.join(d, 'feeds', 'groupme.json'),
        cachePath: path.join(d, 'dm-cache.json'),
        complete: async () => { throw new Error('the classifier must never see a private DM'); },
        decide: async () => ({ show: 0.9, aiBait: 0.01, phish: 0.01, sensitive: 0.01 }),
        config: { enabled: true, excludeGroups: [] as string[], maxMessages: 60, maxAgeDays: 7 },
        token: 'a'.repeat(32),
        onNewDm: (m) => pushed.push(`respond:${m.otherName}`),
        fetchImpl: dmFetch({ id: '1' }, chats),
        now: nowFn,
      });
    await sw(chatsOf([dm('c3', 'see you at practice'), null])).sweep();
    const r = await sw(chatsOf([dm('c4', 'your verification code is 918273'), null])).sweep();
    expect(r.newDms).toBe(1);
    expect(r.private).toBe(1);
    expect(pushed).toEqual(['respond:Priya']);
    expect(fs.existsSync(path.join(d, 'feeds', 'groupme.json'))).toBe(false);
  });
});

describe('jev door', () => {
  it('refuses a non-local endpoint outright', async () => {
    const decide = jevGroupMe({ baseUrl: 'https://evil.example.com', apiKey: 'k', model: 'm' });
    expect(await decide('anything')).toBeNull();
  });

  it('posts typed questions and reads the four noul answers', async () => {
    let body = '';
    const decide = jevGroupMe(
      { baseUrl: 'http://127.0.0.1:20128', apiKey: 'k', model: 'jev' },
      (async (_u: Parameters<typeof fetch>[0], init?: RequestInit) => {
        body = String(init?.body ?? '');
        return new Response(JSON.stringify({ answers: { show: { noul: 0.8 }, ai_bait: { noul: 0.1 }, phish: { noul: 0.05 }, sensitive: { noul: 0.2 } } }), { status: 200 });
      }) as typeof fetch,
    );
    const g = await decide('#1 [Sam] please bring the form');
    expect(g).toEqual({ show: 0.8, aiBait: 0.1, phish: 0.05, sensitive: 0.2 });
    expect(body).toContain('"questions"');
    expect(body).toContain('bring');
  });

  it('returns null on a broken answer shape', async () => {
    const decide = jevGroupMe(
      { baseUrl: 'http://localhost:1', apiKey: 'k', model: 'jev' },
      (async () => new Response(JSON.stringify({ answers: { show: { noul: 0.8 } } }), { status: 200 })) as typeof fetch,
    );
    expect(await decide('x')).toBeNull();
  });
});







