/**
 * A thread, drawn the way the sidepanel draws one.
 *
 * User messages are light grey rounded bubbles. The assistant's answer is
 * plain markdown on the page background -- no bubble, no card, no avatar.
 *
 * Work is the interesting part. While a turn is running its steps are on
 * the page, live; the moment the final answer starts arriving they fold
 * into a single `Worked for …` row above it. `foldIsLive` below is that
 * rule: a running fold stays open until either the streamed answer has
 * begun or the transcript has already promoted an answer out of it. Mid-turn
 * commentary does not trigger it, because commentary is followed by more
 * tool calls, which clears the stream buffer and reopens the timeline.
 *
 * Two of these items never come from the transcript:
 *
 *  - a `pending` user bubble, appended the moment Send is tapped so the
 *    message is visible immediately, and dimmed until the transcript
 *    confirms it;
 *  - a `streaming` block, the answer as the CLI is writing it. It goes
 *    through the same markdown renderer as the finished answer so there is
 *    no reflow when the two swap.
 */
import { splitSkillTokens } from '../utils/slash';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type {
  Attachment,
  ChildSteps,
  CitationSource,
  ThreadItem,
  WorkBlock,
} from '../types';
import { FileIcon } from './Icons';
import { Markdown } from './MarkdownAsync';
import { WorkFold } from './WorkFold';
import { ErrorCard } from './ErrorCard';
import { QuestionCard } from './QuestionCard';
import { PressReveal } from './PressReveal';
import { MessageActions } from './MessageActions';
import type { CitationMark } from '../utils/citations';

function BubbleAttachments({ files }: { files: Attachment[] }) {
  return (
    <span className="bubble-files">
      {files.map((file, index) => (
        <span className="bubble-file" key={`${file.name}-${index}`}>
          <FileIcon size={12} strokeWidth={1.75} />
          <span className="bubble-file-name">{file.name}</span>
        </span>
      ))}
    </span>
  );
}

/**
 * A user turn, clamped when it is long.
 *
 * The defect this fixes: a pasted brief is one `user` item, and a bubble
 * has no upper bound, so a 300-word message rendered as a grey wall three
 * screens tall. Every reply above it was pushed out of reach, and the
 * thread stopped reading as a conversation -- it read as a document with
 * the assistant's answers buried in it.
 *
 * The clamp is 10 lines, measured rather than guessed: `scrollHeight`
 * against `clientHeight` on the collapsed element, so a short message
 * never renders a toggle it does not need. The virtualiser re-measures
 * through its own ResizeObserver, so expanding does not need to tell it
 * anything.
 *
 * The measurement runs in a layout effect and re-runs on resize, because
 * the same text clamps differently at 360px and 430px.
 */
export function UserBubble({
  text,
  pending,
  attachments,
}: {
  text: string;
  pending?: boolean;
  attachments?: Attachment[];
}) {
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);
  const bodyRef = useRef<HTMLSpanElement | null>(null);

  const measure = useCallback(() => {
    const el = bodyRef.current;
    if (!el || expanded) return;
    // Measured while the clamp is APPLIED, which is the only order that
    // works: an unclamped block reports `scrollHeight === clientHeight`
    // and would answer "no overflow" for every message ever sent.
    //
    // A 4px allowance, because sub-pixel line heights make an
    // exactly-fitting block report a stray pixel or two.
    setClamped(el.scrollHeight - el.clientHeight > 4);
  }, [expanded]);

  useLayoutEffect(() => {
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const el = bodyRef.current;
    if (!el) return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure, text]);

  // The clamp is on whenever the bubble is not expanded, including before
  // the first measurement -- see `measure` above. `clamped` only decides
  // whether the toggle is worth showing.
  const collapsed = clamped && !expanded;

  return (
    <div
      className={`user-bubble ${pending ? 'is-pending' : ''} ${
        collapsed ? 'is-clamped' : ''
      }`}
      data-content-surface="user-message"
      data-message-state={pending ? 'pending' : 'settled'}
    >
      {attachments?.length ? <BubbleAttachments files={attachments} /> : null}
      <span
        ref={bodyRef}
        className="user-bubble-body"
        data-clamped={expanded ? 'false' : 'true'}
      >
        {splitSkillTokens(text).map((part, i) =>
          part.kind === 'text' ? (
            part.text
          ) : (
            // A skill picked from the "/" menu (or the desktop's): the
            // name as a quiet inline chip, never the raw path.
            <span className="bubble-skill" key={i} title={part.path}>
              <span className="bubble-skill-mark" aria-hidden>/</span>
              {part.name}
            </span>
          ),
        )}
      </span>
      {clamped ? (
        <button
          type="button"
          className="user-bubble-toggle"
          aria-expanded={expanded}
          onClick={(event) => {
            // The bubble sits inside PressReveal, which owns press
            // gestures for copy. This tap means "expand", nothing else.
            event.stopPropagation();
            setExpanded((value) => !value);
          }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      ) : null}
    </div>
  );
}

/**
 * Whether the fold at `index` should still be showing its timeline.
 *
 * The rule, and the bug it replaces.
 *
 * The old rule was "live until any answer or streaming item follows". That
 * looks right and is not, because a `streaming` item is just whatever the
 * CLI has written to stdout -- and the agent narrates MID-TURN, between
 * tool calls, all the time. Every paragraph of commentary therefore
 * collapsed the timeline; the next tool call cleared the stream buffer and
 * re-opened it. On a chatty turn that is a fold flapping open and shut
 * several times a minute, which is exactly the reported "doesn't reliably
 * auto-expand, collapse is flaky".
 *
 * What actually distinguishes commentary from the final answer is whether
 * the agent is still doing anything. Commentary is followed by more work,
 * so a step in the block is still pending; the final answer only starts
 * once every step has its result. So:
 *
 *  - not running          -> not live (a finished turn opens collapsed)
 *  - a real `answer` item -> not live (the transcript has settled it)
 *  - streaming text while a step is still in flight -> LIVE (commentary)
 *  - streaming text with every step settled          -> not live (answer)
 *
 * Exported and tested directly; it is a state machine, not a detail.
 */
export function threadRowClassName(items: ThreadItem[], index: number): string {
  const kind = items[index]?.kind ?? 'unknown';
  const previous = items[index - 1]?.kind ?? 'start';
  return `thread-row is-${kind} after-${previous}`;
}

export function foldIsLive(items: ThreadItem[], index: number): boolean {
  const block = items[index];
  if (block.kind !== 'work' || !block.running) return false;

  const after = items.slice(index + 1);
  // The transcript has promoted an answer out of this turn: it is over.
  if (after.some((item) => item.kind === 'answer')) return false;
  // A question ends the turn too -- the card below is the point of it.
  if (after.some((item) => item.kind === 'question')) return false;

  if (!after.some((item) => item.kind === 'streaming')) return true;

  // Streaming, so decide whether it is commentary or the answer.
  return block.items.some(
    (item) => item.kind === 'step' && item.status === 'pending',
  );
}

/**
 * Whether the tail should already be settling while the turn runs.
 *
 * This is the moment the final answer starts streaming: every step has
 * its result, so there is no more work to narrate, but the turn is still
 * active and the transcript tail is still mounted. Keeping the full live
 * treatment here -- orb, shimmer, ticking clock -- leaves the thinking
 * UI shouting underneath an answer that has already begun. Instead the
 * tail renders its settled form early: the summary sentence plus the
 * quiet measurements, exactly the collapsed row the turn will keep.
 *
 * The commentary rule from `foldIsLive` applies unchanged: streaming
 * text while a step is still in flight is narration between tools, so
 * the tail stays live. Only streaming with nothing left pending -- or
 * streaming with no work block at all -- counts as answering.
 */
export function tailIsAnswering(items: ThreadItem[]): boolean {
  let start = 0;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i].kind === 'user') {
      start = i + 1;
      break;
    }
  }
  if (!items.slice(start).some((item) => item.kind === 'streaming')) {
    return false;
  }
  for (let i = start; i < items.length; i += 1) {
    if (items[i].kind === 'work' && foldIsLive(items, i)) return false;
  }
  return true;
}

/**
 * Whether a run of tool calls is currently in flight.
 *
 * This decides WHO draws the live row. When a run is running it draws its
 * own header -- the purpose sentence, the chevron into its steps, and the
 * clock under it -- and the standalone footer must not draw a second copy
 * of the same two rows a few pixels below. When no run is running, at the
 * very start of a turn or while the answer is being written, the footer
 * is the only thing that can.
 *
 * A running block with no step in it yet does NOT count: `WorkFold`
 * renders a `StepRun` only where there are steps, so there would be
 * nothing on screen to carry the row.
 *
 * Scans back to the last user message, because only the newest turn can
 * be running.
 */
export function liveWorkBlock(items: ThreadItem[]): WorkBlock | null {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item.kind === 'user') return null;
    if (
      item.kind === 'work' &&
      item.running &&
      item.items.some((part) => part.kind === 'step')
    ) {
      return item;
    }
  }
  return null;
}

export function hasLiveRun(items: ThreadItem[]): boolean {
  return liveWorkBlock(items) !== null;
}

export interface ThreadProps {
  items: ThreadItem[];
  /** The history has settled and is being shown (once per mount). */
  onReveal?: () => void;
  /** Whose thread this is -- local image paths resolve against it. */
  sessionId: string;
  sources: Record<string, CitationSource>;
  subagentSteps: Record<string, ChildSteps>;
  onInspectSubagent: (childId: string, title: string) => void;
  onOpenCitation: (mark: CitationMark) => void;
  /** Send a question's chosen option as a follow-up message. */
  onAnswer?: (header: string, label: string) => Promise<void>;
  /**
   * Start a new session from a question only the desktop can answer.
   *
   * The card offers this instead of a dead read-only notice; see
   * `QuestionCard`.
   */
  onRecover?: (label: string, questionId?: string) => Promise<void>;
  /** A send is in flight, so question cards hold their buttons. */
  busy?: boolean;
  /** The running block whose final run is mounted below this list. */
  detachedLiveWorkId?: string | null;
  /**
   * The SAME element App.tsx already scrolls (`.thread-scroll`, ref
   * `scroller` there) and pins to the bottom of during streaming.
   *
   * Virtualization needs to know the real scroll container to measure
   * against, but it must not become a SECOND scrollable element -- Day 1
   * plan 5.7 asks for the existing container to stay the only one, and
   * App.tsx's own pin-to-bottom effect (`el.scrollTop = el.scrollHeight`)
   * already assumes there is exactly one. react-virtual is fine with this:
   * it only needs a ref to the scrolling ancestor, not ownership of it.
   */
  scrollElementRef: RefObject<HTMLDivElement | null>;
}

/**
 * A rendered thread item does not carry its own key/height -- `Thread`
 * used to be a flat `.map()`. Pulled out unchanged into its own function so
 * the virtualizer can call it per visible row instead of for the whole
 * list at once.
 */
function renderItem(
  item: ThreadItem,
  index: number,
  items: ThreadItem[],
  props: ThreadProps,
) {
  if (item.kind === 'user') {
    return (
      <PressReveal
        className="turn turn-user"
        text={item.text}
        align="end"
        // Not while pending. A message that has not come back from the
        // transcript yet can still fail, and offering to copy it implies
        // it is a settled part of the conversation.
        enabled={!item.pending}
      >
        <UserBubble
          text={item.text}
          pending={item.pending}
          attachments={item.attachments}
        />
      </PressReveal>
    );
  }
  if (item.kind === 'work') {
    return (
      <WorkFold
        block={item}
        sessionId={props.sessionId}
        live={foldIsLive(items, index)}
        detachLiveRun={item.id === props.detachedLiveWorkId}
        subagentSteps={props.subagentSteps}
        onInspectSubagent={props.onInspectSubagent}
        sources={props.sources}
        onOpenCitation={props.onOpenCitation}
      />
    );
  }
  if (item.kind === 'error') {
    return <ErrorCard alert={item.alert} />;
  }
  if (item.kind === 'question') {
    return (
      <QuestionCard
        item={item}
        busy={props.busy}
        onAnswer={props.onAnswer}
        onRecover={props.onRecover ? (label) => props.onRecover!(label, item.id) : undefined}
      />
    );
  }
  const streaming = item.kind === 'streaming';
  return (
    /*
     * Answers are selectable. They used to sit inside the hold-to-reveal
     * wrapper, which turned selection off for the whole turn so a long
     * press would not race the system callout -- and then a second, always
     * visible copy icon was added underneath, so the hold and the icon
     * both copied the same text. One control, with a label, and the
     * paragraph can be selected like any other reading surface. User
     * bubbles still reveal on hold: they have no standing button.
     */
    <div className="turn turn-answer">
      <div
        className="answer"
        data-content-surface="assistant-answer"
        data-answer-state={streaming ? 'streaming' : 'settled'}
      >
        <Markdown
          text={item.text}
          streaming={streaming}
          sources={props.sources}
          sessionId={props.sessionId}
          onOpenCitation={props.onOpenCitation}
        />
        {!streaming ? <MessageActions text={item.text} standing /> : null}
      </div>
    </div>
  );
}

/** How long a newly arrived row keeps its entrance flag. */
const FRESH_MS = 900;

/**
 * Which rows are genuinely new, so only they animate in.
 *
 * Everything present on first paint is history and never animates. A row
 * that arrives later is stamped with its arrival time and counts as fresh
 * for `FRESH_MS` -- long enough for re-renders mid-entrance to keep the
 * flag, short enough that scrolling back to it later (the virtualizer
 * remounts rows as they re-enter the window) does not replay anything.
 * An answer that replaces a streaming item at the same index is not new:
 * its words already arrived, so it settles without a second entrance.
 */
function useFreshRows(items: ThreadItem[]): (id: string) => boolean {
  const arrived = useRef<Map<string, number> | null>(null);
  const previous = useRef<ThreadItem[]>(items);
  const now = Date.now();
  if (arrived.current === null) {
    arrived.current = new Map(items.map((item) => [item.id, 0]));
  }
  const map = arrived.current;
  /*
   * The first batch after an empty thread is the history arriving, not a
   * conversation happening: it used to mark every row fresh, so twelve
   * bubbles and answers each ran their own blur-and-lift at once. The
   * history is revealed as one surface instead (`data-revealed` below).
   */
  const firstBatch = previous.current.length === 0 && items.length > 1;
  items.forEach((item, index) => {
    if (map.has(item.id)) return;
    const before = previous.current[index];
    const settled =
      (item.kind === 'answer' && before?.kind === 'streaming') ||
      // The transcript's copy of a message the phone already drew.
      (item.kind === 'user' && before?.kind === 'user' && Boolean(before.pending));
    map.set(item.id, settled || firstBatch ? 0 : now);
  });
  previous.current = items;
  return (id: string) => {
    const at = map.get(id) ?? 0;
    return at > 0 && now - at < FRESH_MS;
  };
}

export function Thread(props: ThreadProps) {
  const { items } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const isFresh = useFreshRows(items);
  /*
   * Whether the history has been shown yet. The loading skeleton sits
   * outside this component, so the moment items first exist is the moment
   * the conversation should fade up as one piece.
   */
  /*
   * 'pending' (nothing yet) -> 'settling' (laid out but invisible) ->
   * 'fade' (shown once, opacity only).
   *
   * The first layout is not the final one: the list starts from estimated
   * row heights and measures them a frame later, the landing re-pins to the
   * bottom, and on a cold start the markdown renderer swaps in for plain
   * text. Showing the history while that happens is the jitter you see on
   * opening a chat. So it is laid out hidden, and revealed only when its
   * height has held still for three frames with no plain-text stand-ins
   * left (or after a short ceiling, so nothing can hold it back).
   */
  const [revealed, setRevealed] = useState<'pending' | 'settling' | 'fade'>(
    items.length > 0 ? 'settling' : 'pending',
  );
  useEffect(() => {
    if (revealed === 'pending' && items.length > 0) setRevealed('settling');
  }, [items.length, revealed]);
  useEffect(() => {
    if (revealed !== 'settling') return undefined;
    const started = performance.now();
    let last = -1;
    let still = 0;
    let raf = requestAnimationFrame(function check() {
      const box = containerRef.current;
      const scroller = props.scrollElementRef.current;
      const h = (box?.offsetHeight ?? 0) + (scroller?.scrollHeight ?? 0);
      still = h === last ? still + 1 : 0;
      last = h;
      const plain = box?.querySelector('.md-pending');
      /*
       * A visual whose height is not known yet will grow by hundreds of
       * pixels when its page reports in, and a chat pinned to its end
       * slides with it. Heights are remembered across launches
       * (VisualBlock), so this only waits on a block seen for the first
       * time, and never past the ceiling.
       */
      const unsized = box?.querySelector('.md-visual:not([data-sized])');
      const ceiling = unsized ? 1100 : 700;
      if ((still >= 3 && !plain && !unsized) || performance.now() - started > ceiling) {
        setRevealed('fade');
        return;
      }
      raf = requestAnimationFrame(check);
    });
    return () => cancelAnimationFrame(raf);
  }, [revealed, props.scrollElementRef]);
  const { onReveal } = props;
  useEffect(() => {
    if (revealed === 'fade') onReveal?.();
  }, [revealed, onReveal]);

  /**
   * Item heights vary enormously -- a one-line answer next to a work fold
   * with a whole tool-call timeline -- so this is dynamic measurement, not
   * a fixed row height. `estimateSize` only has to be a plausible guess for
   * the FIRST layout pass; `measureElement` (wired below via the ref
   * callback) corrects it against the real rendered height afterward, and
   * on every resize (a streaming answer growing token by token included --
   * that resizes the mounted element, which triggers react-virtual's own
   * ResizeObserver).
   *
   * The guess is per kind rather than a flat 80px. A flat guess starts the
   * scrollbar and the landing position from fiction on any thread with
   * real answers in it, and every correction is a visible jump; medians
   * per kind start close enough that measuring settles instead of lurches.
   *
   * `overscan: 6` and `scrollMargin` matching this component's own offset
   * within `.thread-scroll` are both from the Day 1 plan's 5.7. The offset
   * matters because `.thread-scroll` can render a loading/error paragraph
   * ABOVE this component -- without `scrollMargin` the virtualizer would
   * assume its content starts at the scroll container's own top edge.
   */
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => props.scrollElementRef.current,
    estimateSize: (index) => {
      switch (items[index]?.kind) {
        case 'user':
          return 76;
        case 'work':
          return 44;
        case 'answer':
          return 240;
        case 'streaming':
          return 120;
        case 'question':
          return 260;
        case 'error':
          return 90;
        default:
          return 80;
      }
    },
    overscan: 6,
    getItemKey: (index) => items[index].id,
    scrollMargin: containerRef.current?.offsetTop ?? 0,
  });

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div
      className="thread"
      ref={containerRef}
      data-content-surface="thread"
      data-revealed={revealed === 'pending' ? undefined : revealed}
    >
      <div
        data-content-surface="thread-content"
        style={{
          position: 'relative',
          width: '100%',
          height: virtualizer.getTotalSize(),
        }}
      >
        {virtualItems.map((virtualRow) => {
          const item = items[virtualRow.index];
          return (
            <div
              key={virtualRow.key}
              ref={virtualizer.measureElement}
              data-index={virtualRow.index}
              data-thread-item={item.kind}
              data-fresh={isFresh(item.id) ? 'true' : undefined}
              className={threadRowClassName(items, virtualRow.index)}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${
                  virtualRow.start - virtualizer.options.scrollMargin
                }px)`,
              }}
            >
              {renderItem(item, virtualRow.index, items, props)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
