/**
 * Activity: everything Next and its agents did, in order, and one switch
 * that stops all of it.
 *
 * The log is written by the Mac, never by a model, and each entry is
 * sealed to the one before it, so an edited or deleted entry shows up as a
 * broken seal here. The "what each part can do" list says honestly which
 * rules code enforces and which are only instructions to a model.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { haptic } from '../telegram';
import { ChevronDown, ShieldCheck, Spinner, TriangleAlert } from './Icons';
import { toast } from './Toasts';
import type { LedgerEntry, NextSafety } from '../types';
import { ACTOR_WORD, clock, dayKey, dayLabel } from '../utils/nextPlanFormat';

const FILTERS: Array<{ id: string; label: string }> = [
  { id: '', label: 'All' },
  { id: 'agents', label: 'Next' },
  { id: 'you', label: 'You' },
];

const HOW_WORD = { code: 'Built into Next', aside: 'Blocked by Aside', instruction: 'Only an instruction' } as const;

export function ActivityTab({ onPausedChange }: { onPausedChange?: (paused: boolean) => void }) {
  const [safety, setSafety] = useState<NextSafety | null>(null);
  const [entries, setEntries] = useState<LedgerEntry[] | null>(null);
  const [more, setMore] = useState(false);
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const [switching, setSwitching] = useState(false);
  const [partsOpen, setPartsOpen] = useState(false);
  const now = new Date();

  const load = useCallback(async () => {
    try {
      const [s, a] = await Promise.all([api.nextSafety(), api.nextActivity({ actor: filter || undefined, limit: 60 })]);
      setSafety(s);
      setEntries(a.entries);
      setMore(a.more);
      onPausedChange?.(s.control.paused);
    } catch {
      toast('Could not load activity.', { tone: 'error' });
    }
  }, [filter, onPausedChange]);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(t);
  }, [load]);

  const loadMore = async () => {
    if (!entries?.length) return;
    const a = await api.nextActivity({ actor: filter || undefined, before: entries[entries.length - 1].seq, limit: 60 });
    setEntries([...entries, ...a.entries]);
    setMore(a.more);
  };

  const toggle = async () => {
    if (!safety) return;
    const paused = !safety.control.paused;
    setSwitching(true);
    haptic(paused ? 'warning' : 'light');
    try {
      const r = await api.nextPause(paused);
      toast(paused ? `Paused.${r.stopped ? ` Stopped ${r.stopped} running.` : ''} Nothing new starts.` : 'Next is on again. Nothing restarted on its own.');
      await load();
    } catch {
      toast('The switch did not save. Try again.', { tone: 'error' });
    } finally {
      setSwitching(false);
    }
  };

  const paused = safety?.control.paused ?? false;
  const groups: Array<{ day: string; items: LedgerEntry[] }> = [];
  for (const e of entries ?? []) {
    const day = dayKey(new Date(e.at));
    const g = groups.at(-1);
    if (g && g.day === day) g.items.push(e);
    else groups.push({ day, items: [e] });
  }

  return (
    <div className="na">
      <header className="n3-title-block">
        <h1 className="n3-title">Activity</h1>
        <p className="n3-subtitle">Everything Next did, and one switch to stop it.</p>
      </header>
      <section className={`na-control${paused ? ' is-paused' : ''}`} aria-live="polite">
        <div className="na-control-text">
          <p className="na-control-state">{paused ? 'Next is paused' : 'Next is on'}</p>
          <p className="na-control-line">
            {paused
              ? 'Nothing runs, not even the email check, until you turn it back on.'
              : safety?.running.length
                ? `${safety.running.length} working now: ${safety.running.map((r) => r.title).join(', ')}.`
                : 'Nothing is running. Next only starts work when you tap a button.'}
          </p>
        </div>
        <button type="button" className={`na-switch${paused ? ' is-on' : ''}`} onClick={() => void toggle()} disabled={!safety || switching}>
          {switching ? <Spinner size={14} /> : null}
          {paused ? 'Turn on' : 'Pause'}
        </button>
      </section>

      {safety ? (
        <p className={`na-seal${safety.ledger.ok ? '' : ' is-broken'}`}>
          {safety.ledger.ok ? <ShieldCheck size={15} strokeWidth={1.75} aria-hidden /> : <TriangleAlert size={15} strokeWidth={1.75} aria-hidden />}
          {safety.ledger.ok
            ? `This log can't be edited after the fact. ${safety.ledger.count} entries, checked ${clock(safety.ledger.checkedAt)}.`
            : `Something edited this log after it was written, starting at entry ${safety.ledger.brokenAt}.`}
        </p>
      ) : null}

      <div className="na-filter" role="tablist" aria-label="Show">
        {FILTERS.map((f) => (
          <button key={f.id || 'all'} type="button" role="tab" aria-selected={filter === f.id} className={filter === f.id ? 'is-on' : ''} onClick={() => setFilter(f.id)}>
            {f.label}
          </button>
        ))}
      </div>

      {!entries ? (
        <p className="list-empty">
          <Spinner size={14} /> Loading…
        </p>
      ) : !entries.length ? (
        <p className="np-quiet">Nothing yet. Every email check, reply, helper, and change you make shows up here.</p>
      ) : (
        groups.map((g) => (
          <section key={g.day} className="na-day" aria-label={dayLabel(g.day, now)}>
            <h2 className="np-block-head">{dayLabel(g.day, now)}</h2>
            <ol className="na-list">
              {g.items.map((e) => {
                const expanded = open === e.seq;
                const hasMore = Boolean(e.detail && Object.keys(e.detail).length) || Boolean(e.sessionId);
                return (
                  <li key={e.seq} className={`na-row is-${e.actor}${e.risk === 'low' || e.risk === 'high' ? ` is-risk-${e.risk}` : ''}`}>
                    <button type="button" className="na-row-main" onClick={() => setOpen(expanded ? null : e.seq)} aria-expanded={hasMore ? expanded : undefined} disabled={!hasMore}>
                      <span className="na-glyph" aria-hidden />
                      <span className="na-row-text">
                        <span className="na-row-who">
                          {ACTOR_WORD[e.actor] ?? e.actor}
                          <time dateTime={e.at}>{clock(e.at)}</time>
                        </span>
                        <span className="na-row-summary">{e.summary}</span>
                      </span>
                      {hasMore ? <ChevronDown size={15} strokeWidth={1.75} className={expanded ? 'is-open' : ''} /> : null}
                    </button>
                    {expanded ? (
                      <dl className="na-detail">
                        {Object.entries(e.detail ?? {}).map(([k, v]) => (
                          <div key={k}>
                            <dt>{k}</dt>
                            <dd>{String(v)}</dd>
                          </div>
                        ))}
                        {e.sessionId ? (
                          <div>
                            <dt>chat</dt>
                            <dd>{e.sessionId}</dd>
                          </div>
                        ) : null}
                        <div>
                          <dt>entry</dt>
                          <dd>#{e.seq}</dd>
                        </div>
                      </dl>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          </section>
        ))
      )}
      {more ? (
        <button type="button" className="np-new-row" onClick={() => void loadMore()}>
          Show older
        </button>
      ) : null}

      {safety ? (
        <section className="na-parts">
          <button type="button" className="np-settings-toggle" aria-expanded={partsOpen} onClick={() => setPartsOpen((v) => !v)}>
            What Next can and can't do
            <span>In plain words, with who enforces each rule</span>
          </button>
          {partsOpen
            ? safety.parts.map((part) => (
                <article key={part.id} className="na-part">
                  <h3>
                    {part.name}
                    <span>{part.model}</span>
                  </h3>
                  {part.reads.length ? (
                    <p>
                      <strong>Reads</strong> {part.reads.join('; ')}
                    </p>
                  ) : null}
                  {part.can.length ? (
                    <p>
                      <strong>Can</strong> {part.can.join('; ')}
                    </p>
                  ) : null}
                  {part.never.length ? (
                    <p>
                      <strong>Never</strong> {part.never.join('; ')}
                    </p>
                  ) : null}
                  <ul className="na-enforced">
                    {part.enforcedBy.map((r) => (
                      <li key={r.rule} className={`is-${r.how}`}>
                        <span>{HOW_WORD[r.how]}</span>
                        {r.rule}
                      </li>
                    ))}
                  </ul>
                </article>
              ))
            : null}
        </section>
      ) : null}
    </div>
  );
}
