import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initOwner, owner, ownerName, ownerZone, setOwnerForTests } from '../src/owner.js';

const pinned = owner();

afterEach(() => setOwnerForTests(pinned));

describe('owner profile file', () => {
  it('reads name, zone and school from next/config.json', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-'));
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ owner: { name: 'Sam', timeZone: 'Europe/London', school: { name: 'Test Academy', gradYear: 2028 } } }));
    initOwner(file);
    setOwnerForTests(null);
    expect(ownerName()).toBe('Sam');
    expect(ownerZone()).toBe('Europe/London');
    expect(owner().school?.name).toBe('Test Academy');
  });

  it('reads a file saved with a byte-order mark (Windows PowerShell 5)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-'));
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, '\uFEFF' + JSON.stringify({ owner: { name: 'Sam' } }));
    initOwner(file);
    setOwnerForTests(null);
    expect(ownerName()).toBe('Sam');
  });

  it('falls back to neutral defaults without a file', () => {
    initOwner(path.join(os.tmpdir(), 'no-such-dir-owner', 'config.json'));
    setOwnerForTests(null);
    expect(ownerName()).toBe('the user');
    expect(owner().school).toBeFalsy();
  });
});
