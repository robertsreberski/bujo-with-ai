import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { useChromeGeometry } from '../hooks/use-chrome-geometry';
import type { JournalRoute } from '../routes/useJournalRoute';
import { Icon, type IconName } from './Icon';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { formatLongDate } from './dates';

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
    <div className="app-viewport">
      <div className="app-frame">
        <div className="safe-area-top" aria-hidden="true" />
        <aside className="sidebar" aria-label="Primary navigation">
          <div className="sidebar__brand">
            <strong>Journal</strong>
            <span>{dateCaption}</span>
          </div>
          <nav className="sidebar__nav">
            {navItems.map((item) => (
              <button
                type="button"
                className={`nav-item${isActive(item.name) ? ' nav-item--active' : ''}`}
                aria-current={isActive(item.name) ? 'page' : undefined}
                key={item.name}
                onClick={() => navigate(item.name)}
              >
                <Icon name={item.icon} size={15} />
                <span>{item.label}</span>
              </button>
            ))}
          </nav>
          <div className="sidebar__utilities">
            <button className="nav-item" type="button" onClick={onSearch}>
              <Icon name="search" size={15} />
              <span>Search</span>
              <kbd>⌘K</kbd>
            </button>
            <button className="nav-item" type="button" onClick={onSettings}>
              <Icon name="settings" size={15} />
              <span>Assistant access</span>
            </button>
          </div>
        </aside>
        <div className="main-pane" ref={paneRef}>
          <header className="app-header">
            <div className="app-header__top content-column">
              <div className="app-header__copy">
                <h1 className="app-header__desktop-title">{title}</h1>
                <h1 className="app-header__mobile-title">Journal</h1>
                <p className="app-header__desktop-title">{subtitle}</p>
                <p className="app-header__mobile-title">{mobileSubtitle}</p>
              </div>
              <div className="app-header__actions">
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
            <nav className="tab-list content-column" aria-label="Primary navigation">
              {navItems.map((item) => (
                <button
                  type="button"
                  className={`tab${isActive(item.name) ? ' tab--active' : ''}`}
                  aria-current={isActive(item.name) ? 'page' : undefined}
                  key={item.name}
                  onClick={() => navigate(item.name)}
                >
                  {item.label}
                </button>
              ))}
            </nav>
            {!online || syncing || deadLetterCount > 0 ? (
              <div className="status-strip content-column" aria-live="polite">
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
          <main className="app-main scrollable" id="journal-content" tabIndex={-1}>
            <div className="content-column">{children}</div>
          </main>
          {composer}
        </div>
      </div>
    </div>
  );
}
