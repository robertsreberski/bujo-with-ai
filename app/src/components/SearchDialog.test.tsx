// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SearchDialog } from './SearchDialog';

afterEach(cleanup);

describe('SearchDialog', () => {
  it('labels a failed full search as downloaded-only instead of an authoritative empty result', async () => {
    const onSearch = vi.fn().mockRejectedValue(new Error('Offline'));
    render(
      <SearchDialog
        entries={[]}
        preferences={{ density: 'comfortable', showTypeBadges: true, highlightAiEntries: true }}
        initialQuery="missing"
        onSearch={onSearch}
        onClose={vi.fn()}
        onOpenEntry={vi.fn()}
        onToggleEntry={vi.fn()}
      />,
    );

    expect(screen.getByText('Searching the full journal…')).toBeInTheDocument();
    expect(
      await screen.findByText('Search unavailable — showing downloaded entries.'),
    ).toBeInTheDocument();
    expect(onSearch).toHaveBeenCalledWith('missing');
    expect(screen.queryByText(/^No entries match/)).not.toBeInTheDocument();
    expect(screen.getByText('No downloaded entries match “missing”.')).toBeInTheDocument();
  });
});
