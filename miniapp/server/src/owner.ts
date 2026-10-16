/**
 * Who this install belongs to. Every personal detail the prompts and the
 * mail sorter use (name, time zone, school) comes from the owner's own
 * local config, never from the repository:
 *
 *   <aside root>/next/config.json
 *   {
 *     "owner": {
 *       "name": "Alex",
 *       "timeZone": "America/New_York",
 *       "school": {
 *         "name": "Example High School",
 *         "place": "Springfield",
 *         "gradYear": 2028,
 *         "staffDomains": ["district.example.edu"],
 *         "studentDomain": "students.district.example.edu",
 *         "paymentHost": "district.schoolpay.example"
 *       },
 *       "familyNames": ["Surname"]
 *     }
 *   }
 *
 * Everything is optional. With no config the prompts say "the user", times
 * use this computer's time zone, and no school is assumed.
 */
import fs from 'node:fs';

export interface OwnerSchool {
  name: string;
  place: string;
  gradYear: number | null;
  /** Staff/district mail domains (and their subdomains). */
  staffDomains: string[];
  /** Student account domain; mail from it is a classmate, not the school. */
  studentDomain: string;
  /** The district's payment site, if any. */
  paymentHost: string;
}

export interface OwnerProfile {
  /** First name the assistant uses for the owner. Empty = "the user". */
  name: string;
  /** IANA zone, e.g. "America/New_York". */
  timeZone: string;
  school: OwnerSchool | null;
  /** Surnames whose mail is always private (personal Gmail). */
  familyNames: string[];
}

function systemZone(): string {
  const env = process.env.ASIDE_OWNER_TZ;
  if (env && validZone(env)) return env;
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function validZone(z: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: z });
    return true;
  } catch {
    return false;
  }
}

const str = (v: unknown, max = 80) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f⟦⟧`]+/g, ' ').trim().slice(0, max) : '');
const domain = (v: unknown) => {
  const s = str(v, 120).toLowerCase().replace(/^@/, '').replace(/\.$/, '');
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) ? s : '';
};
const domains = (v: unknown) => (Array.isArray(v) ? v.map(domain).filter(Boolean).slice(0, 20) : []);

export function parseOwner(raw: unknown): OwnerProfile {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const s = o.school && typeof o.school === 'object' ? (o.school as Record<string, unknown>) : null;
  const tz = str(o.timeZone, 64);
  const year = Number(s?.gradYear);
  const school: OwnerSchool | null = s
    ? {
        name: str(s.name),
        place: str(s.place),
        gradYear: Number.isInteger(year) && year > 2000 && year < 2100 ? year : null,
        staffDomains: domains(s.staffDomains),
        studentDomain: domain(s.studentDomain),
        paymentHost: domain(s.paymentHost),
      }
    : null;
  return {
    name: str(o.name, 40),
    timeZone: tz && validZone(tz) ? tz : systemZone(),
    school,
    familyNames: Array.isArray(o.familyNames) ? o.familyNames.map((n) => str(n, 40)).filter(Boolean).slice(0, 20) : [],
  };
}

/**
 * Parse a hand-edited JSON config. Windows PowerShell 5 and some editors
 * save UTF-8 with a byte-order mark, which JSON.parse rejects; drop it so
 * the file is not silently ignored.
 */
export function readConfigJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

let configPath: string | null = null;
let override: OwnerProfile | null = null;
let cached: { at: number; value: OwnerProfile } | null = null;

/** Point the profile at <aside root>/next/config.json (done once at startup). */
export function initOwner(file: string): void {
  configPath = file;
  cached = null;
}

/** Tests pin a profile; pass null to go back to the file. */
export function setOwnerForTests(p: Partial<OwnerProfile> | null): void {
  override = p ? { ...parseOwner({}), ...p } : null;
  cached = null;
}

/** The current profile. Read fresh at most every 30 s, so edits need no restart. */
export function owner(): OwnerProfile {
  if (override) return override;
  const now = Date.now();
  if (cached && now - cached.at < 30_000) return cached.value;
  let raw: unknown = {};
  if (configPath) {
    try {
      raw = (readConfigJson(configPath) as { owner?: unknown }).owner ?? {};
    } catch {
      raw = {};
    }
  }
  const value = parseOwner(raw);
  cached = { at: now, value };
  return value;
}

/** "Alex", or "the user" when no name is configured. */
export function ownerName(): string {
  return owner().name || 'the user';
}

/** "Alex's", or "the user's". */
export function ownerPossessive(): string {
  const n = owner().name;
  return n ? `${n}'s` : "the user's";
}

export function ownerZone(): string {
  return owner().timeZone;
}
