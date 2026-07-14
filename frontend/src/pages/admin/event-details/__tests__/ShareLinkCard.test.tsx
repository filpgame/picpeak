import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Event } from '../../../../types';
import { ShareLinkCard } from '../ShareLinkCard';

const { resendCreationEmail, success, error } = vi.hoisted(() => ({
  resendCreationEmail: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../../../services/events.service', () => ({
  eventsService: { resendCreationEmail },
}));
vi.mock('react-toastify', () => ({ toast: { success, error } }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback || key,
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

const buildEvent = (overrides: Partial<Event> = {}): Event => ({
  id: 7,
  event_name: 'Test event',
  share_link: '/gallery/test',
  require_password: true,
  is_archived: false,
  ...overrides,
} as Event);

describe('ShareLinkCard resend email', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resendCreationEmail.mockResolvedValue({ success: true, message: 'queued' });
  });

  it('asks for a manual password for legacy protected events', async () => {
    const user = userEvent.setup();
    render(<ShareLinkCard event={buildEvent()} setShowPasswordReset={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'events.resendCreationEmail' }));
    await user.type(screen.getByLabelText('Gallery password (optional)'), 'LegacyPass123!');
    await user.click(screen.getByRole('button', { name: 'Send email' }));

    expect(resendCreationEmail).toHaveBeenCalledWith(7, 'LegacyPass123!');
  });

  it('does not render a password input when ciphertext is available', async () => {
    const user = userEvent.setup();
    render(
      <ShareLinkCard
        event={buildEvent({ has_encrypted_password: true })}
        setShowPasswordReset={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'events.resendCreationEmail' }));

    expect(screen.queryByLabelText('Gallery password (optional)')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Send email' }));
    expect(resendCreationEmail).toHaveBeenCalledWith(7, undefined);
  });
});