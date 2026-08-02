import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { useChromeGeometry } from '../hooks/use-chrome-geometry';
import type { JournalRoute } from '../routes/useJournalRoute';
import { Icon, type IconName } from './Icon';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { formatLongDate } from './dates';
import { cn } from '../lib/utils';
import type { JournalStatus } from '../domain/contracts';

/** The two nav destinations that carry a count, and what that count means. */
export interface ShellCounts {
  /** Open tasks and habits due today or earlier, outside collections. */
  today?: number;
  /** At least one loaded event is still unseen; deliberately not a total. */
  activity?: boolean;
}

interface ShellProps {
  route: JournalRoute;
  today: string;
  journalStatus: JournalStatus;
  offlineReady: boolean;
  updateReady: boolean;
  counts?: ShellCounts;
  title: string;
  subtitle: string;
  children: ReactNode;
  composer: ReactNode;
  onNavigate: (route: JournalRoute) => void;
  onSearch: () => void;
  onSettings: () => void;
  onRetryConnection: () => void;
  onRetryLocalSave: () => void;
  onReload: () => void;
  onActivateUpdate: () => void;
  onOpenRecovery: () => void;
}

type NavName = 'today' | 'month' | 'index' | 'activity';

const navItems: Array<{
  name: NavName;
  label: string;
  icon: IconName;
  /** The count's unit, singular, for the accessible name. */
  unit?: string;
}> = [
  { name: 'today', label: 'Timeline', icon: 'check', unit: 'open item' },
  { name: 'month', label: 'Month', icon: 'calendar' },
  { name: 'index', label: 'Index', icon: 'folder' },
  { name: 'activity', label: 'Activity', icon: 'sparkle', unit: 'unseen change' },
];

/** Two digits is all the badge has room for; past that the number stops mattering. */
const badgeLabel = (count: number): string => (count > 9 ? '9+' : String(count));

/** The 720px reading measure the header, tabs, status strip, and content share. */
const contentColumn = 'mx-auto w-full max-w-(--content-width)';

/* DS-14 chrome density: 34px sidebar rows and 30px tab segments, both inflated
   to the 44px primary-target minimum through the `touch:` variant. */
const navItemClassName =
  'flex h-[34px] items-center gap-[9px] rounded-md px-[9px] text-left text-md hover:bg-bg-line hover:text-fg touch:min-h-11';
/* A counted segment carries label + badge, so the tab is a centred flex row and
   clips rather than wraps: two lines would not fit its 30px box, and an
   overflowing one would widen the 320px frame the narrow sweep measures. */
const tabClassName =
  'flex h-[30px] min-w-0 items-center justify-center gap-1.5 overflow-hidden rounded-md text-sm font-medium whitespace-nowrap touch:min-h-11';

export function Shell({
  route,
  today,
  journalStatus,
  offlineReady,
  updateReady,
  counts,
  title,
  subtitle,
  children,
  composer,
  onNavigate,
  onSearch,
  onSettings,
  onRetryConnection,
  onRetryLocalSave,
  onReload,
  onActivateUpdate,
  onOpenRecovery,
}: ShellProps) {
  const paneRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLElement | null>(null);
  // The composer arrives as a slot, so its shell element is resolved from the
  // mounted pane. The geometry hook has to measure that element itself: while
  // the keyboard is open it is `position: fixed`, so any wrapper around it
  // would measure zero.
  useLayoutEffect(() => {
    composerRef.current = paneRef.current?.querySelector<HTMLElement>('.composer-shell') ?? null;
  });
  useChromeGeometry(paneRef, composerRef);

  const isActive = (name: NavName) =>
    name === route.name || (name === 'index' && route.name === 'collection');
  const navigate = (name: NavName) => {
    if (name === 'today') onNavigate({ name: 'today', date: null });
    else if (name === 'month') onNavigate({ name: 'month', month: null });
    else onNavigate({ name });
  };
  // Counts are announced, not just drawn: the badge itself is decorative, so the
  // number joins the button's accessible name instead of being read as a digit
  // floating after the label.
  const countFor = (name: NavName): number => (name === 'today' ? (counts?.today ?? 0) : 0);
  const hasActivity = counts?.activity === true;
  const accessibleName = (item: (typeof navItems)[number]): string | undefined => {
    if (item.name === 'activity' && hasActivity) return 'Activity — unseen changes';
    const count = countFor(item.name);
    if (count === 0 || !item.unit) return undefined;
    return `${item.label} — ${count} ${item.unit}${count === 1 ? '' : 's'}`;
  };
  const dateCaption = formatLongDate(today);
  const pendingChanges = `${journalStatus.pendingChanges} change${journalStatus.pendingChanges === 1 ? '' : 's'} ${
    journalStatus.persistence === 'available' ? 'saved on this device' : 'only in this open tab'
  }`;
  const pendingChangesSuffix = journalStatus.pendingChanges > 0 ? ` — ${pendingChanges}` : '';
  const connectionNotice = (() => {
    switch (journalStatus.connection) {
      case 'initializing':
        return null;
      case 'online':
        return null;
      case 'reconnecting':
        return {
          icon: 'refresh' as const,
          variant: 'status' as const,
          message: `Reconnecting to Journal${pendingChangesSuffix}`,
          action: 'Retry',
          onAction: onRetryConnection,
        };
      case 'offline':
        return {
          icon: 'wifiOff' as const,
          variant: 'statusOffline' as const,
          message:
            journalStatus.pendingChanges > 0
              ? `${offlineReady ? 'Offline ready' : 'Offline'} — ${pendingChanges}`
              : offlineReady
                ? 'Offline ready — showing what is saved on this device'
                : 'Offline — showing what is available on this device',
          action: null,
          onAction: null,
        };
      case 'serverUnavailable':
        return {
          icon: 'warning' as const,
          variant: 'statusError' as const,
          message: `Journal server unavailable${pendingChangesSuffix}`,
          action: 'Retry',
          onAction: onRetryConnection,
        };
      case 'authenticationRequired':
        return {
          icon: 'warning' as const,
          variant: 'statusError' as const,
          message: `Pairing expired${pendingChangesSuffix}`,
          action: 'Reload',
          onAction: onReload,
        };
    }
  })();
  const showPending =
    journalStatus.synchronization === 'pending' && journalStatus.connection === 'online';
  const localSaveUnavailable = journalStatus.persistence === 'unavailable';
  const showStatusStrip =
    connectionNotice !== null ||
    showPending ||
    journalStatus.synchronization === 'syncing' ||
    journalStatus.failedChanges > 0 ||
    localSaveUnavailable ||
    updateReady;
  return (
    <div className="flex h-[var(--app-height,100vh)] justify-center bg-bg-page">
      <div className="app-frame relative flex h-full w-full min-w-0 overflow-hidden bg-bg pr-(--sar) pl-(--sal) min-[680px]:max-w-[860px] min-[680px]:border-x min-[680px]:border-border min-[1024px]:max-w-[1160px]">
        <div
          className="safe-area-top absolute inset-x-0 top-0 z-(--z-safe-area) h-(--sat) bg-bg-page"
          aria-hidden="true"
        />
        <aside
          className="sidebar hidden min-[1024px]:flex min-[1024px]:w-[236px] min-[1024px]:min-w-[236px] min-[1024px]:flex-col min-[1024px]:border-r min-[1024px]:border-border min-[1024px]:bg-bg-hover min-[1024px]:pt-(--sat)"
          aria-label="Primary navigation"
        >
          <div className="flex flex-col px-[14px] pt-[18px] pb-4">
            <strong className="text-lg tracking-[-0.01em]">Journal</strong>
            <span className="pt-0.5 text-sm text-fg-mute">{dateCaption}</span>
          </div>
          <nav className="flex flex-col gap-0.5 px-2">
            {navItems.map((item) => (
              <button
                type="button"
                className={cn(
                  navItemClassName,
                  isActive(item.name) ? 'nav-item--active bg-bg-raised text-fg' : 'text-fg-body',
                )}
                aria-current={isActive(item.name) ? 'page' : undefined}
                aria-label={accessibleName(item)}
                key={item.name}
                onClick={() => navigate(item.name)}
              >
                <Icon name={item.icon} size={15} />
                <span className="min-w-0 flex-1">{item.label}</span>
                {item.name === 'activity' && hasActivity ? (
                  <span
                    className={cn(
                      'nav-item__count size-2 flex-none rounded-full',
                      isActive(item.name) ? 'bg-primary' : 'bg-border-strong',
                    )}
                    aria-hidden="true"
                  />
                ) : countFor(item.name) > 0 ? (
                  <Badge
                    variant={isActive(item.name) ? 'countActive' : 'count'}
                    className="nav-item__count flex-none"
                    aria-hidden="true"
                  >
                    {badgeLabel(countFor(item.name))}
                  </Badge>
                ) : null}
              </button>
            ))}
          </nav>
          <div className="mt-auto flex flex-col gap-0.5 border-t border-border px-2 pt-2.5 pb-3">
            <button
              className={cn(navItemClassName, 'text-fg-body')}
              type="button"
              onClick={onSearch}
            >
              <Icon name="search" size={15} />
              <span className="min-w-0 flex-1">Search</span>
              <kbd className="text-2xs text-fg-mute">⌘K</kbd>
            </button>
            <button
              className={cn(navItemClassName, 'text-fg-body')}
              type="button"
              onClick={onSettings}
            >
              <Icon name="settings" size={15} />
              <span className="min-w-0 flex-1">Settings</span>
            </button>
          </div>
        </aside>
        <div
          className="main-pane relative flex h-full w-full min-w-0 flex-col bg-bg pt-(--sat)"
          ref={paneRef}
        >
          <header className="app-header z-(--z-header) flex-none border-b border-border bg-bg">
            <div
              className={cn(
                contentColumn,
                'app-header__inner flex min-h-[59px] items-center justify-between gap-3 px-4 pt-[11px] pb-2 min-[1024px]:min-h-16 min-[1024px]:py-3',
              )}
            >
              <div className="min-w-0">
                <h1 className="app-header__desktop-title app-header__title overflow-hidden text-lg font-semibold tracking-[-0.01em] text-ellipsis whitespace-nowrap">
                  {title}
                </h1>
                <p className="app-header__subtitle overflow-hidden pt-0.5 text-sm text-fg-mute text-ellipsis whitespace-nowrap">
                  {subtitle}
                </p>
              </div>
              <div className="flex flex-none gap-2 min-[1024px]:hidden">
                <Button
                  variant="secondary"
                  size="icon"
                  className="text-fg-mid"
                  onClick={onSearch}
                  aria-label="Search entries"
                >
                  <Icon name="search" size={15} />
                </Button>
                <Button
                  variant="secondary"
                  size="icon"
                  className="text-fg-mid"
                  onClick={onSettings}
                  aria-label="Settings"
                >
                  <Icon name="settings" size={15} />
                </Button>
              </div>
            </div>
            <nav
              className="tab-list mx-auto mb-2.5 grid w-[calc(100%-26px)] max-w-(--content-width) grid-cols-4 gap-0.5 rounded-lg bg-bg-line p-[3px] min-[1024px]:hidden keyboard-open:hidden"
              aria-label="Primary navigation"
            >
              {navItems.map((item) => (
                <button
                  type="button"
                  className={cn(
                    tabClassName,
                    isActive(item.name)
                      ? 'tab--active bg-bg-raised text-fg'
                      : 'text-fg-mute hover:bg-bg-line hover:text-fg',
                  )}
                  aria-current={isActive(item.name) ? 'page' : undefined}
                  aria-label={accessibleName(item)}
                  key={item.name}
                  onClick={() => navigate(item.name)}
                >
                  {item.label}
                  {item.name === 'activity' && hasActivity ? (
                    <span
                      className={cn(
                        'tab__count size-2 flex-none rounded-full',
                        isActive(item.name) ? 'bg-primary' : 'bg-border-strong',
                      )}
                      aria-hidden="true"
                    />
                  ) : countFor(item.name) > 0 ? (
                    <Badge
                      variant={isActive(item.name) ? 'countActive' : 'count'}
                      className="tab__count flex-none"
                      aria-hidden="true"
                    >
                      {badgeLabel(countFor(item.name))}
                    </Badge>
                  ) : null}
                </button>
              ))}
            </nav>
            {showStatusStrip ? (
              <div
                className={cn(contentColumn, 'status-strip flex flex-wrap gap-1.5 px-4 pb-2')}
                aria-live="polite"
              >
                {connectionNotice ? (
                  connectionNotice.action && connectionNotice.onAction ? (
                    <Badge
                      asChild
                      variant={connectionNotice.variant}
                      className="min-h-8 touch:min-h-10"
                    >
                      <button type="button" onClick={connectionNotice.onAction}>
                        <Icon name={connectionNotice.icon} size={12} /> {connectionNotice.message}
                        <span className="font-semibold underline underline-offset-2">
                          {connectionNotice.action}
                        </span>
                      </button>
                    </Badge>
                  ) : (
                    <Badge variant={connectionNotice.variant}>
                      <Icon name={connectionNotice.icon} size={12} /> {connectionNotice.message}
                    </Badge>
                  )
                ) : null}
                {journalStatus.synchronization === 'syncing' ? (
                  <Badge variant="status">
                    <Icon name="refresh" size={12} /> Syncing
                    {journalStatus.pendingChanges > 0 ? ` ${pendingChanges}` : ''}
                  </Badge>
                ) : null}
                {showPending ? (
                  <Badge variant="status">
                    <Icon name="refresh" size={12} /> {pendingChanges}
                  </Badge>
                ) : null}
                {localSaveUnavailable ? (
                  <Badge asChild variant="statusError" className="min-h-8 touch:min-h-10">
                    <button type="button" onClick={onRetryLocalSave}>
                      <Icon name="warning" size={12} /> Local saving unavailable
                      {journalStatus.pendingChanges > 0 ? ` — ${pendingChanges}` : ''}
                      <span className="font-semibold underline underline-offset-2">
                        Retry saving
                      </span>
                    </button>
                  </Badge>
                ) : null}
                {journalStatus.failedChanges > 0 ? (
                  <Badge asChild variant="statusError" className="min-h-8 touch:min-h-10">
                    <button type="button" onClick={onOpenRecovery}>
                      <Icon name="warning" size={12} /> {journalStatus.failedChanges} change
                      {journalStatus.failedChanges === 1 ? '' : 's'} need attention
                      <span className="font-semibold underline underline-offset-2">
                        Open recovery
                      </span>
                    </button>
                  </Badge>
                ) : null}
                {updateReady ? (
                  <Badge asChild variant="status" className="min-h-8 touch:min-h-11">
                    <button type="button" onClick={onActivateUpdate}>
                      <Icon name="download" size={12} /> Update ready
                      <span className="font-semibold underline underline-offset-2">
                        Reload safely
                      </span>
                    </button>
                  </Badge>
                ) : null}
              </div>
            ) : null}
          </header>
          <main
            className="scrollable min-h-0 flex-1 bg-bg [scrollbar-gutter:stable] keyboard-open:pb-[var(--composer-height,88px)]"
            id="journal-content"
            tabIndex={-1}
          >
            <div className={contentColumn}>{children}</div>
          </main>
          {composer}
        </div>
      </div>
    </div>
  );
}
