import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CollectionView } from './views/CollectionView';
import { IndexView } from './views/IndexView';
import { MonthView } from './views/MonthView';
import { ReviewView } from './views/ReviewView';
import { TodayView } from './views/TodayView';
import { Composer } from './components/Composer';
import { DeadLetterDialog } from './components/DeadLetterDialog';
import { EntryDialog } from './components/EntryDialog';
import { MigrationDialog } from './components/MigrationDialog';
import { SearchDialog } from './components/SearchDialog';
import { SettingsDialog, type AgentTokenView } from './components/SettingsDialog';
import { Shell } from './components/Shell';
import { Toast } from './components/Toast';
import { formatLongDate, formatMonth } from './components/dates';
import type {
  ActivityItem,
  DisplayPreferences,
  EntryPatch,
  JournalEntry,
  ParsedDraft,
} from './components/types';
import { isTextEntryTarget, useViewportLayout } from './hooks/use-viewport-layout';
import { useJournalRoute } from './routes/useJournalRoute';
import { createUlid } from './store/ids';
import { journalActions, useJournalStore } from './store/journal-store';

type Overlay = 'search' | 'settings' | 'deadLetters' | null;

interface ToastState {
  id: number;
  message: string;
  tone: 'success' | 'error';
}

const messageFromError = (error: unknown): string => {
  if (error instanceof Error && error.message) return error.message;
  return 'The journal could not complete that change.';
};

export default function App() {
  useViewportLayout();
  const { route, navigate } = useJournalRoute();
  const store = useJournalStore();
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [detailId, setDetailId] = useState<string | null>(null);
  const [migrationEntries, setMigrationEntries] = useState<JournalEntry[] | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const latestNoticeRef = useRef<string | null>(null);
  const reviewTokensLoadedRef = useRef(false);
  const loadedRoutesRef = useRef(new Set<string>());

  const entries = useMemo(
    () => Object.values(store.entriesById).filter((entry) => entry.deletedAt === null),
    [store.entriesById],
  );
  const collections = useMemo(() => Object.values(store.collectionsById), [store.collectionsById]);
  const activity = useMemo(
    () =>
      store.activityOrder.flatMap((id) => (store.activityById[id] ? [store.activityById[id]] : [])),
    [store.activityById, store.activityOrder],
  );
  const detailEntry = detailId ? (store.entriesById[detailId] ?? null) : null;
  const preferences: DisplayPreferences = store.settings;
  const displayedMonth =
    route.name === 'month' ? (route.month ?? store.today.slice(0, 7)) : store.today.slice(0, 7);
  // The month a detail surface should file into and name in its schedule label:
  // the browsed month while the month log is open, the current month elsewhere.
  const contextMonth = route.name === 'month' ? displayedMonth : null;

  const say = useCallback((message: string, tone: 'success' | 'error' = 'success') => {
    setToast({ id: Date.now(), message, tone });
  }, []);

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

  useEffect(() => {
    void journalActions
      .initialize()
      .catch((error: unknown) => say(messageFromError(error), 'error'));
    return () => journalActions.shutdown();
  }, [say]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(
      () => setToast((current) => (current?.id === toast.id ? null : current)),
      2400,
    );
    return () => window.clearTimeout(timer);
  }, [toast]);

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
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

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
      const id = createUlid();
      run(
        () =>
          journalActions.createEntry({
            id,
            text: parsed.text,
            type: parsed.type,
            time: parsed.time,
            tags: parsed.tags,
            collection: null,
            dateShift: parsed.dateShift,
          }),
        parsed.dateShift ? 'Added to tomorrow' : 'Added to today',
      );
      journalActions.setDraft('');
      navigate({ name: 'today', date: parsed.dateShift ? null : store.today });
    },
    [navigate, run, store.today],
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
    if (route.name !== 'review' || !store.online || reviewTokensLoadedRef.current) return;
    reviewTokensLoadedRef.current = true;
    void journalActions.refreshTokens().catch(() => {
      reviewTokensLoadedRef.current = false;
    });
  }, [route.name, store.online]);

  useEffect(() => {
    if (store.connectionStatus !== 'connected') loadedRoutesRef.current.clear();
  }, [store.connectionStatus]);

  useEffect(() => {
    if (!store.hydrated || !store.online || store.connectionStatus !== 'connected') {
      return;
    }
    const request = (() => {
      if (route.name === 'today') {
        if (route.date) {
          return {
            key: `day:${route.date}`,
            load: () => journalActions.loadDate(route.date ?? store.today),
          };
        }
        return { key: 'today:history', load: () => journalActions.loadEntries({}) };
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
        return { key: 'index:all', load: () => journalActions.loadEntries({}) };
      }
      return null;
    })();
    if (!request || loadedRoutesRef.current.has(request.key)) return;
    loadedRoutesRef.current.add(request.key);
    void request.load().catch((error: unknown) => {
      loadedRoutesRef.current.delete(request.key);
      say(messageFromError(error), 'error');
    });
  }, [route, say, store.connectionStatus, store.hydrated, store.online, store.today]);

  const screen = (() => {
    switch (route.name) {
      case 'today':
        return (
          <TodayView
            entries={entries}
            today={store.today}
            selectedDate={route.date}
            preferences={preferences}
            onOpenEntry={(entry) => setDetailId(entry.id)}
            onToggleEntry={toggleEntry}
            onStartMigration={setMigrationEntries}
          />
        );
      case 'month':
        return (
          <MonthView
            month={displayedMonth}
            today={store.today}
            entries={entries}
            summary={store.summariesByMonth[displayedMonth] ?? null}
            preferences={preferences}
            onMonthChange={(month) => navigate({ name: 'month', month })}
            onDaySelect={(date) => navigate({ name: 'today', date })}
            onOpenEntry={(entry) => setDetailId(entry.id)}
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
            collections={collections}
            entries={entries}
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
                patch.archived ? 'Collection archived' : 'Collection updated',
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
            onBack={() => navigate({ name: 'index' })}
            onOpenEntry={(entry) => setDetailId(entry.id)}
            onToggleEntry={toggleEntry}
          />
        );
      }
      case 'review': {
        const tokenLabels = Object.fromEntries(
          store.agentTokens.map((token) => [token.id, token.label]),
        );
        return (
          <ReviewView
            activity={activity}
            tokenLabels={tokenLabels}
            hasMore={store.activityHasMore}
            loadingMore={store.activityLoading}
            timezone={store.timezone}
            onLoadMore={loadMoreActivity}
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
        return route.date && route.date !== store.today ? formatLongDate(route.date) : 'Today';
      case 'month':
        return formatMonth(displayedMonth);
      case 'index':
        return 'Index';
      case 'collection':
        return store.collectionsById[route.collectionId]?.name ?? 'Collection';
      case 'review':
        return 'Review';
    }
  })();
  const dayCount = new Set(
    entries.filter((entry) => entry.collection === null).map((entry) => entry.date),
  ).size;
  const routeSubtitle =
    route.name === 'today'
      ? formatLongDate(route.date ?? store.today)
      : `${dayCount} ${dayCount === 1 ? 'day' : 'days'} logged`;
  const routeFocusKey =
    route.name === 'today'
      ? `today:${route.date ?? store.today}`
      : route.name === 'month'
        ? `month:${displayedMonth}`
        : route.name === 'collection'
          ? `collection:${route.collectionId}`
          : route.name;
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
      content?.scrollTo({ top: 0, left: 0, behavior: 'auto' });
      content?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [routeFocusKey, selectedTodayDate, store.hydrated]);

  if (!store.hydrated && store.loading) {
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
        dayCount={dayCount}
        online={
          store.online && store.connectionStatus !== 'offline' && store.connectionStatus !== 'error'
        }
        syncing={store.syncing}
        outboxCount={store.outboxCount}
        deadLetterCount={store.deadLetters.length}
        title={routeTitle}
        subtitle={routeSubtitle}
        onNavigate={navigate}
        onSearch={() => openSearch()}
        onSettings={() => setOverlay('settings')}
        onDeadLetters={() => setOverlay('deadLetters')}
        composer={
          <Composer
            draft={store.draft}
            defaultType={store.defaultType}
            onDraftChange={journalActions.setDraft}
            onDefaultTypeChange={journalActions.setDefaultType}
            onSubmit={submitDraft}
            onInputFocus={route.name === 'today' ? revealNewestDay : undefined}
          />
        }
      >
        {screen}
      </Shell>

      {detailEntry ? (
        <EntryDialog
          entry={detailEntry}
          collections={collections}
          today={store.today}
          contextMonth={contextMonth}
          onClose={() => setDetailId(null)}
          onUpdate={updateEntry}
          onDelete={(entry: JournalEntry) =>
            run(() => journalActions.deleteEntry(entry.id), 'Entry deleted')
          }
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
          entries={entries}
          preferences={preferences}
          initialQuery={searchQuery}
          onSearch={journalActions.searchEntries}
          onClose={() => setOverlay(null)}
          onOpenEntry={(entry) => setDetailId(entry.id)}
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
          onClose={() => setOverlay(null)}
          onUpdatePreferences={(patch) =>
            run(() => journalActions.updateSettings(patch), 'Preferences updated')
          }
          onRefreshTokens={refreshTokens}
          onCreateToken={createToken}
          onRevokeToken={(id) => run(() => journalActions.revokeToken(id), 'Token revoked')}
          onActivateUpdate={journalActions.activateUpdate}
        />
      ) : null}
      {overlay === 'deadLetters' ? (
        <DeadLetterDialog
          deadLetters={store.deadLetters}
          onClose={() => setOverlay(null)}
          onRetry={(id) => run(() => journalActions.retryDeadLetter(id), 'Retry queued')}
          onDiscard={(id) =>
            run(() => journalActions.discardDeadLetter(id), 'Failed change discarded')
          }
        />
      ) : null}
      {toast ? <Toast message={toast.message} tone={toast.tone} key={toast.id} /> : null}
    </>
  );
}
