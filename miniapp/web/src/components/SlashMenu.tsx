import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { SlidersHorizontal, SquarePen } from 'lucide-react';
import type { SkillsStatus } from '../hooks/useSkills';
import { GROUP_LABEL, type SlashItem } from '../utils/slash';

/**
 * The "/" menu: commands and skills, grown upward out of the composer.
 *
 * It sits where web-search suggestions sit -- inside the composer card,
 * above the field -- so the thumb never travels and the keyboard pushes it
 * up rather than covering it. With no query it is a browsable, grouped
 * list (commands, your skills, built in, sites); once you type it becomes
 * one ranked list, with each row's group named quietly on the right.
 *
 * Motion (transitions.dev menu-dropdown, beUI select): the panel opens in
 * 250ms from scale .97 on `cubic-bezier(.22,1,.36,1)` and leaves in 150ms;
 * the first rows settle in 35ms apart. All of it is opacity/transform and
 * all of it is off under reduced motion.
 */

const TAG = { commands: 'Command', yours: 'Yours', builtin: 'Built in', sites: 'Site' } as const;

const itemKey = (item: SlashItem) => (item.kind === 'command' ? `c:${item.id}` : `s:${item.skill.path}`);
const itemName = (item: SlashItem) => (item.kind === 'command' ? item.name : item.skill.name);
const itemDescription = (item: SlashItem) =>
  item.kind === 'command' ? item.description : item.skill.description;
const itemGroup = (item: SlashItem) => (item.kind === 'command' ? 'commands' : item.skill.group);

function initials(name: string): string {
  const words = name.replace(/[^A-Za-z0-9 ]+/g, ' ').trim().split(/\s+/);
  if (!words[0]) return '?';
  // One letter per word, at most two, always capitals: "Brag" -> B,
  // "Brag Slim" -> BS. Mixed "Br"/"AB" read as noise down a long list.
  return words.slice(0, 2).map((w) => w[0]).join('').toUpperCase();
}

function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim().toLowerCase();
  const at = q ? text.toLowerCase().indexOf(q) : -1;
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="slash-match">{text.slice(at, at + q.length)}</mark>
      {text.slice(at + q.length)}
    </>
  );
}

function Mark({ item }: { item: SlashItem }) {
  if (item.kind === 'command') {
    const Icon = item.id === 'new' ? SquarePen : SlidersHorizontal;
    return (
      <span className="slash-mark is-command" aria-hidden>
        <Icon size={15} strokeWidth={1.75} />
      </span>
    );
  }
  return (
    <span className="slash-mark" data-group={item.skill.group} aria-hidden>
      {initials(item.skill.name)}
    </span>
  );
}

export function SlashMenu({
  items,
  query,
  active,
  showActive = true,
  status,
  closing,
  onPick,
  onActive,
}: {
  items: SlashItem[];
  query: string;
  active: number;
  /** Off on touch with no query: nothing is "chosen" until you type or tap. */
  showActive?: boolean;
  status: SkillsStatus;
  closing?: boolean;
  onPick: (item: SlashItem) => void;
  onActive: (index: number) => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  // Rows stagger in only as the panel opens, never on every keystroke.
  const [entering, setEntering] = useState(true);
  useEffect(() => {
    const t = window.setTimeout(() => setEntering(false), 450);
    return () => window.clearTimeout(t);
  }, []);

  /*
   * Fit the list to the room the keyboard leaves.
   *
   * A fixed cap (44dvh) ignores the keyboard: with it up on a phone the
   * card grew past the header and pushed the text field under the keys, so
   * you could not see what you were typing. The list instead takes exactly
   * the space between the header and the rest of the card, re-measured
   * whenever #root resizes (the keyboard animates its height) or the card
   * changes shape.
   */
  const section = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const menu = section.current;
    const el = list.current;
    const card = menu?.closest<HTMLElement>('.composer');
    const root = document.getElementById('root');
    if (!menu || !el || !card || !root) return;
    let raf = 0;
    const fit = () => {
      raf = 0;
      const rootBox = root.getBoundingClientRect();
      const header = document.querySelector<HTMLElement>('.thread-header');
      const top = Math.max(
        rootBox.top + 12,
        header && header.offsetParent ? header.getBoundingClientRect().bottom + 8 : rootBox.top + 56,
      );
      const cardBox = card.getBoundingClientRect();
      const listH = el.getBoundingClientRect().height;
      // Two limits: the card's top stays below the header, and its bottom
      // stays inside #root (an over-tall card spills past it, under the
      // keyboard). Grow or shrink the list by whichever is tighter.
      const delta = Math.min(cardBox.top - top, rootBox.bottom - 8 - cardBox.bottom);
      const room = Math.floor(listH + delta);
      const next = `${Math.max(132, Math.min(360, room))}px`;
      if (el.style.maxHeight !== next) el.style.maxHeight = next;
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(fit);
    };
    fit();
    const ro = new ResizeObserver(schedule);
    ro.observe(root);
    ro.observe(card);
    window.visualViewport?.addEventListener('resize', schedule);
    return () => {
      ro.disconnect();
      window.visualViewport?.removeEventListener('resize', schedule);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  // Keep the keyboard-highlighted row in view without yanking the list on
  // every touch scroll: only when the index changes.
  useEffect(() => {
    const row = list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  // New query, back to the top: the best match is first.
  useEffect(() => {
    list.current?.scrollTo({ top: 0 });
  }, [query]);

  const searching = Boolean(query.trim());
  let lastGroup = '';

  return (
    <section
      ref={section}
      className="slash-menu"
      data-state={closing ? 'closing' : 'open'}
      data-entering={entering ? 'true' : undefined}
      aria-label="Commands and skills"
    >
      <div
        className="slash-list"
        ref={list}
        role="listbox"
        id="slash-listbox"
        aria-activedescendant={showActive && items[active] ? `slash-opt-${active}` : undefined}
      >
        {items.length === 0 ? (
          <p className="slash-empty">
            {status === 'loading'
              ? 'Loading skills from your computer'
              : <>Nothing matches <span className="slash-empty-query">/{query}</span></>}
          </p>
        ) : (
          items.map((item, index) => {
            const group = itemGroup(item);
            const header = !searching && group !== lastGroup;
            lastGroup = group;
            return (
              <div key={itemKey(item)} className="slash-slot" style={{ '--i': Math.min(index, 8) } as React.CSSProperties}>
                {header ? (
                  <div className="slash-group" role="presentation">
                    {GROUP_LABEL[group]}
                  </div>
                ) : null}
                <button
                  type="button"
                  role="option"
                  id={`slash-opt-${index}`}
                  data-index={index}
                  aria-selected={showActive && index === active}
                  className={`slash-row${showActive && index === active ? ' is-active' : ''}`}
                  // Keep the textarea focused (and the keyboard up) through the tap.
                  onPointerDown={(e) => e.preventDefault()}
                  onMouseMove={() => index !== active && onActive(index)}
                  onClick={() => onPick(item)}
                >
                  <Mark item={item} />
                  <span className="slash-text">
                    <span className="slash-name">
                      <Highlight text={itemName(item)} query={query} />
                    </span>
                    {itemDescription(item) ? (
                      <span className="slash-desc">{itemDescription(item)}</span>
                    ) : null}
                  </span>
                  {searching ? <span className="slash-tag">{TAG[group]}</span> : null}
                </button>
              </div>
            );
          })
        )}
      </div>
      {status === 'offline' ? (
        <p className="slash-status" role="status">
          <span className="slash-status-dot" aria-hidden />
          Showing your saved list. Reconnecting to your computer.
        </p>
      ) : null}
    </section>
  );
}
