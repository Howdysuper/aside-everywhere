/**
 * Choosing what a screen is scoped to. Two controls, two homes:
 *
 *  - ViewMenu: the phone's To Do screen. One quiet button naming the
 *    current list (Homework, School, Personal) with a chevron; the lists
 *    live in a small glass menu that opens from the button, with a
 *    checkmark on the open one. Dropdowns read cleaner than three pills
 *    in a narrow top bar, and the counts still wait inside.
 *
 *  - SpaceSwitch: the classic two-way School / Personal pill for the Mac
 *    sidebar and the Projects tab, where projects only have two homes.
 *
 * Each menu row shows how much waits there today, and a clay dot if a
 * list you are NOT looking at has a real deadline today or already past,
 * so separating never hides something urgent.
 */
import { Fragment, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { BookOpen, Check, ChevronDown, Home, School } from './Icons';
import { haptic } from '../telegram';
import type { NextSpace } from '../types';
import { SPACES, type SpaceSummary } from '../utils/nextSpace';

export type NextView = 'homework' | 'school' | 'personal';

/** What the phone's To Do menu offers. */
export const VIEW_SEGMENTS: Array<{ id: NextView; label: string; space: NextSpace }> = [
  { id: 'homework', label: 'Homework', space: 'school' },
  { id: 'school', label: 'School', space: 'school' },
  { id: 'personal', label: 'Personal', space: 'personal' },
];

/**
 * A small line icon standing for what each list is: a book for homework,
 * a schoolhouse for school, a home for personal. One monochrome family,
 * inheriting the text color, so it reads as typography rather than a
 * colored dot. (The clay dots stay on the SpaceSwitch pills, where they
 * mark the space; the words next to them carry no icon there.)
 */
export function ViewIcon({ view, size = 15 }: { view: NextView; size?: number }) {
  const props = { size, strokeWidth: 2, className: 'sp-menu-icon', 'aria-hidden': true } as const;
  if (view === 'homework') return <BookOpen {...props} />;
  if (view === 'personal') return <Home {...props} />;
  return <School {...props} />;
}

export function SpaceGlyph({ space, size = 8 }: { space: NextSpace | NextView; size?: number }) {
  return <span className={`sp-glyph is-${space}`} style={{ width: size, height: size }} aria-hidden />;
}

export function ViewMenu({
  view,
  onViewChange,
  summary,
}: {
  view: NextView;
  onViewChange: (v: NextView) => void;
  summary?: Partial<Record<NextView, SpaceSummary>>;
}) {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [active, setActive] = useState(0);
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );

  const current = VIEW_SEGMENTS.find((s) => s.id === view) ?? VIEW_SEGMENTS[1];
  const shown = open && !closing;

  const dismiss = (refocus = true) => {
    if (!open) return;
    setClosing(true);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      setOpen(false);
      setClosing(false);
      if (refocus) btnRef.current?.focus();
    }, 170);
  };

  const show = () => {
    if (open) {
      dismiss();
      return;
    }
    if (timer.current) window.clearTimeout(timer.current);
    setClosing(false);
    setActive(VIEW_SEGMENTS.findIndex((s) => s.id === view));
    // The panel portals to the body so the top bar's stacking context
    // cannot sandwich it under the floating tab bar.
    const r = btnRef.current?.getBoundingClientRect();
    setAnchor(r ? { top: r.bottom + 8, left: r.left + r.width / 2 } : null);
    setOpen(true);
    haptic('light');
    window.setTimeout(() => menuRef.current?.focus(), 30);
  };

  const choose = (id: NextView) => {
    dismiss(false);
    if (id !== view) onViewChange(id);
  };

  const onKey = (e: KeyboardEvent) => {
    if (!open) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      dismiss();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : VIEW_SEGMENTS.length - 1;
      setActive((a) => (a + step) % VIEW_SEGMENTS.length);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      choose(VIEW_SEGMENTS[active].id);
    }
  };

  return (
    <div className={`sp-menu${shown ? ' is-open' : ''}`}>
      <button
        ref={btnRef}
        type="button"
        className="sp-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={show}
      >
        <ViewIcon view={view} />
        <span className="sp-menu-label">{current.label}</span>
        <ChevronDown size={15} strokeWidth={2.2} className="sp-menu-chevron" aria-hidden />
      </button>
      {open && anchor
        ? createPortal(
            <>
              <div className={`sp-menu-scrim${closing ? ' is-out' : ''}`} onClick={() => dismiss()} aria-hidden />
              <div
                ref={menuRef}
                className={`sp-menu-panel${closing ? ' is-out' : ''}`}
                role="menu"
                aria-label="Choose a list"
                tabIndex={-1}
                style={{ top: anchor.top, left: anchor.left }}
                onKeyDown={onKey}
              >
                {VIEW_SEGMENTS.map((s, i) => {
                  const sum = summary?.[s.id];
                  const on = s.id === view;
                  return (
                    <Fragment key={s.id}>
                      {i > 0 ? <div className="sp-menu-sep" aria-hidden /> : null}
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={on}
                      tabIndex={-1}
                      className={`sp-menu-item${on ? ' is-on' : ''}${i === active ? ' is-active' : ''}`}
                      onPointerDown={() => setActive(i)}
                      onClick={() => choose(s.id)}
                    >
                      <span className="sp-menu-check" aria-hidden>
                        {on ? <Check size={15} strokeWidth={2.4} /> : null}
                      </span>
                      <ViewIcon view={s.id} />
                      <span className="sp-menu-item-label">{s.label}</span>
                      {sum && sum.count > 0 ? (
                        <span className={`sp-menu-count${sum.urgent && !on ? ' has-urgent' : ''}`}>
                          {sum.urgent && !on ? <span className="sp-menu-count-dot" aria-hidden /> : null}
                          {sum.count}
                        </span>
                      ) : null}
                    </button>
                    </Fragment>
                  );
                })}
              </div>
            </>,
            document.body,
          )
        : null}
    </div>
  );
}

export function SpaceSwitch({
  space,
  onChange,
  summary,
  variant = 'phone',
}: {
  space?: NextSpace;
  onChange?: (s: NextSpace) => void;
  summary?: Partial<Record<NextSpace, SpaceSummary>>;
  variant?: 'phone' | 'desk';
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const to: NextSpace = e.key === 'ArrowLeft' ? 'school' : 'personal';
    onChange!(to);
    refs.current[to === 'school' ? 0 : 1]?.focus();
  };
  return (
    <div className={`sp-switch is-${variant}`} data-space={space} role="tablist" aria-label="School or personal" onKeyDown={onKey}>
      <span className="sp-thumb" aria-hidden />
      {SPACES.map(({ id, label }, i) => {
        const s = summary?.[id];
        const on = id === space;
        const alert = !on && s?.urgent;
        return (
          <button
            key={id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            aria-selected={on}
            tabIndex={on ? 0 : -1}
            className={on ? 'is-on' : ''}
            onClick={() => !on && onChange!(id)}
            aria-label={`${label}${s ? `, ${s.count} today${alert ? ', has something due' : ''}` : ''}`}
          >
            <SpaceGlyph space={id} />
            <span className="sp-label">{label}</span>
            {s && s.count > 0 ? <span className="sp-count">{s.count}</span> : null}
            {alert ? <span className="sp-alert" aria-hidden /> : null}
          </button>
        );
      })}
    </div>
  );
}

/** "Where does this live?" inside add and edit forms. */
export function SpaceChoice({ value, onChange }: { value: NextSpace; onChange: (s: NextSpace) => void }) {
  return (
    <div className="np-chips sp-choice" role="radiogroup" aria-label="School or personal">
      {SPACES.map(({ id, label }) => (
        <button type="button" key={id} role="radio" aria-checked={value === id} className={value === id ? 'is-on' : ''} onClick={() => onChange(id)}>
          <SpaceGlyph space={id} size={7} />
          {label}
        </button>
      ))}
    </div>
  );
}
