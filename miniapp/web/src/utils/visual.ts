/**
 * Composing an Aside `visual` block for the phone.
 *
 * A visual is a single HTML page written against Aside's theme variables
 * (`--foreground`, `--chart-1`, ...). Aside injects those plus a tiny base
 * stylesheet before rendering; this does the same with the phone's own
 * palette, and adds the one script the frame needs: report the content
 * height to the parent and accept live theme updates.
 *
 * Kept pure (no DOM reads) so it is testable; the caller supplies the
 * resolved variable values.
 */

/** The variables the visualize skill tells the agent it may use. */
export const VISUAL_VARS = [
  '--foreground',
  '--muted-foreground',
  '--muted',
  '--background',
  '--surface-primary',
  '--surface-secondary',
  '--border',
  '--input',
  '--ring',
  '--primary',
  '--primary-foreground',
  '--secondary',
  '--secondary-foreground',
  '--accent',
  '--accent-foreground',
  '--popover',
  '--popover-foreground',
  '--brand',
  '--destructive',
  '--success',
  '--chart-1',
  '--chart-2',
  '--chart-3',
  '--chart-4',
  '--chart-5',
  '--chart-6',
  '--radius',
  '--font-sans',
  '--font-mono',
] as const;

export type VisualVars = Record<string, string>;
export type Scheme = 'light' | 'dark';

/**
 * Chart and status colours the app does not define itself.
 *
 * The app is deliberately monochrome plus one clay accent, so its own
 * `--success` is ink and its `--destructive` is the same clay as the
 * accent. A chart needs those to read as different things, so visuals get
 * their own: clay for the focus series, then quiet hue-92-friendly
 * companions, a muted green for good and a brick red for bad.
 */
export const VISUAL_PALETTE: Record<Scheme, VisualVars> = {
  light: {
    '--chart-1': '#e87d4f',
    '--chart-2': '#43698f',
    '--chart-3': '#4d7c5d',
    '--chart-4': '#b8892f',
    '--chart-5': '#8a6bb0',
    '--chart-6': '#a8512a',
    '--success': '#3f7a52',
    '--destructive': '#b4483c',
    '--brand': '#e87d4f',
  },
  dark: {
    '--chart-1': '#e87d4f',
    '--chart-2': '#8db2d8',
    '--chart-3': '#8fc0a0',
    '--chart-4': '#e0b860',
    '--chart-5': '#b9a0d8',
    '--chart-6': '#e09a78',
    '--success': '#8fc0a0',
    '--destructive': '#f08a7e',
    '--brand': '#e87d4f',
  },
};

const SYSTEM_SANS =
  "-apple-system-body, ui-sans-serif, -apple-system, system-ui, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const SYSTEM_MONO = "ui-monospace, 'SF Mono', Menlo, Consolas, monospace";

/** Fills gaps and applies the visual palette over the app's own values. */
export function visualVars(resolved: VisualVars, scheme: Scheme): VisualVars {
  const out: VisualVars = {};
  for (const name of VISUAL_VARS) {
    const value = (resolved[name] ?? '').trim();
    if (value && !/var\(/.test(value)) out[name] = value;
  }
  Object.assign(out, VISUAL_PALETTE[scheme]);
  // The app's Geist is a same-origin webfont the sandboxed frame cannot
  // load, so lead with the system stack the transcript prose already uses.
  out['--font-sans'] = SYSTEM_SANS;
  out['--font-mono'] = SYSTEM_MONO;
  if (!out['--radius']) out['--radius'] = '10px';
  if (!out['--foreground']) out['--foreground'] = scheme === 'dark' ? '#f2efe8' : '#262622';
  if (!out['--muted-foreground']) {
    out['--muted-foreground'] = 'color-mix(in oklab, var(--foreground) 58%, transparent)';
  }
  if (!out['--border']) out['--border'] = 'color-mix(in oklab, var(--foreground) 12%, transparent)';
  if (!out['--surface-primary']) {
    out['--surface-primary'] = 'color-mix(in oklab, var(--foreground) 6%, transparent)';
  }
  if (!out['--surface-secondary']) {
    out['--surface-secondary'] = 'color-mix(in oklab, var(--foreground) 4%, transparent)';
  }
  if (!out['--muted']) out['--muted'] = 'color-mix(in oklab, var(--foreground) 10%, transparent)';
  return out;
}

const safeValue = (v: string) => v.replace(/[<>{};]/g, '');

function rootRule(vars: VisualVars): string {
  return Object.entries(vars)
    .filter(([k]) => /^--[a-z0-9-]+$/.test(k))
    .map(([k, v]) => `${k}:${safeValue(v)}`)
    .join(';');
}

/**
 * The script every frame gets. Height goes up as `aside-visual:h`; theme
 * updates come down as `aside-visual:theme`. It identifies nothing about
 * the page, so composing the same block twice yields the same bytes and
 * the server dedupes it.
 */
const FRAME_SCRIPT = `(function(){var d=document.documentElement,last=-1;function h(){var b=document.body,v=Math.ceil(Math.max(d.getBoundingClientRect().height,b?b.getBoundingClientRect().bottom:0));if(v!==last){last=v;parent.postMessage({type:'aside-visual:h',h:v},'*')}}try{var ro=new ResizeObserver(h);ro.observe(d);document.addEventListener('DOMContentLoaded',function(){ro.observe(document.body);h()})}catch(e){setInterval(h,500)}addEventListener('load',function(){h();setTimeout(h,300);setTimeout(h,1200)});addEventListener('message',function(e){var m=e.data;if(!m||m.type!=='aside-visual:theme')return;for(var k in m.vars)d.style.setProperty(k,m.vars[k]);d.style.colorScheme=m.scheme;dispatchEvent(new Event('resize'))})})();`;

export function composeVisual(html: string, vars: VisualVars, scheme: Scheme): string {
  const head =
    `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<base target="_blank">` +
    `<style>:root{${rootRule(vars)};color-scheme:${scheme}}` +
    `html{color:var(--foreground);font:14px/1.5 var(--font-sans);-webkit-text-size-adjust:100%;scrollbar-width:none;background:transparent}` +
    `html::-webkit-scrollbar{display:none}body{margin:0;background:transparent}</style>` +
    `<script>${FRAME_SCRIPT}</script>`;
  const source = html.trim();
  if (/<head[^>]*>/i.test(source)) return source.replace(/<head[^>]*>/i, (m) => m + head);
  if (/<html[^>]*>/i.test(source)) {
    return source.replace(/<html[^>]*>/i, (m) => `${m}<head>${head}</head>`);
  }
  return `<!doctype html><html><head>${head}</head><body>${source}</body></html>`;
}

/** The page's own `<title>`, for the frame's accessible name. */
export function visualTitle(html: string): string {
  const m = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  return (m?.[1] ?? '').trim() || 'Visual';
}

/**
 * Absolute local paths a visual references in a quoted attribute or CSS
 * `url()`. Aside inlines these on the desktop; the sandboxed frame cannot
 * reach the authenticated file route, so the caller inlines them as data.
 */
export function localRefs(html: string): string[] {
  const found = new Set<string>();
  const re = /(?:src|href)\s*=\s*["'](\/(?:Users|private|tmp|var)\/[^"']+)["']|url\(\s*["']?(\/(?:Users|private|tmp|var)\/[^"')]+)["']?\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) found.add(m[1] ?? m[2]);
  return [...found];
}
