#!/usr/bin/env node
/** `npm run frontdoor`: the bash installer on macOS, the Node one on Windows. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const r =
  process.platform === 'win32'
    ? spawnSync(process.execPath, [path.join(here, 'install.mjs'), ...args], { stdio: 'inherit' })
    : process.platform === 'darwin'
      ? spawnSync('bash', [path.join(here, 'install.sh'), ...args], { stdio: 'inherit' })
      : (console.error('The front door installer supports macOS and Windows.'), { status: 1 });
process.exit(r.status ?? 1);
