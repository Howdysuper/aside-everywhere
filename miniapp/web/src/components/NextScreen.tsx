/**
 * Next: your plan, on your phone.
 *
 * Four areas behind a floating tab bar (Apple's tab bar guidance and
 * Linear's glass bar: icon and label always, one detached + for the main
 * action). Nothing in here starts work on its own. Every helper begins
 * from a button you tap, and says first what it will and won't do.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { BellRing, FolderOpen, ListChecks, Search as SearchIcon, ShieldCheck, RefreshCw } from 'lucide-react';
import { deepLinkItem, deepLinkNav } from '../deeplink';
import { api } from '../api';
import { useBackStack } from '../utils/backStack';
import { navigate } from '../utils/navTransition';
import { haptic } from '../telegram';
import { ChevronLeft, Plus, Spinner } from './Icons';
import { ToastHost, toast } from './Toasts';
import { DraftSheet } from './NextParts';
import { TodayView, HomeworkView } from './NextToday';
import { ItemSheet, laterChoices } from './NextItemSheet';
import { ResearchView, ReportSheet } from './NextResearch';
import { ProjectDetail, ProjectsList, NewProjectSheet } from './NextProjects';
import { ActivityTab } from './NextActivity';
import { FocusMode, QuickAddSheet } from './NextFocus';
import { openUrl } from '../utils/openUrl';
import { filterSchoolPlan, scopePlan, spaceSummary, useSpace } from '../utils/nextSpace';
import { ViewMenu, SpaceSwitch, type NextView } from './NextSpace';
import { NextBoundary } from './NextBoundary';
import { useLivePlan } from '../hooks/useLivePlan';
import { enablePush, pushSupported, resubscribe } from '../push';
import type { NextAction, NextItem, NextPlan, NextProject, NextSpace, ResearchBrief, SessionRow } from '../types';
import type { SpaceSummary } from '../utils/nextSpace';

type Tab = 'today' | 'projects' | 'research' | 'activity';
const TABS: Array<{ id: Tab; label: string; Icon: typeof ListChecks }> = [
  { id: 'today', label: 'To Do', Icon: ListChecks },
  { id: 'projects', label: 'Projects', Icon: FolderOpen },
  { id: 'research', label: 'Research', Icon: SearchIcon },
  { id: 'activity', label: 'Activity', Icon: ShieldCheck },
];

function errText(e: unknown, fallback: string): string {
  const m = String((e as Error)?.message ?? '');
  if (m.includes('423') || m.includes('paused')) return 'Next is paused. Turn it back on in Activity.';
  if (m.includes('429')) return 'That is a lot of starts this hour. Try again later.';
  if (m.includes('409')) return 'That is already going.';
  return fallback;
}

export function NextScreen({
  onClose,
  onOpenThread,
  onSessionsChanged,
}: {
  sessions: SessionRow[];
  onClose: () => void;
  onOpenThread: (sessionId: string) => void;
  onSessionsChanged: () => void;
}) {
  const { plan, setPlan, load, state: liveState, savedAt, error } = useLivePlan();
  const [tab, setTab] = useState<Tab>('today');
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projects, setProjects] = useState<NextProject[] | null>(null);
  const [itemId, setItemId] = useState<string | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [report, setReport] = useState<ResearchBrief | null>(null);
  const [quickAdd, setQuickAdd] = useState(false);
  const [newProject, setNewProject] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [checking, setChecking] = useState(false);
  const [paused, setPaused] = useState(false);
  const [researchKey, setResearchKey] = useState(0);
  const [scrolled, setScrolled] = useState(false);
  const [space, setSpaceRaw] = useSpace();
  // Reminders: ask on open, no button hunt. iOS is the exception: Apple
  // requires the permission ask inside a real tap, and an automatic ask
  // comes back "denied" permanently — so there the banner stays.
  const [pushAsk, setPushAsk] = useState(false);
  useEffect(() => {
    if (!pushSupported()) return;
    if (Notification.permission === 'granted') {
      // Already allowed: repair any subscription the server lost, silently.
      void resubscribe();
      return;
    }
    if (Notification.permission === 'denied') return;
    const ios =
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (ios) {
      const later = Number(localStorage.getItem('aside.push.later') || 0);
      if (later && Date.now() - later < 7 * 86_400_000) return;
      setPushAsk(true);
      return;
    }
    // Android/desktop: the prompt appears on its own when the app opens.
    void enablePush().then((r) => {
      if (r === 'granted') toast('Reminders are on');
    });
  }, []);
  // Inside the school space, the To Do screen splits into Homework and
  // School; the chosen one sticks across visits.
  const [schoolView, setSchoolViewRaw] = useState<'homework' | 'school'>(() =>
    localStorage.getItem('aside.next.school-view') === 'school' ? 'school' : 'homework',
  );
  const setSchoolView = (v: 'homework' | 'school') => {
    setSchoolViewRaw(v);
    try {
      localStorage.setItem('aside.next.school-view', v);
    } catch {
      /* private mode: still works for this visit */
    }
  };
  const view: NextView = space === 'personal' ? 'personal' : schoolView;  const setView = (v: NextView) => {
    haptic('light');
    setSwitched(true);
    if (v === 'personal') setSpaceRaw('personal');
    else {
      setSpaceRaw('school');
      if (v !== schoolView) setSchoolView(v);
    }
    setScrolled(false);
    scroller.current?.scrollTo({ top: 0 });
  };
  const showSpace = (s: NextSpace) => {
    if (s === 'personal') setSpaceRaw('personal');
    else {
      setSpaceRaw('school');
      if (schoolView !== 'school') setSchoolView('school');
    }
  };
  // The Projects tab only has two homes (school / personal); switching it
  // must not drag the To Do screen's Homework / School choice along.
  const setProjectSpace = (s: NextSpace) => {
    haptic('light');
    setSwitched(true);
    setSpaceRaw(s);
    setScrolled(false);
    scroller.current?.scrollTo({ top: 0 });
  };
  const [switched, setSwitched] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const lastY = useRef(0);
  const scrollPositions = useRef(new Map<string, number>());
  const scrollKey = tab + ':' + (projectId ?? '') + ':' + view;
  const currentScrollKey = useRef(scrollKey);
  useLayoutEffect(() => {
    currentScrollKey.current = scrollKey;
    const y = scrollPositions.current.get(scrollKey) ?? 0;
    if (scroller.current) scroller.current.scrollTop = y;
    lastY.current = y;
    setScrolled(y > 44);
  }, [scrollKey]);
  useBackStack([
    ...(tab !== 'today' ? [{ key: 'next-tab', back: () => { setTab('today'); setProjectId(null); setScrolled(false); } }] : []),
    ...(projectId ? [{ key: 'next-project', back: () => navigate('pop', () => { setProjectId(null); setScrolled(false); }) }] : []),
  ], 20);

  useEffect(() => {
    if (plan) setPaused(Boolean(plan.control?.paused));
  }, [plan]);

  const loadProjects = useCallback(async () => {
    try {
      setProjects((await api.nextProjects()).projects);
    } catch {
      setProjects((p) => p ?? []);
    }
  }, []);

  useEffect(() => {
    if (tab === 'projects' && !projectId) void loadProjects();
  }, [tab, projectId, loadProjects]);

  // The tab bar tucks away while scrolling down and comes back on the way
  // up (iOS 26 tab bar minimize behaviour).
  const onScroll = () => {
    const y = scroller.current?.scrollTop ?? 0;
    scrollPositions.current.set(currentScrollKey.current, y);
    // Past the big title, its name moves into the top bar (iOS large title).
    setScrolled(y > 44);
    lastY.current = y;
  };

  const all: NextItem[] = plan ? ([plan.now, ...plan.next, ...plan.later, ...plan.unsure, ...plan.withAside, ...(plan.review ?? [])].filter(Boolean) as NextItem[]) : [];
  const schoolScoped = plan ? scopePlan(plan, 'school') : null;
  const hwPlan = schoolScoped ? filterSchoolPlan(schoolScoped, 'homework') : null;
  const scPlan = schoolScoped ? filterSchoolPlan(schoolScoped, 'school') : null;
  // Homework and School are the same server space seen two ways, so each
  // pill counts its own slice only.
  const summaryOf = (p: NextPlan | null): SpaceSummary | undefined => {
    if (!p) return undefined;
    const items = [p.now, ...p.next, ...p.later].filter(Boolean) as NextItem[];
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);
    return { count: items.length, urgent: items.some((it) => it.dueISO && Date.parse(it.dueISO) <= endOfDay.getTime()) };
  };
  const summary = plan
    ? { homework: summaryOf(hwPlan), school: summaryOf(scPlan), personal: spaceSummary(plan, 'personal') }
    : undefined;
  const projectSummary = plan
    ? { school: spaceSummary(plan, 'school'), personal: spaceSummary(plan, 'personal') }
    : undefined;
  const scoped = plan
    ? space === 'personal'
      ? scopePlan(plan, 'personal')
      : filterSchoolPlan(scopePlan(plan, 'school'), schoolView)
    : null;
  const moveTask = async (it: NextItem, to: NextSpace) => {
    try {
      setPlan(await api.nextMoveTask(it.id.replace(/^manual:/, ''), to));
      setItemId(null);
      toast(`Moved to ${to === 'school' ? 'School' : 'Personal'}`, { action: { label: 'Show', onClick: () => showSpace(to) } });
    } catch {
      toast('Could not move it. Try again.', { tone: 'error' });
    }
  };
  const spaced = tab === 'today' || (tab === 'projects' && !projectId);
  const item = itemId ? all.find((it) => it.id === itemId) ?? null : null;
  const draftItem = draftId ? all.find((it) => it.id === draftId) ?? null : null;
  const focusItem = focusId ? all.find((it) => it.id === focusId) ?? null : null;

  // A reminder notification's tap: App.tsx catches the URL (query string on
  // cold start, cached or messaged on iOS resume), opens this screen, and
  // hands the item id over via the shared store. Open that exact item's
  // sheet as soon as the plan knows it, then consume it.
  useEffect(() => {
    const tryOpen = (id: string | null) => {
      if (!id || itemId) return;
      const hit = all.find((it) => it.id === id);
      if (!hit) return;
      setItemId(hit.id);
      deepLinkItem.set(null);
    };
    tryOpen(deepLinkItem.get());
    return deepLinkItem.subscribe(tryOpen);
  }, [all, itemId]);

  // A research-result push taps into /app?tab=research: land on the
  // Research tab, not the To Do default. Consumed on arrival.
  useEffect(() => {
    const tryNav = (v: { thread: string | null; tab: string | null }) => {
      if (v.tab === 'research') {
        setTab('research');
        deepLinkNav.set({ thread: null, tab: null });
      }
    };
    tryNav(deepLinkNav.get());
    return deepLinkNav.subscribe(tryNav);
  }, []);

  const act = async (it: NextItem, action: NextAction, message?: string, undo?: boolean) => {
    try {
      setPlan(await api.nextAction(it.id, action));
      if (message) toast(message, undo ? { action: { label: 'Undo', onClick: () => void act(it, { type: 'reopen' }) } } : {});
    } catch {
      toast('That did not save. Try again.', { tone: 'error' });
    }
  };

  const dismiss = (it: NextItem) => {
    haptic('light');
    setItemId(null);
    void act(it, { type: 'dismiss' }, it.source === 'manual' ? 'Task removed' : it.source === 'project' ? 'Step skipped' : 'Removed from your list', true);
  };

  const done = (it: NextItem) => {
    haptic('success');
    setItemId(null);
    void act(it, { type: 'done' }, `Done: ${it.title}`, true);
  };

  const later = (it: NextItem, until?: Date, label = 'tomorrow') => {
    const d = until ?? laterChoices(new Date()).find((c) => c.label === 'Tomorrow')!.until;
    haptic('light');
    setItemId(null);
    void act(it, { type: 'snooze', until: d.toISOString() }, `Back ${label.toLowerCase()}`, true);
  };

  /** He tapped for help. Next works on it now or as soon as one is ready. */
  const help = async (it: NextItem) => {
    setBusy('help');
    try {
      const res = await api.nextStartWhenReady(it.id);
      setPlan(res.plan);
      onSessionsChanged();
      if (res.sessionId) {
        haptic('success');
        setItemId(null);
        toast('Next is working on it. It stops before submitting anything.', {
          action: { label: 'Watch', onClick: () => onOpenThread(res.sessionId!) },
        });
      } else {
        toast(`Noted. Next is getting ready${res.readyInMin ? `, about ${res.readyInMin} min` : ''}. You can cancel until it starts.`);
      }
    } catch (e) {
      toast(errText(e, 'Could not start it. Try again.'), { tone: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const cancelHelp = async (it: NextItem) => {
    try {
      setPlan(await api.nextCancelStart(it.id));
      toast('Cancelled. Nothing started.');
    } catch {
      toast('Could not cancel. Try again.', { tone: 'error' });
    }
  };

  const research = async (it: NextItem) => {
    setBusy('research');
    try {
      await api.researchStart({ itemId: it.id });
      await load();
      setResearchKey((k) => k + 1);
      toast('Next will look into it. The answer shows up in Research.');
    } catch (e) {
      toast(errText(e, 'Could not start that. Try again.'), { tone: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const openResearch = async (id: string) => {
    try {
      setItemId(null);
      setReport(await api.researchGet(id));
    } catch {
      toast('Could not open that answer.', { tone: 'error' });
    }
  };

  const checkMail = async () => {
    setChecking(true);
    const what = space === 'school' ? 'school email' : 'Gmail';
    try {
      const res = space === 'school' ? await api.nextRefresh() : await api.nextPersonalRefresh();
      setPlan(res.plan);
      toast(res.result.ok ? `${what.charAt(0).toUpperCase() + what.slice(1)} checked.` : `Could not read ${what} right now.`, res.result.ok ? {} : { tone: 'error' });
    } catch (e) {
      toast(errText(e, `Could not check ${what}.`), { tone: 'error' });
    } finally {
      setChecking(false);
    }
  };

  const goTab = (t: Tab) => {
    if (t === tab && !projectId) {
      scroller.current?.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    haptic('light');
    setTab(t);
    setProjectId(null);
    setScrolled(false);
    if (t === 'today') void load();
  };

  const openProject = (id: string) => {
    haptic('light');
    setTab('projects');
    navigate('push', () => setProjectId(id));
    setScrolled(false);
  };

  const plus = () => {
    haptic('light');
    if (tab === 'today') setQuickAdd(true);
    else if (tab === 'projects') setNewProject(true);
    else if (tab === 'research') document.getElementById('n3-ask-input')?.focus();
  };

  const mailSource = scoped?.sources.find((s) => s.id === 'school-mail' || s.id === 'personal-mail') ?? null;

  return (
    <div className="app next-screen n3" data-destination="next">
      <header className={`n3-top${scrolled ? ' is-scrolled' : ''}${spaced ? ' has-switch' : ''}`}>
        <button
          type="button"
          className="n3-back"
          onClick={() => (projectId ? navigate('pop', () => { setProjectId(null); setScrolled(false); void loadProjects(); }) : onClose())}
          aria-label={projectId ? 'Back to projects' : 'Back to Aside'}
        >
          <ChevronLeft size={22} strokeWidth={1.75} />
          <span>{projectId ? 'Projects' : 'Aside'}</span>
        </button>
        {spaced ? (
          tab === 'today' ? (
            <ViewMenu view={view} onViewChange={setView} summary={summary} />
          ) : (
            <SpaceSwitch space={space} onChange={setProjectSpace} summary={projectSummary} />
          )
        ) : (
          <span className="n3-top-title" aria-hidden={!scrolled || !!projectId}>
            {projectId ? '' : TABS.find((t) => t.id === tab)?.label}
          </span>
        )}
        {paused ? (
          <button type="button" className="n3-paused-chip" onClick={() => goTab('activity')}>
            <span aria-hidden />
            Paused
          </button>
        ) : (
          <button type="button" className={`n3-refresh${refreshing ? ' is-refreshing' : ''}`} aria-label={refreshing ? 'Refreshing your plan' : 'Refresh your plan'} onClick={async () => { setRefreshing(true); try { await load(); } finally { setRefreshing(false); } }} disabled={refreshing}><RefreshCw size={19} aria-hidden /></button>
        )}
      </header>
      <ToastHost />

      <main className="n3-scroll has-wash" ref={scroller} onScroll={onScroll}>
        {spaced ? <div className="sp-wash" data-space={space} aria-hidden /> : null}
        {liveState === 'offline' && plan ? (
          <button type="button" className="n3-offline" onClick={() => void load()}>
            <span className="n3-offline-dot" aria-hidden />
            <span>
              Can't reach your computer. Showing your list from {savedAt ? new Date(savedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'earlier'}. Retrying.
            </span>
          </button>
        ) : null}
        {tab === 'today' && pushAsk ? (
          <div className="n3-push" role="group" aria-label="Turn on reminders">
            <span className="n3-push-glyph" aria-hidden>
              <BellRing size={18} strokeWidth={2} />
            </span>
            <span className="n3-push-text">
              <strong>Reminders on your phone</strong>
              <span>Aside pings you when something is due soon, and when new things land on your list.</span>
            </span>
            <span className="n3-push-actions">
              <button
                type="button"
                className="n3-push-btn"
                onClick={() => {
                  haptic('light');
                  void enablePush().then((r) => {
                    setPushAsk(false);
                    if (r === 'granted') {
                      toast('Reminders are on');
                      void api.pushTest().catch(() => {});
                    } else if (r === 'denied') {
                      toast('Notifications are off in this browser\u2019s settings.', { tone: 'error' });
                    } else {
                      toast('Could not turn on reminders. Try again later.', { tone: 'error' });
                    }
                  });
                }}
              >
                Turn on
              </button>
              <button
                type="button"
                className="n3-push-later"
                onClick={() => {
                  haptic('light');
                  localStorage.setItem('aside.push.later', String(Date.now()));
                  setPushAsk(false);
                }}
              >
                Not now
              </button>
            </span>
          </div>
        ) : null}
        <NextBoundary resetKey={`${tab}:${view}:${projectId ?? ''}`} label={tab === 'today' ? 'To Do' : tab === 'projects' ? 'Projects' : tab === 'research' ? 'Research' : 'Activity'}>
        {tab === 'today' ? (
          scoped ? (
            <div key={view} className={switched ? `sp-enter-${view === 'personal' ? 'personal' : 'school'}` : undefined}>
            {view === 'homework' ? (
              <HomeworkView
                plan={scoped}
                onOpenItem={(it) => setItemId(it.id)}
                onDone={done}
                onLater={(it) => later(it)}
                onOpenUrl={(u) => void openUrl(u)}
              />
            ) : (
              <TodayView
                space={space}
                plan={scoped}
                onOpenItem={(it) => setItemId(it.id)}
                onAdd={plus}
                onDone={done}
                onLater={(it) => later(it)}
                onFocus={(it) => setFocusId(it.id)}
                onOpenUrl={(u) => void openUrl(u)}
                onOpenProject={openProject}
                onOpenThread={onOpenThread}
                onClearNotice={(n) => void api.nextAction(n.id, { type: 'dismiss' }).then(setPlan)}
                onKeep={(it) => void act(it, { type: 'keep' }, 'Kept on your list')}
                onSkip={dismiss}
                onCheckMail={mailSource && !paused ? () => void checkMail() : null}
                checking={checking}
              />
            )}
            </div>
          ) : (
            <div className="n3-loading">{error ?? <Spinner size={16} />}</div>
          )
        ) : tab === 'projects' ? (
          projectId ? (
            <ProjectDetail
              id={projectId}
              onGone={() => {
                setProjectId(null);
                void loadProjects();
              }}
            />
          ) : (
            <div key={space} className={switched ? `sp-enter-${space}` : undefined}>
              <ProjectsList projects={projects} space={space} onOpen={openProject} onNew={() => setNewProject(true)} />
            </div>
          )
        ) : tab === 'research' ? (
          <ResearchView
            onOpen={(b) => setReport(b)}
            refreshKey={researchKey}
            suggestions={all
              .filter((it) => it.brief.research && !it.research && !it.flag)
              .map((it) => (it.kind === 'opportunity' ? `Is "${it.title}" worth it, and am I eligible?` : `What do I need to know for "${it.title}"?`))}
          />
        ) : (
          <ActivityTab onPausedChange={setPaused} />
        )}
        </NextBoundary>
      </main>

      <nav className="n3-tabbar" aria-label="Next">
        <div className="n3-tabs" role="tablist">
          <span className="n3-tabs-pill" aria-hidden style={{ transform: `translateX(${Math.max(0, TABS.findIndex((t) => t.id === tab)) * 100}%)` }} />
          {TABS.map(({ id, label, Icon }) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'is-on' : ''} onClick={() => goTab(id)}>
              <span className="n3-tab-icon">
                <Icon size={21} strokeWidth={tab === id ? 2 : 1.6} aria-hidden />
                {id === 'activity' && paused ? <span className="n3-tab-dot" aria-label="paused" /> : null}
              </span>
              <span className="n3-tab-label">{label}</span>
            </button>
          ))}
        </div>
        {tab !== 'activity' && !projectId ? (
          <button type="button" className="n3-plus" onClick={plus} aria-label={tab === 'today' ? 'Add a task' : tab === 'projects' ? 'New project' : 'Ask a question'}>
            <Plus size={21} strokeWidth={2} /><span className="n3-add-label">{tab === 'projects' ? 'New' : tab === 'research' ? 'Ask' : 'Add'}</span>
          </button>
        ) : null}
      </nav>

      {item ? (
        <ItemSheet
          item={item}
          busy={busy}
          onClose={() => setItemId(null)}
          onOpenUrl={(u) => void openUrl(u)}
          onDone={() => done(item)}
          onLater={(until, label) => later(item, until, label)}
          onDismiss={() => dismiss(item)}
          onHelp={() => void help(item)}
          onCancelHelp={() => void cancelHelp(item)}
          onMove={(to) => void moveTask(item, to)}
          onResearch={() => void research(item)}
          onOpenResearch={(id) => void openResearch(id)}
          onDraft={() => {
            setItemId(null);
            setDraftId(item.id);
          }}
          onFocus={() => {
            setItemId(null);
            setFocusId(item.id);
          }}
        />
      ) : null}
      {draftItem ? (
        <DraftSheet
          item={draftItem}
          onClose={() => setDraftId(null)}
          onCopied={() => {
            setDraftId(null);
            haptic('success');
            toast('Reply copied. Tap Reply in Gmail and paste.');
          }}
        />
      ) : null}
      {report ? (
        <ReportSheet
          brief={report}
          onClose={() => setReport(null)}
          onDismissed={() => {
            setReport(null);
            setResearchKey((k) => k + 1);
            void load();
          }}
          onOpenUrl={(u) => void openUrl(u)}
        />
      ) : null}
      {quickAdd ? (
        <QuickAddSheet
          space={space}
          onClose={() => setQuickAdd(false)}
          onAdd={async (t) => {
            try {
              setPlan(await api.nextAddTask(t));
              setQuickAdd(false);
              haptic('success');
              if (t.space !== space) showSpace(t.space);
              else if (space === 'school' && schoolView === 'homework') setSchoolView('school');
              toast(`Added to ${t.space === 'school' ? 'School' : 'Personal'}: ${t.title}`);
            } catch {
              toast('Could not add it. Try again.', { tone: 'error' });
            }
          }}
        />
      ) : null}
      {newProject ? (
        <NewProjectSheet
          space={space}
          onClose={() => setNewProject(false)}
          onCreated={(p) => {
            setNewProject(false);
            if (p.space && p.space !== space) setSpaceRaw(p.space);
            openProject(p.id);
          }}
        />
      ) : null}
      {focusItem ? (
        <FocusMode
          item={focusItem}
          onExit={() => setFocusId(null)}
          onDone={() => {
            setFocusId(null);
            done(focusItem);
          }}
        />
      ) : null}
    </div>
  );
}
