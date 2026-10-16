/**
 * The phone voice API exists only for the optional native Android client.
 * It must not be registered at all unless voice-config.json opts in.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/app.js';
import { loadConfig, loadOrCreateJwtSecret } from '../src/config.js';
import { PairingCodeStore } from '../src/pair.js';
import { makeTestEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
let app: FastifyInstance | null = null;
let webDist: string;

async function start(): Promise<FastifyInstance> {
  const config = loadConfig();
  const secret = loadOrCreateJwtSecret(config.secretPath);
  ({ app } = await buildServer(config, { jwtSecret: secret, webDist, pairingCodes: new PairingCodeStore() }));
  await app!.ready();
  return app!;
}

beforeEach(() => {
  env = makeTestEnv();
  webDist = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-gate-dist-'));
  fs.writeFileSync(path.join(webDist, 'index.html'), '<!doctype html>ok');
});

afterEach(async () => {
  await app?.close();
  app = null;
  fs.rmSync(webDist, { recursive: true, force: true });
  env.cleanup();
});

describe('phone voice API gate', () => {
  it('is not registered without voice-config.json', async () => {
    const a = await start();
    const res = await a.inject({ method: 'POST', url: '/api/voice/pair/start', payload: {} });
    expect(res.statusCode).toBe(404);
  });

  it('is registered when voice-config.json has "enabled": true', async () => {
    const stateDir = loadConfig().miniapp.stateDir;
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'voice-config.json'), JSON.stringify({ enabled: true }));
    const a = await start();
    const res = await a.inject({ method: 'POST', url: '/api/voice/pair/start', payload: {} });
    expect(res.statusCode).not.toBe(404);
  });
});
