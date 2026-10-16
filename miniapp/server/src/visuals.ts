/**
 * Inline `visual` blocks from Aside replies.
 *
 * Aside renders a fenced ```visual block as a self-contained HTML page in a
 * sandboxed frame. The phone showed the same block as a wall of code. It
 * cannot render the page in place: the app's own CSP (`script-src 'self'`)
 * is inherited by `srcdoc` and `blob:` frames, so every chart script would
 * be blocked. Instead the client posts the composed page here and frames
 * the URL this module serves, under a CSP of its own.
 *
 * The posture is the artifact route's, loosened only where a visual needs
 * it: `sandbox allow-scripts` with no `allow-same-origin`, so the page runs
 * in an opaque origin and can never read this app's cookies, storage or
 * API; inline and `https:` scripts and styles, because the pages are
 * single-file and may pull Chart.js or D3 from a CDN.
 *
 * Ids are an HMAC of the bytes under the server's secret. That keeps the
 * same page deduplicated across re-renders while making an id impossible
 * to derive without either the secret or a successful authenticated post,
 * which is why the GET can stay cookie-free (a sandboxed frame is not a
 * reliable place to depend on the session cookie).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const VISUAL_MAX_BYTES = 400 * 1024;
const ID_RE = /^[a-f0-9]{48}$/;

export const VISUAL_CSP = [
  'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox',
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' https:",
  "style-src 'unsafe-inline' https:",
  'img-src data: blob: https:',
  'font-src data: https:',
  'connect-src https:',
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join('; ');

export class VisualStore {
  private readonly dir: string;
  private readonly key: string;
  private readonly keep: number;

  constructor(dir: string, key: string, keep = 400) {
    this.dir = dir;
    this.key = key;
    this.keep = keep;
  }

  idFor(html: string): string {
    return crypto.createHmac('sha256', this.key).update(html).digest('hex').slice(0, 48);
  }

  /** Stores the page and returns its id. Throws on an empty or oversized page. */
  put(html: string): string {
    const bytes = Buffer.byteLength(html, 'utf8');
    if (!html.trim() || bytes > VISUAL_MAX_BYTES) throw new RangeError('visual_size');
    const id = this.idFor(html);
    const file = path.join(this.dir, `${id}.html`);
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (fs.existsSync(file)) {
      // Touch so pruning keeps what is still being viewed.
      const now = new Date();
      fs.utimesSync(file, now, now);
      return id;
    }
    fs.writeFileSync(file, html, { mode: 0o600 });
    this.prune();
    return id;
  }

  get(id: string): string | null {
    if (!ID_RE.test(id)) return null;
    try {
      return fs.readFileSync(path.join(this.dir, `${id}.html`), 'utf8');
    } catch {
      return null;
    }
  }

  private prune(): void {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir).filter((n) => n.endsWith('.html'));
    } catch {
      return;
    }
    if (names.length <= this.keep) return;
    const aged = names
      .map((n) => {
        try {
          return { n, t: fs.statSync(path.join(this.dir, n)).mtimeMs };
        } catch {
          return { n, t: 0 };
        }
      })
      .sort((a, b) => a.t - b.t);
    for (const { n } of aged.slice(0, names.length - this.keep)) {
      try {
        fs.unlinkSync(path.join(this.dir, n));
      } catch {
        /* already gone */
      }
    }
  }
}
