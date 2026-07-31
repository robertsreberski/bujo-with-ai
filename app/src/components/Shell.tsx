import type { ReactNode } from 'react';
import type { JournalRoute } from '../routes/useJournalRoute';
import { Icon, type IconName } from './Icon';
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
        <div className="main-pane">
          <header className="app-header">
            <div className="app-header__top content-column">
              <div className="app-header__copy">
                <h1 className="app-header__desktop-title">{title}</h1>
                <h1 className="app-header__mobile-title">Journal</h1>
                <p className="app-header__desktop-title">{subtitle}</p>
                <p className="app-header__mobile-title">{mobileSubtitle}</p>
              </div>
              <div className="app-header__actions">
                <button
                  className="icon-button"
                  type="button"
                  onClick={onSearch}
                  aria-label="Search entries"
                >
                  <Icon name="search" size={15} />
                </button>
                <button
                  className="icon-button"
                  type="button"
                  onClick={onSettings}
                  aria-label="Assistant access"
                >
                  <Icon name="settings" size={15} />
                </button>
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
                  <span className="status-pill status-pill--offline">
                    <Icon name="wifiOff" size={12} /> Offline — changes will sync
                  </span>
                ) : syncing || outboxCount > 0 ? (
                  <span className="status-pill">
                    <Icon name="refresh" size={12} /> Syncing{' '}
                    {outboxCount > 0 ? `${outboxCount} changes` : ''}
                  </span>
                ) : null}
                {deadLetterCount > 0 ? (
                  <button
                    className="status-pill status-pill--error"
                    type="button"
                    onClick={onDeadLetters}
                  >
                    <Icon name="warning" size={12} /> {deadLetterCount} change
                    {deadLetterCount === 1 ? '' : 's'} need attention
                  </button>
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
