import { useState, useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../config/api';

export type UpdatePhase =
  | { phase: 'loading' }
  | { phase: 'disabled' }
  | { phase: 'idle'; current: string; channel: string; lastChecked: string }
  | { phase: 'update-available'; current: string; latest: string; channel: string; lastChecked: string }
  | { phase: 'updating'; targetVersion: string }
  | { phase: 'restarting'; targetVersion: string }
  | { phase: 'complete'; version: string }
  | { phase: 'error' };

async function fetchUpdateInfo() {
  const res = await api.get('/admin/system/updates');
  return res.data;
}

async function fetchVersion() {
  const res = await api.get('/admin/system/version');
  return res.data;
}

export function useUpdateCard() {
  const queryClient = useQueryClient();
  const [state, setState] = useState<UpdatePhase>({ phase: 'loading' });
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const transitionRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { data: updateInfo, refetch } = useQuery({
    queryKey: ['update-check'],
    queryFn: fetchUpdateInfo,
    staleTime: 60 * 60 * 1000,
    retry: false,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (!updateInfo) return;
    setState((prev) => {
      if (
        prev.phase === 'updating' ||
        prev.phase === 'restarting' ||
        prev.phase === 'complete' ||
        prev.phase === 'error'
      ) return prev;

      if (updateInfo.enabled === false) {
        return { phase: 'disabled' };
      }

      if (updateInfo.updateAvailable) {
        return {
          phase: 'update-available',
          current: updateInfo.current,
          latest: updateInfo.latest?.forChannel,
          channel: updateInfo.channel,
          lastChecked: updateInfo.lastChecked,
        };
      }
      return {
        phase: 'idle',
        current: updateInfo.current,
        channel: updateInfo.channel,
        lastChecked: updateInfo.lastChecked,
      };
    });
  }, [updateInfo]);

  function clearTimers() {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (transitionRef.current) { clearTimeout(transitionRef.current); transitionRef.current = null; }
    if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
  }

  useEffect(() => () => clearTimers(), []);

  function triggerUpdate() {
    const targetVersion = updateInfo?.latest?.forChannel ?? '';
    setState({ phase: 'updating', targetVersion });

    api.post('/admin/system/updates/apply').catch((err: unknown) => {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status !== 409) {
        clearTimers();
        setState({ phase: 'error' });
        return;
      }
    });

    transitionRef.current = setTimeout(() => {
      setState({ phase: 'restarting', targetVersion });
    }, 10_000);

    // Overall 3-minute hard timeout — fires if server never comes back up
    timeoutRef.current = setTimeout(() => {
      clearTimers();
      setState({ phase: 'error' });
    }, 3 * 60 * 1000);

    pollRef.current = setInterval(async () => {
      try {
        const data = await fetchVersion();
        if (data.backend === targetVersion) {
          clearTimers();
          setState({ phase: 'complete', version: targetVersion });
          setTimeout(() => window.location.reload(), 2000);
        }
      } catch {
        // Server still restarting — keep polling
      }
    }, 3_000);
  }

  function checkAgain() {
    queryClient.invalidateQueries({ queryKey: ['update-check'] });
    refetch();
  }

  return { state, triggerUpdate, checkAgain };
}
