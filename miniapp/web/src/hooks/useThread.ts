/**
 * A live thread.
 *
 * Round 2 treated the socket as a doorbell: "something changed" arrived,
 * and the client answered by refetching the entire structured thread
 * through the CLI facade, throttled to 1.2s. That is why a reply appeared
 * all at once -- nothing could be drawn until a process spawn had returned
 * the whole turn.
 *
 * Now the server sends the thread itself, as tail deltas, and this hook
 * only applies them. Three layers stack, from most to least authoritative:
 *
 *  1. `thread_delta` -- built from the transcript. Truth.
 *  2. `stream_delta` -- the answer as the CLI writes it to stdout, shown as
 *     a live paragraph. Dropped the instant a delta covers it, because the
 *     transcript's version is the real one.
 *  3. the optimistic echo -- the message the user just sent, appended
 *     locally so the bubble appears on tap instead of when the first reply
 *     lands. Retired as soon as the same text shows up in the thread.
 */
import { hasPendingNativeQuestion } from '../utils/sessionState';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TranscriptSocket, api } from '../api';
import { readThreadCache, writeThreadCache } from '../threadcache';
import { threadErrorText } from '../utils/format';
import { haptic } from '../telegram';
import { playSound } from '../utils/sounds';
import {
  applySessionState,
  type SessionStateEvent,
} from '../utils/sessionState';
import type {
  Attachment,
  ChildSession,
  ChildSteps,
  CitationSource,
  ErrorAlert,
  ThreadItem,
  ThreadModel,
  ThreadResponse,
  ThreadStats,
  Todo,
  UserItem,
} from '../types';

/** Longest the socket waits for the first REST load before connecting. */
const FIRST_CONNECT_CEILING_MS = 1_500;
/**
 * While a turn is running and the socket is down, refetch this often.
 *
 * The socket is the live path, and it reconnects on its own; this is the
 * floor under it. A phone on a flaky link, or a tunnel that will not
 * upgrade, used to show a frozen thread until the turn ended. Now the
 * thread still advances, a few seconds at a time.
 */
const OFFLINE_POLL_MS = 4_000;

/** Give up on an un-echoed optimistic bubble after this long. */
const PENDING_TTL_MS = 120_000;

/**
 * How many times an empty thread that failed to load is retried before the
 * error card appears. The failure being covered is a cold-start race of a
 * second or two, so this only has to outlast it.
 */
const LOAD_RETRIES = 4;

export interface PendingMessage {
  text: string;
  attachments: Attachment[];
  at: number;
}

export interface ThreadState {
  items: ThreadItem[];
  title: string;
  busy: boolean;
  stoppable: boolean;
  queued: number;
  /** Null means "not known" -- the caller must hide, not guess. */
  permission: string | null;
  permissionMode: string | null;
  finalConfirm: boolean | null;
  /** True when the confirm toggle means the soft protocol, not the daemon's. */
  softConfirm: boolean;
  model: ThreadModel | null;
  /** Token counters for the context ring and the streaming footer. */
  stats: ThreadStats;
  /** Ring denominator, in tokens. */
  contextWindow: number;
  /** Web sources any citation in this thread can resolve against. */
  sources: Record<string, CitationSource>;
  /** Every subagent of this session, for the panel. */
  subagents: ChildSession[];
  /** Each subagent's own timeline, keyed by child session id. */
  subagentSteps: Record<string, ChildSteps>;
  /** Set when this session is itself a subagent. */
  parentId: string | null;
  /** The agent's task list, replayed from its `write_todos` calls. */
  todos: Todo[];
  /**
   * Blocked on a native question tool only the desktop app can answer.
   *
   * The composer disables itself on this: sending would queue an `aside
   * exec` that hangs forever against a suspended session.
   */
  suspended: boolean;
  /**
   * Whether `suspended` has an actual question behind it "Continue in a
   * new session" can seed from. See `ThreadResponse.hasRecoverableQuestion`.
   */
  hasRecoverableQuestion: boolean;
  /** Characters streamed so far this turn, for the footer's estimate. */
  streamingChars: number;
  activity: {
    phase: 'thinking' | 'writing' | null;
    tools: string[];
    summary?: string | null;
  } | null;
  loading: boolean;
  error: string | null;
  connected: boolean;
  /** Last reconnect timestamp, or 0. See the state note above. */
  reconnectedAt: number;
  /**
   * Turn-level failures, as cards.
   *
   * These come off `turn_finished` rather than the transcript -- a CLI that
   * exits non-zero without ever writing an assistant record has nothing in
   * the transcript to render, and this is the only place that failure
   * exists.
   */
  alerts: ErrorAlert[];
  /** Stop the running turn. Safe to call when nothing is running. */
  stop: () => Promise<void>;
  /** True between tapping Stop and the turn actually ending. */
  stopping: boolean;
  refresh: () => void;
  /** Clear any error cards raised by `turn_finished`. */
  dismissAlerts: () => void;
  /** Show a just-sent message immediately, before the transcript has it. */
  addPending: (message: PendingMessage) => void;
  clearPending: () => void;
  /** Reflect a permission change without waiting for a refetch. */
  applyPermission: (next: {
    permission: string | null;
    permissionMode: string | null;
    finalConfirm: boolean | null;
  }) => void;
  /** Current mute state for push notifications. */
  muted: boolean;
  /** Reflect a mute/unmute without waiting for a refetch. */
  setMuted: (next: boolean) => void;
}

/** Apply a tail delta: keep the prefix, replace everything from `fromIndex`. */
export function applyDelta(
  prev: ThreadItem[],
  delta: { fromIndex: number; items: ThreadItem[]; length: number },
): ThreadItem[] {
  const head = prev.slice(0, Math.max(0, delta.fromIndex));
  const next = [...head, ...delta.items];
  // `length` is authoritative, so a thread that shrank truncates rather
  // than keeping orphaned items from the previous build.
  return next.length > delta.length ? next.slice(0, delta.length) : next;
}

/**
 * True when a delta cannot be applied to what the client actually holds.
 *
 * `applyDelta` splices at `fromIndex`, which is only meaningful if the
 * client's list is at least that long. When it is shorter there is a hole
 * between the end of what is on screen and the start of what arrived, and
 * splicing anyway silently welds the two together -- the visible result is
 * a step appearing twice, or in the wrong place, or a card from the middle
 * of the turn stacked on top of the newest one. That is the class of UI
 * glitch that showed up after a dropped connection, and it is unfixable
 * from the delta alone: the missing items simply are not in it. The only
 * correct response is to ask for the thread again.
 */
export function deltaHasGap(
  prev: ThreadItem[],
  delta: { fromIndex: number },
): boolean {
  return delta.fromIndex > prev.length;
}

/** True once the transcript carries the message the echo was standing in for. */
export function pendingIsEchoed(
  items: ThreadItem[],
  pending: PendingMessage,
): boolean {
  const needle = pending.text.trim();
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item.kind !== 'user') continue;
    const text = item.text.trim();
    // The server prepends an attachment header to the prompt, so the
    // transcript's copy CONTAINS the typed text rather than equalling it.
    if (text === needle || (needle && text.endsWith(needle))) return true;
    // Only the newest user bubble can be the echo; anything older is a
    // previous turn, and scanning past it would match a repeated message.
    return false;
  }
  return false;
}

const NO_STATS: ThreadStats = {
  totalTokens: 0,
  turnTokens: 0,
  turnStartedAt: null,
};

/** Index a subagent-steps list by child id, for O(1) lookup while rendering. */
function byChildId(list: ChildSteps[]): Record<string, ChildSteps> {
  return Object.fromEntries(list.map((entry) => [entry.childId, entry]));
}

export function useThread(sessionId: string): ThreadState {
  const [meta, setMeta] = useState<ThreadResponse | null>(null);
  const [items, setItems] = useState<ThreadItem[]>([]);
  const [stats, setStats] = useState<ThreadStats>(NO_STATS);
  const [sources, setSources] = useState<Record<string, CitationSource>>({});
  const [subagentSteps, setSubagentSteps] = useState<Record<string, ChildSteps>>(
    {},
  );
  const [streamText, setStreamText] = useState('');
  /**
   * Streamed text commits at most once per frame.
   *
   * `stream_delta` events arrive per socket message -- several per frame on
   * a fast turn -- and each one used to commit state synchronously. Every
   * commit re-renders the thread and re-parses the whole growing answer
   * through react-markdown, so a burst of messages in one frame paid the
   * parse once per message and only painted the last one. The buffer below
   * collects the frame's worth and commits it once, on rAF. Clearing (a new
   * turn, a delta covering the stream) still commits synchronously: there
   * is nothing to coalesce with, and the stale text must be gone now.
   */
  const streamBuf = useRef('');
  const streamRaf = useRef(0);
  const clearStream = useCallback(() => {
    streamBuf.current = '';
    if (streamRaf.current) {
      cancelAnimationFrame(streamRaf.current);
      streamRaf.current = 0;
    }
    setStreamText('');
  }, []);
  const appendStream = useCallback((text: string) => {
    streamBuf.current += text;
    if (streamRaf.current || typeof requestAnimationFrame === 'undefined') {
      // A flush is already scheduled for this frame -- or there is no frame
      // scheduler at all (tests), in which case commit synchronously.
      if (typeof requestAnimationFrame === 'undefined') {
        setStreamText(streamBuf.current);
      }
      return;
    }
    streamRaf.current = requestAnimationFrame(() => {
      streamRaf.current = 0;
      setStreamText(streamBuf.current);
    });
  }, []);
  const [activity, setActivity] = useState<ThreadState['activity']>(null);
  /**
   * Failed load attempts for the thread currently on screen.
   *
   * A brand-new chat can be asked for before its transcript exists on disk:
   * the server creates the session, answers `newSession` with an id, and
   * writes the file a moment later. The phone navigates on the id and can
   * lose that race, which used to be terminal -- one `session_not_found`
   * and the person who had just tapped send was told the chat they were
   * looking at did not exist, permanently, with no retry anywhere.
   */
  const loadAttempts = useRef<{ id: string; n: number; timer?: number }>({ id: '', n: 0 });
  const [pending, setPending] = useState<PendingMessage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  /**
   * When the socket last came back after a drop, or 0 if it never has.
   *
   * The footer already says "Reconnecting…" while down (via
   * `activityPhase`); what was missing is the recovery beat -- the
   * uimaxx-terminal "[shell reconnected]" line. ThreadScreen watches this
   * and toasts once per reconnect. A timestamp rather than a boolean so
   * the effect can key on it and repeated drops each announce.
   */
  const [reconnectedAt, setReconnectedAt] = useState(0);
  const [alerts, setAlerts] = useState<ErrorAlert[]>([]);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [stopping, setStopping] = useState(false);
  /**
   * Busy, as the socket reports it.
   *
   * The REST payload's `busy` is a snapshot from load time, so relying on
   * it alone leaves the bottom bar's spinner stuck on whatever the state
   * was when the thread opened. `null` means "the socket has not said",
   * and the REST value stands.
   */
  const [liveBusy, setLiveBusy] = useState<boolean | null>(null);
  const [liveStoppable, setLiveStoppable] = useState<boolean | null>(null);

  const alive = useRef(true);
  const socket = useRef<TranscriptSocket | null>(null);
  const latestSessionState = useRef<SessionStateEvent | null>(null);
  /**
   * A mirror of `items` that is readable synchronously.
   *
   * Needed because deciding whether a delta is applicable is a side effect
   * (it may ask for a resync), and side effects do not belong inside a
   * state updater.
   */
  const itemsRef = useRef<ThreadItem[]>([]);
  const transcriptRevision = useRef(0);
  const loadSequence = useRef(0);
  /** Rate limit on gap-triggered resyncs, so a bad delta cannot loop. */
  const lastResync = useRef(0);
  /**
   * False until the socket has been open once for this session.
   *
   * Distinguishes the opening connection (whose REST load has just run)
   * from a reconnect (which must refetch the metadata it may have missed).
   */
  const connectedOnce = useRef(false);

  const putItems = useCallback((next: ThreadItem[]) => {
    transcriptRevision.current += 1;
    itemsRef.current = next;
    setItems(next);
  }, []);

  const load = useCallback(async () => {
    const revision = transcriptRevision.current;
    const sequence = ++loadSequence.current;
    // A different chat starts its retry budget over.
    if (loadAttempts.current.id !== sessionId) loadAttempts.current = { id: sessionId, n: 0 };
    /*
     * The cached copy of this thread, if this device has one. Painted
     * below the moment it is read, before the network answers, so an
     * open is instant and still works with the computer off; its `rev`
     * also arms the conditional fetch underneath.
     */
    let cached: Awaited<ReturnType<typeof readThreadCache>> = null;
    try {
      cached = await readThreadCache(sessionId);
    } catch {
      cached = null;
    }
    if (
      alive.current &&
      sequence === loadSequence.current &&
      cached &&
      itemsRef.current.length === 0 &&
      revision === transcriptRevision.current
    ) {
      // First paint: the last full answer this device saw. Superseded
      // silently if the socket or a later load has already moved on.
      setMeta(
        latestSessionState.current
          ? applySessionState(cached.response, latestSessionState.current)
          : cached.response,
      );
      itemsRef.current = cached.response.items;
      setItems(cached.response.items);
      setStats(cached.response.stats);
      setSources(cached.response.sources);
      setSubagentSteps(byChildId(cached.response.subagentSteps));
      setTodos(cached.response.todos ?? []);
      setLoading(false);
    }
    try {
      const next = await api.thread(sessionId, cached?.response?.rev ?? undefined);
      if (!alive.current || sequence !== loadSequence.current) return;
      if (next.unchanged) {
        // The cache WAS the answer. Nothing to paint, nothing to store.
        return;
      }
      // Only meaningful before the socket's first subscribe; ignored after.
      if (revision === transcriptRevision.current) socket.current?.setRev(next.rev);
      setMeta(
        latestSessionState.current
          ? applySessionState(next, latestSessionState.current)
          : next,
      );
      if (revision === transcriptRevision.current) {
        itemsRef.current = next.items;
        setItems(next.items);
      }
      setStats(next.stats);
      setSources(next.sources);
      setSubagentSteps(byChildId(next.subagentSteps));
      setTodos(next.todos ?? []);
      setError(null);
      void writeThreadCache(sessionId, next);
    } catch (err) {
      if (!alive.current) return;
      // With something already painted (the cache above, or socket
      // deltas), a failed refresh keeps the thread readable rather than
      // blanking it for a banner. The error matters only on an empty view.
      if (itemsRef.current.length > 0) return;
      /*
       * An empty view that failed to load is usually the cold-start race
       * described above, not a chat that is gone. Retry with backoff and
       * only report once those are spent: a genuinely deleted chat still
       * says so, a few seconds later, and a chat that is merely young says
       * nothing at all.
       */
      if (loadAttempts.current.id !== sessionId) loadAttempts.current = { id: sessionId, n: 0 };
      loadAttempts.current.n += 1;
      if (loadAttempts.current.n <= LOAD_RETRIES) {
        // Not guarded on `sequence`: the retry starts a fresh load, which
        // supersedes on its own by bumping loadSequence. Guarding on it here
        // would disqualify every retry by construction.
        // 400ms, 800ms, 1s, 1s. Long enough to outlast the race, short enough
        // that a chat which really is gone says so before the person has
        // stopped looking at the screen.
        const wait = Math.min(400 * loadAttempts.current.n, 1_000);
        loadAttempts.current.timer = window.setTimeout(() => {
          if (alive.current && loadAttempts.current.id === sessionId) void load();
        }, wait);
        return;
      }
      setError(threadErrorText(err));
    } finally {
      // Only the newest load may end the loading state. A superseded one
      // (a re-run effect, or a reconnect refetch racing the first load)
      // used to clear it early: the skeleton vanished and the screen sat
      // blank until the real answer landed.
      if (alive.current && sequence === loadSequence.current) setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    alive.current = true;
    setLoading(true);
    setAlerts([]);
    itemsRef.current = [];
    lastResync.current = 0;
    connectedOnce.current = false;
    setItems([]);
    setStats(NO_STATS);
    setSources({});
    setSubagentSteps({});
    setTodos([]);
    clearStream();
    setActivity(null);
    setPending(null);
    setLiveBusy(null);
    setLiveStoppable(null);
    latestSessionState.current = null;
    setStopping(false);
    const firstLoad = load();

    const ws = new TranscriptSocket(
      sessionId,
      (event) => {
        if (event.type === 'thread_delta') {
          if (deltaHasGap(itemsRef.current, event)) {
            // Do not paint a thread that is known to be wrong. Ask for the
            // whole thing instead; at worst this costs one extra frame.
            const now = Date.now();
            if (now - lastResync.current > 2_000) {
              lastResync.current = now;
              socket.current?.resync();
            }
            return;
          }
          putItems(applyDelta(itemsRef.current, event));
          // The transcript now carries whatever was being streamed, so the
          // provisional buffer has served its purpose.
          clearStream();
          return;
        }
        if (event.type === 'thread_meta') {
          setStats(event.stats);
          setSources(event.sources);
          if (event.todos) setTodos(event.todos);
          if (event.subagents) setMeta(prev => prev ? { ...prev, subagents: event.subagents! } : prev);
          return;
        }
        if (event.type === 'subagent_delta') {
          const { childId, steps, total } = event;
          setSubagentSteps((prev) => ({
            ...prev,
            [childId]: { childId, steps, total },
          }));
          return;
        }
        if (event.type === 'activity') {
          setActivity(event.activity);
          return;
        }
        if (event.type === 'stream_delta') {
          appendStream(event.text);
          return;
        }
        if (event.type === 'subscribed') {
          setLiveBusy(event.busy);
          return;
        }
        if (event.type === 'session_state') {
          latestSessionState.current = event;
          setLiveBusy(event.busy);
          if (!event.busy || event.suspended) setActivity(null);
          setLiveStoppable(event.stoppable);
          setMeta((prev) => (prev ? applySessionState(prev, event) : prev));
          return;
        }
        if (event.type === 'turn_started') {
          setActivity(null);
          setLiveBusy(true);
          clearStream();
          setStopping(false);
          // A new turn's failures are its own; last turn's card would
          // otherwise sit above a run that is going fine.
          setAlerts([]);
          return;
        }
        if (event.type === 'turn_finished') {
          setActivity(null);
          // A stopped or suspended turn is not a failure. Reporting a
          // SIGTERM exit as an error would put a red card on the user's own
          // deliberate tap, and a suspended session already has its
          // question card.
          if (event.alert && !event.stopped && !event.suspended) {
            setAlerts((prev) => [...prev, event.alert!]);
            haptic('error');
          } else if (!event.stopped) {
            haptic('success');
            playSound('receive');
          }
          setLiveBusy(false);
          clearStream();
          setStopping(false);
          // Metadata the socket does not carry (title, permission, model,
          // and the suspended flag the composer keys off).
          void load();
        }
      },
      (isConnected) => {
        setConnected(isConnected);
        if (!isConnected) setActivity(null);
        // The socket's own `subscribe` now carries `full` on every
        // reconnect, so the thread itself resyncs without being asked.
        // What it does NOT carry is the metadata that only the REST payload
        // has -- title, permission, model, the suspended flag the composer
        // keys off -- so that is refetched here instead. Skipped on the
        // first connect, where the REST load has just run anyway.
        if (isConnected && connectedOnce.current) {
          void load();
          setReconnectedAt(Date.now());
        }
        if (isConnected) connectedOnce.current = true;
      },
    );
    socket.current = ws;
    /*
     * Connect once the REST load lands, so the first subscribe can name
     * the snapshot it returned (see TranscriptSocket.setRev) -- or after
     * a short ceiling, so a slow or failing load never holds live updates
     * back. Connecting without a rev asks for the whole thread, which is
     * always correct.
     */
    let connectStarted = false;
    let disposed = false;
    const startSocket = () => {
      // `alive` is shared by every run of this effect, so it reads true
      // again once the next run starts. `disposed` belongs to this run: a
      // load landing after cleanup must not reopen the closed socket, which
      // would stream a stale snapshot into the screen.
      if (connectStarted || disposed || !alive.current) return;
      connectStarted = true;
      window.clearTimeout(connectCeiling);
      ws.connect();
    };
    const connectCeiling = window.setTimeout(startSocket, FIRST_CONNECT_CEILING_MS);
    void firstLoad.finally(startSocket);

    return () => {
      disposed = true;
      alive.current = false;
      window.clearTimeout(connectCeiling);
      // A retry that was already queued must not fire into a dead view.
      if (loadAttempts.current.timer !== undefined) window.clearTimeout(loadAttempts.current.timer);
      ws.close();
      socket.current = null;
      if (streamRaf.current) {
        cancelAnimationFrame(streamRaf.current);
        streamRaf.current = 0;
      }
      streamBuf.current = '';
    };
  }, [sessionId, load, clearStream, appendStream]);

  // Retire the optimistic bubble once the real one arrives -- or after a
  // couple of minutes, so a failed send does not leave a ghost forever.
  useEffect(() => {
    if (!pending) return undefined;
    if (pendingIsEchoed(items, pending)) {
      setPending(null);
      return undefined;
    }
    const timer = window.setTimeout(
      () => setPending(null),
      Math.max(0, pending.at + PENDING_TTL_MS - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [items, pending]);

  const busyNow = liveBusy ?? meta?.busy ?? false;
  useEffect(() => {
    if (connected || !busyNow || loading) return undefined;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, OFFLINE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [connected, busyNow, loading, load]);

  const visible = useMemo(() => {
    const out = [...items];
    if (pending) {
      const echo: UserItem = {
        kind: 'user',
        id: `pending-${pending.at}`,
        text: pending.text,
        ts: pending.at,
        pending: true,
      };
      if (pending.attachments.length) echo.attachments = pending.attachments;
      out.push(echo);
    }
    const streaming = streamText.trim();
    if (streaming) {
      out.push({ kind: 'streaming', id: 'streaming', text: streaming });
    }
    return out;
  }, [items, pending, streamText]);

  return {
    items: visible,
    title: meta?.title ?? '',
    busy: liveBusy ?? meta?.busy ?? false,
    stoppable: liveStoppable ?? meta?.stoppable ?? false,
    queued: meta?.queued ?? 0,
    permission: meta?.permission ?? null,
    permissionMode: meta?.permissionMode ?? null,
    finalConfirm: meta?.finalConfirm ?? null,
    softConfirm: meta?.softConfirm ?? false,
    model: meta?.model ?? null,
    stats,
    contextWindow: meta?.contextWindow ?? 0,
    sources,
    subagents: meta?.subagents ?? [],
    subagentSteps,
    parentId: meta?.parentId ?? null,
    todos,
    suspended: meta?.suspended ?? false,
    hasRecoverableQuestion: hasPendingNativeQuestion(items),
    streamingChars: streamText.length,
    activity,
    loading,
    error,
    connected,
    reconnectedAt,
    alerts,
    stopping,
    stop: async () => {
      setStopping(true);
      try {
        await api.stop(sessionId);
        // Desktop-owned turns do not emit this server's `turn_finished`, so
        // clear the control immediately after the CLI acknowledges abort.
        setLiveBusy(false);
        setLiveStoppable(false);
      } catch {
        // A 409 means the turn had already ended, which is still the state
        // the tap requested. A later socket state can re-enable it if work
        // genuinely continues.
      } finally {
        setStopping(false);
      }
    },
    refresh: load,
    dismissAlerts: () => setAlerts([]),
    addPending: (message) => setPending(message),
    clearPending: () => setPending(null),
    applyPermission: (next) =>
      setMeta((prev) => (prev ? { ...prev, ...next } : prev)),
    muted: meta?.muted ?? false,
    setMuted: (next) =>
      setMeta((prev) => (prev ? { ...prev, muted: next } : prev)),
  };
}
