/** Dev-only harness for the thread tail: error card, live run, live view. */
import './fit';
import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './theme/tokens.css';
import './theme/base.css';
import './theme/components.css';
import './theme/next.css';
import './theme/next3.css';
import './theme/next-polish.css';
import './theme/polish.css';
import './theme/polish-next.css';
import './theme/refine.css';
import './theme/fits.css';
import type { ThreadItem, WorkStep } from './types';
import { Thread } from './components/Thread';
import { Composer } from './components/Composer';
import { ErrorCard } from './components/ErrorCard';
import { LiveWorkTail } from './components/WorkFold';
import { LiveBadge } from './components/LiveBrowser';
import { ChevronLeft, Globe, MoreVertical } from './components/Icons';
import { withoutResolvedErrors } from './utils/resolvedErrors';
import { ChevronDown, Maximize2 } from 'lucide-react';

document.documentElement.dataset.client = 'standalone';
document.documentElement.dataset.fit = location.search.includes('dark') ? 'midnight' : 'paper';
document.documentElement.dataset.fitPair = 'clay';
document.documentElement.classList.toggle('dark', location.search.includes('dark'));
const state = new URLSearchParams(location.search).get('state') || 'error';

function step(id: string, label: string, status: WorkStep['status'] = 'success', tool = 'bash'): WorkStep {
  return { kind: 'step', id, label, tool, icon: 'terminal', status, diffstat: null, detail: null, images: [] } as WorkStep;
}

const base: ThreadItem[] = [
  { kind: 'user', id: 'u1', text: 'Why is the orb so low quality? It needs more polish with the setup and layout.', ts: 1 },
  { kind: 'work', id: 'w1', durationMs: 3200, running: false,
    items: [step('s1', 'Read a file', 'success', 'read_file'), step('s2', 'Wrote a file', 'error', 'write_file')] },
];
const errorItem: ThreadItem = {
  kind: 'error', id: 'e1', text: 'Request timed out.', ts: 2,
  alert: { title: 'There was an error while running the task', description: 'Request timed out.', detail: 'Request timed out.', tone: 'destructive' },
};
const running = { kind: 'work' as const, id: 'w2', durationMs: 2000, running: true,
  items: [step('r1', 'Move old prototype aside', 'pending')] };

function Lab() {
  const scroller = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState('');
  const [, setTick] = useState(0);
  useEffect(() => { setTick(1); }, []);
  const items: ThreadItem[] = state === 'live' ? base : [...base, errorItem];
  const live = state === 'live';
  return (
    <div className="app app-thread">
      <header className="thread-header" data-condensed="false">
        <div className="thread-header-left">
          <button type="button" className="icon-button" aria-label="Back"><ChevronLeft size={20} strokeWidth={1.75} /></button>
        </div>
        <span className="thread-titles">
          <span className="thread-title">Example task</span>
          <span className="thread-subtitle">Working · 7m 57s</span>
        </span>
        <div className="thread-header-right">
          <button type="button" className="icon-button" aria-label="Session panel"><MoreVertical size={19} strokeWidth={1.75} /></button>
        </div>
      </header>
      <div className="thread-scroll" ref={scroller}>
        {live ? (
          <div className="live-view is-expanded" data-card-kind="live-view">
            <button type="button" className="live-view-head">
              <span className="live-view-favicon"><Globe size={14} /></span>
              <span className="live-view-titles">
                <span className="live-view-title">Example page | Docs</span>
                <span className="live-view-host">Agent tab · example.com</span>
              </span>
              <LiveBadge mode="live" />
              <ChevronDown className="live-view-chevron" size={16} aria-hidden />
            </button>
            <button type="button" className="live-view-stage" style={{ aspectRatio: '16 / 10' }}>
              <img className="live-view-frame" src="/art/zeron-liquid-dots-v2.webp" alt="" style={{ objectFit: 'cover', objectPosition: '50% 25%' }} />
              <span className="live-view-expand" aria-hidden><Maximize2 size={14} /></span>
            </button>
          </div>
        ) : null}
        <Thread items={withoutResolvedErrors(items, state !== 'error')} sessionId="lab" sources={{}} subagentSteps={{}} onInspectSubagent={() => {}}
          onOpenCitation={() => {}} onAnswer={() => Promise.resolve()} busy={state !== 'error'} scrollElementRef={scroller} />
        {state === 'alert' ? <ErrorCard alert={(errorItem as Extract<ThreadItem, { kind: 'error' }>).alert} /> : null}
        {state !== 'error' ? (
          <LiveWorkTail block={running} activity={{ label: 'Move old prototype aside', work: 'tools',
            startedAt: Date.now() - 476000, tokens: 13000, seed: 'lab' }} subagentSteps={{}} onInspectSubagent={() => {}} />
        ) : null}
      </div>
      <footer className="thread-footer" data-at-end="true">
        <Composer variant="reply" value={draft} onChange={setDraft} onSubmit={() => setDraft('')}
          pills={{ modelLabel: 'Claude Opus 5.5', effortLabel: 'High', effortId: 'high', provider: 'claude-code' }}
          onOpenModel={() => {}} attachments={[]} onAddFiles={() => {}} onRemoveAttachment={() => {}}
          streaming={state !== 'error'} />
      </footer>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<StrictMode><Lab /></StrictMode>);
