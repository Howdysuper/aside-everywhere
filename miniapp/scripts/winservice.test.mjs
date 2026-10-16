// node --test scripts/*.test.mjs  (runs on every platform; nothing here touches the registry)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isRunnerProcess, jobBaseEnv, pickEnv, psQuote, runCommand, serverJob } from './winservice.mjs';
import { TUNNEL_URL_RE, netSig, newSecret } from '../frontdoor/supervisor.mjs';

test('login command starts node hidden through PowerShell -Command, never -File or a policy bypass', () => {
  const cmd = runCommand('C:\\Program Files\\nodejs\\node.exe', "C:\\Users\\O'Neil\\aside-phone\\miniapp\\scripts\\win-runner.mjs");
  assert.match(cmd, /^powershell\.exe -NoProfile -NonInteractive -WindowStyle Hidden -Command "/);
  assert.doesNotMatch(cmd, /\s-File\s|Bypass|ExecutionPolicy/i);
  assert.ok(cmd.includes("-FilePath 'C:\\Program Files\\nodejs\\node.exe'"));
  // A quote in the path is doubled for PowerShell, and the path itself is double-quoted for node.
  assert.ok(cmd.includes(`-ArgumentList '\\"C:\\Users\\O''Neil\\aside-phone\\miniapp\\scripts\\win-runner.mjs\\"'`));
});

test('psQuote doubles single quotes', () => {
  assert.equal(psQuote("a'b"), "'a''b'");
});

test('only documented settings reach the background job', () => {
  const env = pickEnv({ MINIAPP_PORT: '9000', NGROK_AUTHTOKEN: 'secret', PATH: 'x', ASIDE_HOME: 'D:\\aside' });
  assert.deepEqual(env, { MINIAPP_PORT: '9000', ASIDE_HOME: 'D:\\aside' });
  assert.throws(() => pickEnv({}, { GITHUB_TOKEN: 'x' }), /not a forwarded setting/);
});

test('re-running the service install keeps the front door pins', () => {
  const previous = { env: { MINIAPP_TUNNEL: 'external', MINIAPP_TUNNEL_HOSTNAME: 'a.example.workers.dev' } };
  const job = serverJob({ MINIAPP_PORT: '8790' }, {}, previous);
  assert.equal(job.env.MINIAPP_TUNNEL, 'external');
  assert.equal(job.env.MINIAPP_TUNNEL_HOSTNAME, 'a.example.workers.dev');
  assert.equal(job.env.MINIAPP_PORT, '8790');
  assert.equal(job.command, process.execPath);
});

test('tunnel URL parsing and secrets', () => {
  const out = 'INF |  https://brave-otter-12.trycloudflare.com  |';
  assert.equal(TUNNEL_URL_RE.exec(out)?.[0], 'https://brave-otter-12.trycloudflare.com');
  assert.equal(TUNNEL_URL_RE.exec('https://evil.example.com/x.trycloudflare.com'), null);
  assert.match(newSecret(), /^[0-9a-f]{64}$/);
  assert.notEqual(newSecret(), newSecret());
});

test('network signature changes when an address changes', () => {
  const a = netSig({ Wi: [{ address: '10.0.0.2', internal: false }], lo: [{ address: '127.0.0.1', internal: true }] });
  const b = netSig({ Wi: [{ address: '10.0.0.3', internal: false }], lo: [{ address: '127.0.0.1', internal: true }] });
  assert.notEqual(a, b);
  assert.doesNotMatch(a, /127\.0\.0\.1/);
});

test('background jobs get Windows basics and documented settings, never shell tokens', () => {
  const env = jobBaseEnv({ Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\a', ASIDE_HOME: 'D:\\aside', GITHUB_TOKEN: 'x', CLOUDFLARE_API_TOKEN: 'y', NGROK_AUTHTOKEN: 'z' });
  assert.deepEqual(Object.keys(env).sort(), ['ASIDE_HOME', 'Path', 'SystemRoot', 'USERPROFILE']);
});

test('the PID check only consults Windows', () => {
  assert.equal(isRunnerProcess(1, 'darwin'), true);
});

test('cloudflared infrastructure hosts are never taken for the tunnel', () => {
  const out = 'ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": dial tcp\nINF https://quiet-river-moon.trycloudflare.com';
  assert.equal(TUNNEL_URL_RE.exec(out)?.[0], 'https://quiet-river-moon.trycloudflare.com');
  assert.equal(TUNNEL_URL_RE.exec('Post "https://api.trycloudflare.com/tunnel"'), null);
});
