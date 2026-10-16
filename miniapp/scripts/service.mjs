#!/usr/bin/env node
/**
 * Keep the server running in the background, on either platform.
 *
 *   npm run service            macOS: launchd job com.aside.mobile
 *                              Windows: login runner (winservice.mjs)
 *   npm run service -- off     remove it
 *
 * Windows also accepts: status | restart | stop.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const script =
  process.platform === 'win32' ? 'winservice.mjs' : process.platform === 'darwin' ? 'install-launchd.mjs' : null;
if (!script) {
  console.error('Background service setup supports macOS and Windows. On Linux, run `npm start` under systemd or similar.');
  process.exit(1);
}
const r = spawnSync(process.execPath, [path.join(here, script), ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status ?? 1);
