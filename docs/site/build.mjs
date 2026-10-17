/**
 * Turn the markdown guides in ../ into pages on this site, so the demo site
 * carries the full documentation, not just the walkthrough.
 *
 *   node build.mjs
 *
 * Deliberately dependency-free. The docs use a small, well-defined subset of
 * markdown (headings, lists, tables, fenced code, inline code, bold, links,
 * blockquotes and rules), and a site that needs a build toolchain cannot be
 * served from a plain `actions/upload-pages-artifact`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const docs = path.join(here, '..');
const shell = fs.readFileSync(path.join(here, 'page.html'), 'utf8');

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, (_, b) => `<strong>${b}</strong>`)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, h) => `<a href="${h}">${t}</a>`);
}

// NOTE: the dash is last in the character class. In the middle it would form
// a range (':' to '|') and silently stop matching table separators.
const SEP = /^\s*\|[\s:|-]+\|\s*$/;

export function mdToHtml(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  let inCode = false;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim().startsWith('```')) {
      out.push(inCode ? '</code></pre>' : '<pre><code>');
      inCode = !inCode;
      i++;
      continue;
    }
    if (inCode) { out.push(esc(line)); i++; continue; }
    if (/^\s*$/.test(line)) { i++; continue; }
    if (/^---+\s*$/.test(line)) { out.push('<hr />'); i++; continue; }

    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) { out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }

    if (/^\s*\|.*\|\s*$/.test(line) && SEP.test(lines[i + 1] ?? '')) {
      const cells = line.split('|').slice(1, -1).map((c) => c.trim());
      out.push('<table>');
      out.push('<thead><tr>' + cells.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead>');
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        const r = lines[i].split('|').slice(1, -1).map((c) => c.trim());
        out.push('<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>');
        i++;
      }
      out.push('</table>');
      continue;
    }

    if (/^>\s?/.test(line)) { out.push(`<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`); i++; continue; }

    const item = /^(\s*)(?:\d+\.|[-*])\s+(.*)$/.exec(line);
    if (item) {
      const ordered = /^\s*\d+\./.test(line);
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>`);
      while (i < lines.length) {
        const m = /^(\s*)(?:\d+\.|[-*])\s+(.*)$/.exec(lines[i]);
        if (!m || /^\s*\d+\./.test(lines[i]) !== ordered) break;
        out.push(`<li>${inline(m[2])}</li>`);
        i++;
      }
      out.push(`</${tag}>`);
      continue;
    }

    out.push(`<p>${inline(line)}</p>`);
    i++;
  }
  if (inCode) out.push('</code></pre>');
  return out.join('\n');
}

function titleOf(md) {
  const m = /^#\s+(.*)$/m.exec(md);
  return m ? m[1].trim() : 'Aside Everywhere';
}

const site = fs.readdirSync(docs).filter((f) => f.endsWith('.md'));
for (const file of site) {
  const md = fs.readFileSync(path.join(docs, file), 'utf8');
  const title = titleOf(md);
  const body = mdToHtml(md);
  const page = shell
    .replace('{{TITLE}}', esc(title))
    .replace('{{TITLE_RAW}}', title)
    .replace('{{BODY}}', () => body);
  fs.writeFileSync(path.join(here, file.replace(/\.md$/, '.html')), page);
  console.log(`${file} -> ${file.replace(/\.md$/, '.html')}`);
}
