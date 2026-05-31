import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useUpdateCard } from '../useUpdateCard';
import { api } from '../../../../config/api';

vi.mock('../../../../config/api', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

const apiGet = vi.mocked(api.get);
const apiPost = vi.mocked(api.post);

function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, Wrapper };
}

const UP_TO_DATE_RESPONSE = {
  data: {
    enabled: true,
    updateAvailable: false,
    current: '4.1.2-beta.0',
    channel: 'beta',
    lastChecked: '2026-05-30T00:00:00.000Z',
    latest: { stable: '4.1.2', beta: '4.1.2-beta.0', forChannel: '4.1.2-beta.0' },
  },
};

const UPDATE_AVAILABLE_RESPONSE = {
  data: {
    enabled: true,
    updateAvailable: true,
    current: '4.1.2-beta.0',
    channel: 'beta',
    lastChecked: '2026-05-30T00:00:00.000Z',
    latest: { stable: '4.1.2', beta: '4.1.3-beta.0', forChannel: '4.1.3-beta.0' },
  },
};

describe('useUpdateCard', () => {
  beforeEach(() => {
    apiGet.mockReset();
    apiPost.mockReset();
    // Fake timers but NOT Date — avoids React Query stale-time issues
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts in loading phase before query resolves', () => {
    apiGet.mockReturnValue(new Promise(() => {})); // never resolves
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useUpdateCard(), { wrapper: Wrapper });
    expect(result.current.state.phase).toBe('loading');
  });

  it('transitions to disabled when update checking is disabled', async () => {
    apiGet.mockResolvedValue({ data: { enabled: false, message: 'Update checking is disabled' } });
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useUpdateCard(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.state.phase).toBe('disabled'));
  });

  it('transitions to idle when no update is available', async () => {
    apiGet.mockResolvedValue(UP_TO_DATE_RESPONSE);
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useUpdateCard(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.state.phase).toBe('idle'));

    const s = result.current.state as { phase: string; current: string; channel: string };
    expect(s.current).toBe('4.1.2-beta.0');
    expect(s.channel).toBe('beta');
  });

  it('transitions to update-available when a newer version exists', async () => {
    apiGet.mockResolvedValue(UPDATE_AVAILABLE_RESPONSE);
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useUpdateCard(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.state.phase).toBe('update-available'));

    const s = result.current.state as { phase: string; latest: string };
    expect(s.latest).toBe('4.1.3-beta.0');
  });

  it('transitions to updating immediately when triggerUpdate is called', async () => {
    apiGet.mockResolvedValue(UPDATE_AVAILABLE_RESPONSE);
    apiPost.mockResolvedValue({ data: { status: 'started' } });

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useUpdateCard(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.state.phase).toBe('update-available'));

    act(() => {
      result.current.triggerUpdate();
    });

    expect(result.current.state.phase).toBe('updating');
    expect(apiPost).toHaveBeenCalledWith('/admin/system/updates/apply');
  });

  it('transitions to restarting after 10 seconds', async () => {
    apiGet.mockResolvedValue(UPDATE_AVAILABLE_RESPONSE);
    apiPost.mockResolvedValue({ data: { status: 'started' } });

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useUpdateCard(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.state.phase).toBe('update-available'));

    act(() => {
      result.current.triggerUpdate();
    });
    expect(result.current.state.phase).toBe('updating');

    await act(async () => {
      vi.advanceTimersByTime(10_001);
    });

    expect(result.current.state.phase).toBe('restarting');
  });

  it('transitions to error after 3 minute timeout', async () => {
    // Version endpoint always throws (server stays down)
    apiGet.mockImplementation((url) => {
      if (url === '/admin/system/updates') return Promise.resolve(UPDATE_AVAILABLE_RESPONSE);
      return Promise.reject(new Error('connection refused'));
    });
    apiPost.mockResolvedValue({ data: { status: 'started' } });

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useUpdateCard(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.state.phase).toBe('update-available'));

    act(() => { result.current.triggerUpdate(); });

    await act(async () => {
      vi.advanceTimersByTime(3 * 60 * 1000 + 1);
    });

    await waitFor(() => expect(result.current.state.phase).toBe('error'));
  });

  it('sets error phase if POST returns non-409 error', async () => {
    apiGet.mockResolvedValue(UPDATE_AVAILABLE_RESPONSE);
    apiPost.mockRejectedValue({ response: { status: 500 } });

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useUpdateCard(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.state.phase).toBe('update-available'));

    // triggerUpdate is synchronous — state becomes 'updating' immediately,
    // then transitions to 'error' once the fire-and-forget POST rejects
    act(() => { result.current.triggerUpdate(); });
    expect(result.current.state.phase).toBe('updating');
    await waitFor(() => expect(result.current.state.phase).toBe('error'));
  });

  it('cleans up timers on unmount', async () => {
    apiGet.mockResolvedValue(UPDATE_AVAILABLE_RESPONSE);
    apiPost.mockResolvedValue({ data: { status: 'started' } });

    const { Wrapper } = makeWrapper();
    const { result, unmount } = renderHook(() => useUpdateCard(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.state.phase).toBe('update-available'));

    act(() => { result.current.triggerUpdate(); });
    unmount();

    // Advancing timers after unmount should not throw
    expect(() => act(() => { vi.advanceTimersByTime(15_000); })).not.toThrow();
  });
});
