import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { useChromeGeometry } from '../hooks/use-chrome-geometry';
import type { JournalRoute } from '../routes/useJournalRoute';
import { Icon, type IconName } from './Icon';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { formatLongDate } from './dates';
import { cn } from '../lib/utils';

interface ShellProps {
  route: JournalRoute;
  today: string;
  dayCount: number;
  online: boolean;
  syncing: boolean;
  outboxCount: number;
  deadLetterCount: number;
  title: string;
  subtitle: string;
  children: ReactNode;
  composer: ReactNode;
  onNavigate: (route: JournalRoute) => void;
  onSearch: () => void;
  onSettings: () => void;
  onDeadLetters: () => void;
}

const navItems: Array<{
  name: 'today' | 'month' | 'index' | 'review';
  label: string;
  icon: IconName;
}> = [
  { name: 'today', label: 'Today', icon: 'check' },
  { name: 'month', label: 'Month', icon: 'calendar' },
  { name: 'index', label: 'Index', icon: 'folder' },
  { name: 'review', label: 'Review', icon: 'sparkle' },
];

/** The 720px reading measure the header, tabs, status strip, and content share. */
const contentColumn = 'mx-auto w-full max-w-(--content-width)';

/* DS-14 chrome density: 34px sidebar rows and 30px tab segments, both inflated
   to the 40px coarse-pointer minimum through the `touch:` variant. */
const navItemClassName =
  'flex h-[34px] items-center gap-[9px] rounded-md px-[9px] text-left text-md hover:bg-bg-line hover:text-fg touch:min-h-10';
const tabClassName = 'h-[30px] min-w-0 rounded-md text-sm font-medium touch:min-h-10';

export function Shell({
  route,
  today,
  dayCount,
  online,
  syncing,
  outboxCount,
  deadLetterCount,
  title,
  subtitle,
  children,
  composer,
  onNavigate,
  onSearch,
  onSettings,
  onDeadLetters,
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

  const isActive = (name: (typeof navItems)[number]['name']) =>
    name === route.name || (name === 'index' && route.name === 'collection');
  const navigate = (name: (typeof navItems)[number]['name']) => {
    if (name === 'today') onNavigate({ name: 'today', date: null });
    else if (name === 'month') onNavigate({ name: 'month', month: null });
    else onNavigate({ name });
  };
  const dateCaption = formatLongDate(today);
  const mobileSubtitle = `${dateCaption} · ${dayCount} ${dayCount === 1 ? 'day' : 'days'} logged`;

  return (
    <div className="flex h-[var(--app-height,100vh)] justify-center bg-bg-page">
      <div className="app-frame relative flex h-full w-full min-w-0 overflow-hidden bg-bg pr-(--sar) pl-(--sal) min-[680px]:max-w-[560px] min-[680px]:border-x min-[680px]:border-border min-[1024px]:max-w-[1160px]">
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
                key={item.name}
                onClick={() => navigate(item.name)}
              >
                <Icon name={item.icon} size={15} />
                <span className="min-w-0 flex-1">{item.label}</span>
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
              <span className="min-w-0 flex-1">Assistant access</span>
            </button>
          </div>
        </aside>
        <div
          className="main-pane relative flex h-full w-full min-w-0 flex-col bg-bg pt-(--sat)"
          ref={paneRef}
        >
          <header className="z-(--z-header) flex-none border-b border-border bg-bg">
            <div
              className={cn(
                contentColumn,
                'flex min-h-[59px] items-center justify-between gap-3 px-4 pt-[11px] pb-2 min-[1024px]:min-h-16 min-[1024px]:py-3',
              )}
            >
              <div className="min-w-0">
                <h1 className="app-header__desktop-title hidden overflow-hidden text-lg font-semibold tracking-[-0.01em] text-ellipsis whitespace-nowrap min-[1024px]:block">
                  {title}
                </h1>
                <h1 className="overflow-hidden text-lg font-semibold tracking-[-0.01em] text-ellipsis whitespace-nowrap min-[1024px]:hidden">
                  Journal
                </h1>
                <p className="app-header__desktop-title hidden overflow-hidden pt-0.5 text-sm text-fg-mute text-ellipsis whitespace-nowrap min-[1024px]:block">
                  {subtitle}
                </p>
                <p className="overflow-hidden pt-0.5 text-sm text-fg-mute text-ellipsis whitespace-nowrap min-[1024px]:hidden">
                  {mobileSubtitle}
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
                  aria-label="Assistant access"
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
                  key={item.name}
                  onClick={() => navigate(item.name)}
                >
                  {item.label}
                </button>
              ))}
            </nav>
            {!online || syncing || deadLetterCount > 0 ? (
              <div
                className={cn(contentColumn, 'status-strip flex flex-wrap gap-1.5 px-4 pb-2')}
                aria-live="polite"
              >
                {!online ? (
                  <Badge variant="statusOffline">
                    <Icon name="wifiOff" size={12} /> Offline — changes will sync
                  </Badge>
                ) : syncing || outboxCount > 0 ? (
                  <Badge variant="status">
                    <Icon name="refresh" size={12} /> Syncing{' '}
                    {outboxCount > 0 ? `${outboxCount} changes` : ''}
                  </Badge>
                ) : null}
                {deadLetterCount > 0 ? (
                  <Badge asChild variant="statusError" className="min-h-8 touch:min-h-10">
                    <button type="button" onClick={onDeadLetters}>
                      <Icon name="warning" size={12} /> {deadLetterCount} change
                      {deadLetterCount === 1 ? '' : 's'} need attention
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
