import { beforeEach, describe, expect, it, vi } from 'vitest';

const { post } = vi.hoisted(() => ({ post: vi.fn() }));

vi.mock('../../config/api', () => ({ api: { post } }));

import { eventsService } from '../events.service';

describe('eventsService.resendCreationEmail', () => {
  beforeEach(() => {
    post.mockReset();
    post.mockResolvedValue({ data: { success: true, message: 'queued' } });
  });

  it('posts a manually supplied legacy password', async () => {
    await eventsService.resendCreationEmail(7, 'LegacyPass123!');

    expect(post).toHaveBeenCalledWith(
      '/admin/events/7/resend-email',
      { password: 'LegacyPass123!' },
    );
  });

  it('posts an empty body when no manual password is needed', async () => {
    await eventsService.resendCreationEmail(7);

    expect(post).toHaveBeenCalledWith('/admin/events/7/resend-email', {});
  });
});