import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { jevPipeId, jevSocketPath } from '../src/jevsocket.js';
import { readMailConfig, readMailModels } from '../src/inbox.js';

describe('Windows Jev pipe name', () => {
  it('carries a private random id that is created once and then reused', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jevpipe-'));
    const a = jevPipeId(dir);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(jevPipeId(dir)).toBe(a);
    expect(fs.readFileSync(path.join(dir, 'jev-pipe-id'), 'utf8')).toBe(a);
  });

  it('is not guessable from the user name alone', () => {
    const saved = process.env.MINIAPP_STATE_DIR;
    const savedSock = process.env.JEV_SOCK;
    delete process.env.JEV_SOCK;
    process.env.MINIAPP_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jevpipe-'));
    try {
      expect(jevSocketPath('/unused', 'win32')).toMatch(/^\\\\\.\\pipe\\aside-jev-[\w.-]+-[0-9a-f]{32}$/);
    } finally {
      if (saved === undefined) delete process.env.MINIAPP_STATE_DIR;
      else process.env.MINIAPP_STATE_DIR = saved;
      if (savedSock !== undefined) process.env.JEV_SOCK = savedSock;
    }
  });
});

describe('mail models without a school account', () => {
  it('still reads the sorter model and Jev gate for personal Gmail', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mailmodels-'));
    fs.mkdirSync(path.join(root, 'next'));
    fs.writeFileSync(
      path.join(root, 'next', 'config.json'),
      JSON.stringify({ mailModel: 'oc/space-bunny-free', mailGate: 'oc/jev-1.13-free', personalMail: { account: 'me@example.com' } }),
    );
    expect(readMailConfig(root)).toBeNull();
    expect(readMailModels(root)).toMatchObject({ model: 'oc/space-bunny-free', gate: 'oc/jev-1.13-free' });
  });

  it('never lets a Claude model sort or gate mail', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mailmodels-'));
    fs.mkdirSync(path.join(root, 'next'));
    fs.writeFileSync(path.join(root, 'next', 'config.json'), JSON.stringify({ mailModel: 'anthropic/claude-opus-5-5', mailGate: 'anthropic/claude-haiku-5-5' }));
    const m = readMailModels(root);
    expect(m?.model).toBe('oc/space-bunny-free');
    expect(m?.gate).toBeNull();
  });
});
