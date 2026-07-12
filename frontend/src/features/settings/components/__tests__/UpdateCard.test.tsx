import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UpdateCard } from '../UpdateCard';
import * as useUpdateCardModule from '../../hooks/useUpdateCard';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, opts?: Record<string, unknown>) => {
        if (opts?.version) return `${key}:${opts.version}`;
        if (opts?.time) return `${key}:${opts.time}`;
        return key;
      },
    }),
  };
});

vi.mock('../../hooks/useUpdateCard');

const mockUseUpdateCard = vi.mocked(useUpdateCardModule.useUpdateCard);

const triggerUpdate = vi.fn();
const checkAgain = vi.fn();

function setupHook(state: useUpdateCardModule.UpdatePhase) {
  mockUseUpdateCard.mockReturnValue({ state, triggerUpdate, checkAgain });
}

describe('UpdateCard', () => {
  beforeEach(() => {
    triggerUpdate.mockReset();
    checkAgain.mockReset();
  });

  it('renders up-to-date state', () => {
    setupHook({ phase: 'idle', current: '4.1.2-beta.0', channel: 'beta', lastChecked: '2026-05-30T00:00:00Z' });
    render(<UpdateCard />);
    expect(screen.getByText('admin.updates.card.upToDate')).toBeInTheDocument();
    expect(screen.getByText('admin.updates.card.checkAgain')).toBeInTheDocument();
  });

  it('renders update-available state with update button', () => {
    setupHook({ phase: 'update-available', current: '4.1.2-beta.0', latest: '4.1.3-beta.0', channel: 'beta', lastChecked: '2026-05-30T00:00:00Z' });
    render(<UpdateCard />);
    expect(screen.getByText(/admin.updates.card.updateTo/)).toBeInTheDocument();
    expect(screen.getByText('admin.updates.card.checkAgain')).toBeInTheDocument();
  });

  it('calls triggerUpdate when update button is clicked', async () => {
    setupHook({ phase: 'update-available', current: '4.1.2-beta.0', latest: '4.1.3-beta.0', channel: 'beta', lastChecked: '2026-05-30T00:00:00Z' });
    render(<UpdateCard />);
    await userEvent.click(screen.getByText(/admin.updates.card.updateTo/));
    expect(triggerUpdate).toHaveBeenCalledOnce();
  });

  it('renders updating state with disabled spinner button', () => {
    setupHook({ phase: 'updating', targetVersion: '4.1.3-beta.0' });
    render(<UpdateCard />);
    expect(screen.getByText('admin.updates.card.updating')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /admin.updates.card.updating/ })).toBeDisabled();
  });

  it('renders restarting state', () => {
    setupHook({ phase: 'restarting', targetVersion: '4.1.3-beta.0' });
    render(<UpdateCard />);
    expect(screen.getByText('admin.updates.card.restarting')).toBeInTheDocument();
  });

  it('renders complete state', () => {
    setupHook({ phase: 'complete', version: '4.1.3-beta.0' });
    render(<UpdateCard />);
    expect(screen.getByText(/admin.updates.card.complete/)).toBeInTheDocument();
  });

  it('renders error state with log download links', () => {
    setupHook({ phase: 'error' });
    render(<UpdateCard />);
    expect(screen.getByText('admin.updates.card.errorTitle')).toBeInTheDocument();
    expect(screen.getByText('admin.updates.card.downloadCombinedLog')).toBeInTheDocument();
    expect(screen.getByText('admin.updates.card.downloadErrorLog')).toBeInTheDocument();
  });

  it('log download links point to correct API paths', () => {
    setupHook({ phase: 'error' });
    render(<UpdateCard />);
    const combinedLink = screen.getByText('admin.updates.card.downloadCombinedLog').closest('a');
    const errorLink = screen.getByText('admin.updates.card.downloadErrorLog').closest('a');
    // buildResourceUrl prepends origin in jsdom (http://localhost:3000)
    expect(combinedLink?.getAttribute('href')).toContain('/api/admin/system/logs/download?type=combined');
    expect(errorLink?.getAttribute('href')).toContain('/api/admin/system/logs/download?type=error');
  });

  it('calls checkAgain when "check again" is clicked', async () => {
    setupHook({ phase: 'idle', current: '4.1.2-beta.0', channel: 'beta', lastChecked: '2026-05-30T00:00:00Z' });
    render(<UpdateCard />);
    await userEvent.click(screen.getByText('admin.updates.card.checkAgain'));
    expect(checkAgain).toHaveBeenCalledOnce();
  });

  it('retry button calls triggerUpdate', async () => {
    setupHook({ phase: 'error' });
    render(<UpdateCard />);
    await userEvent.click(screen.getByText('admin.updates.card.retry'));
    expect(triggerUpdate).toHaveBeenCalledOnce();
  });
});
