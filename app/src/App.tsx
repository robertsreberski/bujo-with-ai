import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CollectionView } from './views/CollectionView';
import { IndexView } from './views/IndexView';
import { MonthView } from './views/MonthView';
import { ActivityView } from './views/ActivityView';
import { TimelineView } from './views/TimelineView';
import { Composer } from './components/Composer';
import { RecoveryDialog } from './components/DeadLetterDialog';
import { EntryDetailHost } from './components/EntryDetailHost';
import { MigrationDialog } from './components/MigrationDialog';
import { SearchDialog } from './components/SearchDialog';
import { SettingsDialog, type AgentTokenView } from './components/SettingsDialog';
import { Shell } from './components/Shell';
import { Toast, type ToastAction } from './components/Toast';
import { formatLongDate, formatMonth } from './components/dates';
import {
  destinationLabel,
  destinationRoute,
  resolveDestination,
  sameDestination,
  viewedDestination,
  type Destination,
} from './components/destination';
import { planSubmit } from './components/submit';
import type {
  ActivityItem,
  DisplayPreferences,
  EntryPatch,
  JournalEntry,
  ParsedDraft,
} from './components/types';
import { isTextEntryTarget, useViewportLayout } from './hooks/use-viewport-layout';
import { useJournalRoute } from './routes/useJournalRoute';
import { DEFAULT_LOG_VIEW } from './views/log-arrangement';
import { claimJournalInstallGuidance, observeJournalInstallGuidance } from './pwa/install';
import { createUlid } from './store/ids';
import {
  journalActions,
  selectActiveCollections,
  selectHasUnseenActivity,
  selectJournalStatus,
  selectLatestAgentTouches,
  selectTimelineEntries,
  selectUnseenActivityIds,
  useJournalStore,
} from './store/journal-store';

type Overlay = 'search' | 'settings' | 'recovery' | null;

interface ToastState {
  id: number;
  message: string;
  tone: 'success' | 'error';
  action?: ToastAction | undefined;
}

/** A toast with something to do stays long enough to be acted on. */
const TOAST_MS = { plain: 2_400, withAction: 4_000 };

const messageFromError = (error: unknown): string => {
  if (error instanceof Error && error.message) return error.message;
  return 'The journal could not complete that change.';
};

export default function App() {
  useViewportLayout();
  const { route, entryId, navigate, openEntry, closeEntry } = useJournalRoute();
  const store = useJournalStore();
  const journalStatus = selectJournalStatus(store);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [migrationEntries, setMigrationEntries] = useState<JournalEntry[] | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  // Keyed by the focus key so a picked destination survives repeated captures on
  // one screen and lapses the moment the owner navigates somewhere else.
  const [chipState, setChipState] = useState<{ key: string; destination: Destination } | null>(
    null,
  );
  const [focusRequest, setFocusRequest] = useState<number | undefined>(undefined);
  const latestNoticeRef = useRef<string | null>(null);
  const activityTokensLoadedRef = useRef(false);
  const loadedRoutesRef = useRef(new Set<string>());
  const loadedEntryLinksRef = useRef(new Set<string>());
  const routeFocusKeyRef = useRef('');

  const entries = useMemo(
    () => Object.values(store.entriesById).filter((entry) => entry.deletedAt === null),
    [store.entriesById],
  );
  const timelineEntries = selectTimelineEntries(store);
  const timelineRange = useMemo(() => {
    const dates = store.timelineEntryIds
      .flatMap((id) => {
        const entry = store.entriesById[id];
        return entry && entry.deletedAt === null ? [entry.date] : [];
      })
      .sort();
    return dates.length > 0 ? { from: dates[0]!, to: dates.at(-1)! } : null;
  }, [store.entriesById, store.timelineEntryIds]);
  const collections = useMemo(() => Object.values(store.collectionsById), [store.collectionsById]);
  const activity = useMemo(
    () =>
      store.activityOrder.flatMap((id) => (store.activityById[id] ? [store.activityById[id]] : [])),
    [store.activityById, store.activityOrder],
  );
  const latestAgentTouches = useMemo(() => selectLatestAgentTouches(store), [store]);
  const reflections = useMemo(
    () =>
      Object.values(store.reflectionsByWeek)
        .filter(
          (reflection) =>
            timelineRange !== null &&
            reflection.weekStart >= timelineRange.from &&
            reflection.weekStart <= timelineRange.to,
        )
        .sort((left, right) => right.weekStart.localeCompare(left.weekStart)),
    [store.reflectionsByWeek, timelineRange],
  );
  const detailEntry = entryId ? (store.entriesById[entryId] ?? null) : null;
  const preferences: DisplayPreferences = store.settings;
  const displayedMonth =
    route.name === 'month' ? (route.month ?? store.today.slice(0, 7)) : store.today.slice(0, 7);
  // The month a detail surface should file into and name in its schedule label:
  // the browsed month while the month log is open, the current month elsewhere.
  const contextMonth = route.name === 'month' ? displayedMonth : null;
  const routeFocusKey =
    route.name === 'today'
      ? `today:${route.date ?? store.today}`
      : route.name === 'month'
        ? `month:${displayedMonth}`
        : route.name === 'collection'
          ? `collection:${route.collectionId}`
          : route.name;

  // Memoised, never subscribed: the selector builds a fresh array per call, and
  // `useJournalStore(selector)` would hand React a new snapshot every render.
  const activeCollections = useMemo(() => selectActiveCollections(store), [store]);
  const chipOverride = chipState?.key === routeFocusKey ? chipState.destination : null;
  const counts = useMemo(() => ({ activity: selectHasUnseenActivity(store) }), [store]);
  const unseenActivityIds = useMemo(() => selectUnseenActivityIds(store), [store]);

  const say = useCallback(
    (message: string, tone: 'success' | 'error' = 'success', action?: ToastAction) => {
      setToast({ id: Date.now(), message, tone, action });
    },
    [],
  );

  const perform = useCallback(
    async <T,>(operation: () => Promise<T>, success?: string): Promise<T> => {
      try {
        const result = await operation();
        if (success) say(success);
        return result;
      } catch (error) {
        say(messageFromError(error), 'error');
        throw error;
      }
    },
    [say],
  );

  const run = useCallback(
    <T,>(operation: () => Promise<T>, success?: string): void => {
      void perform(operation, success).catch(() => undefined);
    },
    [perform],
  );

  const openRecovery = useCallback(() => {
    setOverlay('recovery');
    void journalActions
      .loadRecovery()
      .catch((error: unknown) => say(messageFromError(error), 'error'));
  }, [say]);

  const restoreEntry = useCallback(
    (id: string) => {
      void perform(() => journalActions.restoreEntry(id))
        .then((result) => {
          say(
            result.outcome === 'daily_fallback'
              ? `Entry restored to ${result.entry.date}; its original collection no longer exists`
              : 'Entry restored',
          );
        })
        .catch(() => undefined);
    },
    [perform, say],
  );

  const requestReflection = useCallback(
    (id: string) => run(() => journalActions.requestReflection(id), 'Reflection requested'),
    [run],
  );

  const retryReflection = useCallback(
    (id: string) => run(() => journalActions.retryReflection(id), 'Reflection requested again'),
    [run],
  );

  const restoreReflection = useCallback(
    (id: string, versionId: string) =>
      run(
        () => journalActions.restoreReflectionVersion(id, versionId),
        'Reflection version restored',
      ),
    [run],
  );

  const writeReflection = useCallback((weekEnd: string) => {
    journalActions.setDefaultType('note');
    journalActions.focusComposer({ kind: 'date', date: weekEnd });
  }, []);

  useEffect(() => {
    const stopObservingInstall = observeJournalInstallGuidance();
    void journalActions
      .initialize()
      .catch((error: unknown) => say(messageFromError(error), 'error'));
    return () => {
      stopObservingInstall();
      journalActions.shutdown();
    };
  }, [say]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(
      () => setToast((current) => (current?.id === toast.id ? null : current)),
      toast.action ? TOAST_MS.withAction : TOAST_MS.plain,
    );
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!entryId || detailEntry || !store.online || loadedEntryLinksRef.current.has(entryId))
      return;
    loadedEntryLinksRef.current.add(entryId);
    void journalActions.loadEntry(entryId).catch((error: unknown) => {
      loadedEntryLinksRef.current.delete(entryId);
      say(messageFromError(error), 'error');
    });
  }, [detailEntry, entryId, say, store.online]);

  useEffect(() => {
    const notice = store.notices.at(-1);
    if (!notice || latestNoticeRef.current === notice.id) return;
    latestNoticeRef.current = notice.id;
    say(notice.message, notice.kind === 'error' ? 'error' : 'success');
  }, [say, store.notices]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (document.querySelector('[role="dialog"]')) return;
        setSearchQuery('');
        setOverlay('search');
        return;
      }
      // `/` jumps to the composer, but only when it is not already a character
      // the owner is typing somewhere — including into the composer itself.
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      if (document.querySelector('[role="dialog"]')) return;
      if (isTextEntryTarget(event.target as Element | null)) return;
      event.preventDefault();
      journalActions.focusComposer();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    routeFocusKeyRef.current = routeFocusKey;
  }, [routeFocusKey]);

  const screenDestinationRef = useRef<Destination | null>(null);
  useEffect(() => {
    screenDestinationRef.current = viewedDestination(route, store.today);
  }, [route, store.today]);

  // The cross-agent contract: a view asks for the composer, App applies the
  // destination as this screen's chip and pushes focus down to the input. Read
  // as a store subscription rather than a render-time effect so a preset never
  // re-applies when something unrelated re-renders App.
  useEffect(
    () =>
      useJournalStore.subscribe((state, previous) => {
        const preset = state.composerPreset;
        if (preset === null || preset === previous.composerPreset) return;
        if (preset.destination !== null) {
          // A preset that only repeats the screen's own default would pin a
          // chip whose clear button does nothing — retire it instead, exactly
          // as the picker does when the default is re-picked.
          const screenDest = screenDestinationRef.current;
          setChipState(
            screenDest !== null && sameDestination(preset.destination, screenDest)
              ? null
              : { key: routeFocusKeyRef.current, destination: preset.destination },
          );
        }
        setFocusRequest(preset.nonce);
      }),
    [],
  );

  const openSearch = useCallback((query = '') => {
    setSearchQuery(query);
    setOverlay('search');
  }, []);

  const updateEntry = useCallback(
    (entry: JournalEntry, patch: EntryPatch, message: string) => {
      run(() => journalActions.updateEntry(entry.id, patch), message);
    },
    [run],
  );

  const toggleEntry = useCallback(
    (entry: JournalEntry) => run(() => journalActions.toggleEntry(entry.id)),
    [run],
  );

  const migrateEntry = useCallback(
    (entry: JournalEntry) => run(() => journalActions.migrateEntry(entry.id), 'Moved to today'),
    [run],
  );

  const scheduleEntry = useCallback(
    (entry: JournalEntry) =>
      run(
        () => journalActions.scheduleEntry(entry.id, contextMonth ?? undefined),
        'Added to monthly log',
      ),
    [contextMonth, run],
  );

  const acceptMigration = useCallback(
    (entry: JournalEntry) =>
      perform(() => journalActions.migrateEntry(entry.id), 'Moved to today').then(() => undefined),
    [perform],
  );

  const acceptSchedule = useCallback(
    (entry: JournalEntry) =>
      perform(() => journalActions.scheduleEntry(entry.id), 'Added to monthly log').then(
        () => undefined,
      ),
    [perform],
  );

  const acceptMigrationState = useCallback(
    (entry: JournalEntry, state: 'done' | 'cancelled') =>
      perform(
        () => journalActions.updateEntry(entry.id, { state }),
        state === 'done' ? 'Marked done' : 'Dropped',
      ).then(() => undefined),
    [perform],
  );

  const loadMoreActivity = useCallback(() => {
    run(() => journalActions.loadMoreActivity());
  }, [run]);

  const submitDraft = useCallback(
    (parsed: ParsedDraft) => {
      const resolved = resolveDestination({
        route,
        today: store.today,
        chipOverride,
        parsedCollection: parsed.collection,
        dateShift: parsed.dateShift,
        collectionsById: store.collectionsById,
      });
      const plan = planSubmit(parsed, resolved, store.today);
      // Both calls enqueue and return; the outbox is FIFO, so a brand new
      // collection is always created before the entry that files into it —
      // offline included.
      if (plan.collection) {
        void journalActions.createCollection(plan.collection).catch(() => undefined);
      }
      const label = destinationLabel(resolved.destination, store.collectionsById, store.today);
      // "View" is only worth offering when the entry landed off-screen.
      const viewed = viewedDestination(route, store.today);
      const onScreen = viewed !== null && sameDestination(viewed, resolved.destination);
      const target = destinationRoute(resolved.destination, store.today);
      void perform(() => journalActions.createEntry({ id: createUlid(), ...plan.entry }))
        .then(() => {
          const installGuidance = onScreen ? claimJournalInstallGuidance() : null;
          if (installGuidance?.kind === 'ios') {
            say(`Added to ${label} · For offline access, use Share then Add to Home Screen`);
            return;
          }
          say(
            `Added to ${label}`,
            'success',
            installGuidance?.kind === 'prompt'
              ? { label: 'Install app', onAction: () => void installGuidance.install() }
              : onScreen
                ? undefined
                : { label: 'View', onAction: () => navigate(target) },
          );
        })
        .catch(() => undefined);
      journalActions.setDraft('');
    },
    [chipOverride, navigate, perform, route, say, store.collectionsById, store.today],
  );

  // PWA-16: focusing the composer brings the newest day back under the
  // shrinking visible viewport. Only the day list has a newest day to reveal.
  const revealNewestDay = useCallback(() => {
    const day = document.querySelector<HTMLElement>('.day-section');
    if (typeof day?.scrollIntoView === 'function') {
      day.scrollIntoView({ block: 'start', behavior: 'auto' });
    }
  }, []);

  const refreshTokens = useCallback(() => {
    run(() => journalActions.refreshTokens());
  }, [run]);

  const createToken = useCallback(
    async (label: string): Promise<{ token: AgentTokenView; secret: string }> => {
      try {
        return await journalActions.createToken(label);
      } catch (error) {
        say(messageFromError(error), 'error');
        throw error;
      }
    },
    [say],
  );

  useEffect(() => {
    if (route.name !== 'activity' || !store.online || activityTokensLoadedRef.current) return;
    activityTokensLoadedRef.current = true;
    void journalActions.refreshTokens().catch(() => {
      activityTokensLoadedRef.current = false;
    });
  }, [route.name, store.online]);

  useEffect(() => {
    if (store.connectionStatus !== 'connected') loadedRoutesRef.current.clear();
  }, [store.connectionStatus]);

  useEffect(() => {
    if (!store.hydrated || route.name !== 'today' || route.date !== store.today) return;
    navigate({ name: 'today', date: null }, { replace: true });
  }, [navigate, route, store.hydrated, store.today]);

  useEffect(() => {
    if (
      route.name !== 'today' ||
      !store.hydrated ||
      !store.online ||
      store.connectionStatus !== 'connected' ||
      route.date === store.today
    ) {
      return;
    }
    const anchorDate = route.date;
    if (store.timelineLoaded && store.timelineAnchorDate === anchorDate) return;
    const key = `timeline:${anchorDate ?? 'latest'}`;
    const loadedRoutes = loadedRoutesRef.current;
    if (loadedRoutes.has(key)) return;
    loadedRoutes.add(key);
    void journalActions.loadTimeline(anchorDate).catch((error: unknown) => {
      loadedRoutes.delete(key);
      say(messageFromError(error), 'error');
    });
    return () => {
      loadedRoutes.delete(key);
    };
  }, [
    route,
    say,
    store.connectionStatus,
    store.hydrated,
    store.online,
    store.timelineAnchorDate,
    store.timelineLoaded,
    store.today,
  ]);

  useEffect(() => {
    if (!store.hydrated || !store.online || store.connectionStatus !== 'connected') {
      return;
    }
    const request = (() => {
      if (route.name === 'today') {
        if (
          !store.timelineLoaded ||
          store.timelineAnchorDate !== route.date ||
          timelineRange === null
        ) {
          return null;
        }
        return {
          key: `timeline-reflections:${route.date ?? 'latest'}:${timelineRange.from}:${timelineRange.to}`,
          load: () => journalActions.loadReflections(),
        };
      }
      if (route.name === 'month') {
        const month = route.month ?? store.today.slice(0, 7);
        return { key: `month:${month}`, load: () => journalActions.loadMonth(month) };
      }
      if (route.name === 'collection') {
        return {
          key: `collection:${route.collectionId}`,
          load: () => journalActions.loadCollection(route.collectionId),
        };
      }
      if (route.name === 'index') {
        return {
          key: `index:${store.cursor ?? 'initial'}`,
          load: () => journalActions.loadIndex(),
        };
      }
      return null;
    })();
    if (!request || loadedRoutesRef.current.has(request.key)) return;
    loadedRoutesRef.current.add(request.key);
    void request.load().catch((error: unknown) => {
      loadedRoutesRef.current.delete(request.key);
      say(messageFromError(error), 'error');
    });
  }, [
    route,
    say,
    store.connectionStatus,
    store.cursor,
    store.entriesById,
    store.hydrated,
    store.online,
    store.timelineAnchorDate,
    store.timelineEntryIds,
    store.timelineLoaded,
    store.today,
    timelineRange,
  ]);

  const screen = (() => {
    switch (route.name) {
      case 'today':
        return (
          <TimelineView
            entries={
              store.timelineLoaded && store.timelineAnchorDate === route.date ? timelineEntries : []
            }
            collectionsById={store.collectionsById}
            entriesById={store.entriesById}
            latestAgentTouches={latestAgentTouches}
            reflections={reflections}
            today={store.today}
            selectedDate={route.date}
            loading={
              store.timelineLoading ||
              !store.timelineLoaded ||
              store.timelineAnchorDate !== route.date
            }
            hasEarlier={
              store.timelineLoaded &&
              store.timelineAnchorDate === route.date &&
              store.timelineNextCursor !== null
            }
            loadingEarlier={store.timelineLoadingEarlier}
            preferences={preferences}
            online={store.online}
            timezone={store.timezone}
            onOpenEntry={(entry) => openEntry(entry.id)}
            onToggleEntry={toggleEntry}
            onStartMigration={setMigrationEntries}
            onLoadEarlier={() => run(() => journalActions.loadEarlierTimeline())}
            onRequestReflection={requestReflection}
            onRetryReflection={retryReflection}
            onRestoreReflection={restoreReflection}
            onWriteReflection={writeReflection}
          />
        );
      case 'month':
        return (
          <MonthView
            month={displayedMonth}
            today={store.today}
            entries={entries}
            collections={collections}
            summary={store.summariesByMonth[displayedMonth] ?? null}
            preferences={preferences}
            logView={store.monthLogView ?? DEFAULT_LOG_VIEW}
            onLogViewChange={journalActions.setMonthLogView}
            onMonthChange={(month) => navigate({ name: 'month', month })}
            onDaySelect={(date) =>
              navigate({ name: 'today', date: date === store.today ? null : date })
            }
            onOpenEntry={(entry) => openEntry(entry.id)}
            onToggleEntry={toggleEntry}
            onSaveSummary={(summary) =>
              run(() => journalActions.saveSummary(summary.id), 'Weekly summary saved to today')
            }
            onRewriteSummary={(summary) =>
              run(() => journalActions.rewriteSummary(summary.id), 'Rewrite requested')
            }
          />
        );
      case 'index':
        return (
          <IndexView
            index={store.index}
            status={store.indexStatus}
            source={store.indexSource}
            online={store.online}
            error={store.indexError}
            onRetry={() => run(() => journalActions.loadIndex())}
            onOpenCollection={(collection) =>
              navigate({ name: 'collection', collectionId: collection.id })
            }
            onOpenMonth={(month) => navigate({ name: 'month', month })}
            onOpenSearch={openSearch}
            onCreateCollection={(input) =>
              run(() => journalActions.createCollection(input), 'Collection created')
            }
            onUpdateCollection={(id, patch) =>
              run(
                () => journalActions.updateCollection(id, patch),
                patch.archived === true
                  ? 'Collection archived'
                  : patch.archived === false
                    ? 'Collection restored'
                    : 'Collection updated',
              )
            }
          />
        );
      case 'collection': {
        const collection = store.collectionsById[route.collectionId] ?? null;
        return (
          <CollectionView
            collection={collection}
            entries={entries}
            preferences={preferences}
            logView={store.collectionLogView ?? DEFAULT_LOG_VIEW}
            onLogViewChange={journalActions.setCollectionLogView}
            onBack={() => navigate({ name: 'index' })}
            onOpenEntry={(entry) => openEntry(entry.id)}
            onToggleEntry={toggleEntry}
          />
        );
      }
      case 'activity': {
        const tokenLabels = Object.fromEntries(
          store.agentTokens.map((token) => [token.id, token.label]),
        );
        return (
          <ActivityView
            activity={activity}
            tokenLabels={tokenLabels}
            unseenIds={unseenActivityIds}
            hasUnseen={counts.activity}
            hasMore={store.activityHasMore}
            loadingMore={store.activityLoading}
            timezone={store.timezone}
            onLoadMore={loadMoreActivity}
            onOpenEntry={openEntry}
            onMarkVisible={journalActions.markActivityVisible}
            onMarkAllSeen={journalActions.markAllActivitySeen}
            onRevert={(item: ActivityItem) =>
              run(() => journalActions.revertActivity(item.id), 'Change reverted')
            }
          />
        );
      }
    }
  })();

  const routeTitle = (() => {
    switch (route.name) {
      case 'today':
        return route.date
          ? route.date > store.today
            ? `Planning ${formatLongDate(route.date)}`
            : formatLongDate(route.date)
          : 'Timeline';
      case 'month':
        return formatMonth(displayedMonth);
      case 'index':
        return 'Index';
      case 'collection':
        return store.collectionsById[route.collectionId]?.name ?? 'Collection';
      case 'activity':
        return 'Activity';
    }
  })();
  const routeSubtitle = (() => {
    switch (route.name) {
      case 'today':
        return route.date
          ? route.date > store.today
            ? 'Future log'
            : 'Daily log in your Timeline'
          : formatLongDate(store.today);
      case 'month':
        return 'Monthly log';
      case 'index':
        return `${activeCollections.length} active ${activeCollections.length === 1 ? 'collection' : 'collections'}`;
      case 'collection':
        return 'Collection in your journal index';
      case 'activity':
        return 'Agent changes and reversible history';
    }
  })();
  const selectedTodayDate = route.name === 'today' ? route.date : null;

  useEffect(() => {
    document.title = `${routeTitle} · Journal`;
  }, [routeTitle]);

  useEffect(() => {
    if (selectedTodayDate) return;
    const frame = window.requestAnimationFrame(() => {
      if (document.querySelector('[role="dialog"]')) return;
      // Never pull focus (and the keyboard) out of an active capture.
      if (
        isTextEntryTarget(document.activeElement) ||
        document.documentElement.classList.contains('keyboard-open')
      ) {
        return;
      }
      const content = document.getElementById('journal-content');
      if (typeof content?.scrollTo === 'function') {
        content.scrollTo({ top: 0, left: 0, behavior: 'auto' });
      }
      content?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [routeFocusKey, selectedTodayDate, store.hydrated]);

  if (journalStatus.resource === 'loading') {
    return (
      <main
        className="flex h-[var(--app-height,100vh)] w-full flex-col items-center justify-center bg-bg-page text-fg"
        aria-live="polite"
      >
        <span className="grid size-11 place-items-center rounded-2xl border border-ai-border bg-ai-bg text-[18px] font-semibold text-ai-fg">
          J
        </span>
        <h1 className="pt-2.5 text-lg">Journal</h1>
        <p className="pt-[3px] text-sm text-fg-mute">Opening your local journal…</p>
      </main>
    );
  }

  return (
    <>
      <Shell
        route={route}
        today={store.today}
        counts={counts}
        journalStatus={journalStatus}
        offlineReady={store.offlineReady}
        updateReady={store.updateReady}
        title={routeTitle}
        subtitle={routeSubtitle}
        onNavigate={navigate}
        onSearch={() => openSearch()}
        onSettings={() => setOverlay('settings')}
        onRetryConnection={() => void journalActions.reconnect()}
        onRetryLocalSave={() => run(() => journalActions.retryLocalSave(), 'Local journal saved')}
        onReload={() => window.location.reload()}
        onActivateUpdate={journalActions.activateUpdate}
        onOpenRecovery={openRecovery}
        composer={
          <Composer
            draft={store.draft}
            defaultType={store.defaultType}
            onDraftChange={journalActions.setDraft}
            onDefaultTypeChange={journalActions.setDefaultType}
            onSubmit={submitDraft}
            onInputFocus={route.name === 'today' ? revealNewestDay : undefined}
            route={route}
            today={store.today}
            collectionsById={store.collectionsById}
            collections={activeCollections}
            tagSuggestions={store.tagSuggestions}
            onLoadTagSuggestions={journalActions.loadTagSuggestions}
            chipOverride={chipOverride}
            onChipOverrideChange={(destination) =>
              setChipState(destination === null ? null : { key: routeFocusKey, destination })
            }
            focusRequest={focusRequest}
          />
        }
      >
        {screen}
      </Shell>

      {detailEntry ? (
        <EntryDetailHost
          entry={detailEntry}
          collections={collections}
          today={store.today}
          contextMonth={contextMonth}
          onClose={closeEntry}
          onUpdate={updateEntry}
          onDelete={(entry: JournalEntry) => {
            void perform(() => journalActions.deleteEntry(entry.id))
              .then(() =>
                say('Entry deleted', 'success', {
                  label: 'Undo',
                  onAction: () => restoreEntry(entry.id),
                }),
              )
              .catch(() => undefined);
          }}
          onMigrate={migrateEntry}
          onSchedule={scheduleEntry}
        />
      ) : null}
      {migrationEntries ? (
        <MigrationDialog
          entries={migrationEntries}
          onClose={() => setMigrationEntries(null)}
          onMigrate={acceptMigration}
          onSchedule={acceptSchedule}
          onUpdate={acceptMigrationState}
          onComplete={() => {
            setMigrationEntries(null);
            say('All caught up');
          }}
        />
      ) : null}
      {overlay === 'search' ? (
        <SearchDialog
          preferences={preferences}
          initialQuery={searchQuery}
          onSearch={journalActions.searchEntries}
          onClose={() => setOverlay(null)}
          onOpenEntry={(entry) => openEntry(entry.id)}
          onToggleEntry={toggleEntry}
        />
      ) : null}
      {overlay === 'settings' ? (
        <SettingsDialog
          assistantStatus={store.mcpStatus?.status ?? (store.online ? 'ready' : 'offline')}
          mcpEndpoint={store.mcpStatus?.endpoint ?? `${window.location.origin}/mcp`}
          activeSessions={store.mcpStatus?.activeSessions ?? 0}
          tokens={store.agentTokens}
          tokensLoading={store.tokensLoading}
          preferences={preferences}
          updateReady={store.updateReady}
          offlineReady={store.offlineReady}
          recentlyDeletedCount={store.recentlyDeleted.length}
          failedChangeCount={store.deadLetters.length}
          onClose={() => setOverlay(null)}
          onOpenRecovery={openRecovery}
          onUpdatePreferences={(patch) =>
            run(() => journalActions.updateSettings(patch), 'Preferences updated')
          }
          onRefreshTokens={refreshTokens}
          onCreateToken={createToken}
          onRevokeToken={(id) => run(() => journalActions.revokeToken(id), 'Token revoked')}
          onActivateUpdate={journalActions.activateUpdate}
        />
      ) : null}
      {overlay === 'recovery' ? (
        <RecoveryDialog
          deadLetters={store.deadLetters}
          recentlyDeleted={store.recentlyDeleted}
          entriesById={store.entriesById}
          recoveryLoading={store.recoveryLoading}
          online={store.online}
          onClose={() => setOverlay(null)}
          onRefresh={() => run(() => journalActions.loadRecovery())}
          onRestore={restoreEntry}
          onOpenEntry={(id) => {
            setOverlay(null);
            openEntry(id);
          }}
          onRetry={(id) => run(() => journalActions.retryDeadLetter(id), 'Retry queued')}
          onDiscard={(id) =>
            run(() => journalActions.discardDeadLetter(id), 'Failed change discarded')
          }
        />
      ) : null}
      {toast ? (
        <Toast message={toast.message} tone={toast.tone} action={toast.action} key={toast.id} />
      ) : null}
    </>
  );
}
