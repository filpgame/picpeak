/**
 * A multi-batch upload settles only after the LAST batch has been sent.
 *
 * The completion effect watched the processing aggregate of the upload IDs
 * collected so far. With many photos, batch 1 finished processing while
 * batch 2 was still on the wire, so the aggregate read "complete", the upload
 * settled, and the modal closed. handleUpload kept sending the remaining
 * batches with no UI left to show it.
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';

import { PhotoUpload } from '../PhotoUpload';

vi.mock('react-toastify', () => ({
  toast: { warning: vi.fn(), info: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

const postMock = vi.fn();
vi.mock('../../../config/api', () => ({ api: { post: (...a: any[]) => postMock(...a), get: vi.fn() } }));

// The worker is faster than the next batch's transfer: an upload ID reads as
// fully processed as soon as the tracker has been enabled for it once. Like
// the real hook, it learns nothing about IDs while disabled.
const tracker = vi.hoisted(() => ({
  calls: [] as { ids: string[]; enabled?: boolean }[],
  polled: new Set<string>(),
}));
vi.mock('../../../hooks/useUploadProgress', () => ({
  useUploadProgress: (ids: string[], opts: { enabled?: boolean } = {}) => {
    tracker.calls.push({ ids: [...ids], enabled: opts.enabled });
    if (opts.enabled) ids.forEach((id) => tracker.polled.add(id));
    const done = ids.filter((id) => tracker.polled.has(id)).length;
    return {
      snapshots: {},
      error: null,
      aggregate: {
        total: ids.length, pending: ids.length - done, processing: 0, complete: done, failed: 0,
        failedPhotos: [], isComplete: ids.length > 0 && done === ids.length, isReady: done === ids.length,
      },
    };
  },
}));

vi.mock('../../../services/categories.service', () => ({
  categoriesService: { getEventCategories: vi.fn().mockResolvedValue([]) },
}));
// A 4-byte batch cap puts each 3-byte test file in its own batch.
const getAllSettings = vi.hoisted(() => vi.fn());
vi.mock('../../../services/settings.service', () => ({ settingsService: { getAllSettings } }));

const renderWithClient = (ui: ReactElement) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
};

// axios reports the body fully sent before the response arrives; that is what
// flips the component into its 'processing' phase.
const sent = (data: unknown) => (_url: string, _body: unknown, config: any) => {
  config?.onUploadProgress?.({ loaded: 1, total: 1 });
  return Promise.resolve({ data });
};

const makeFile = (name: string) =>
  new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' });

async function startUpload(names: string[]) {
  const user = userEvent.setup();
  const onUploadSettled = vi.fn();
  const { container } = renderWithClient(<PhotoUpload eventId={1} onUploadSettled={onUploadSettled} />);
  // Let the settings query land so the tiny batch cap is in effect.
  await waitFor(() => expect(getAllSettings).toHaveBeenCalled());
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
  await user.upload(fileInput, names.map(makeFile));
  await user.click(screen.getByRole('button', { name: /^Upload \d/ }));
  return { onUploadSettled };
}

describe('PhotoUpload multi-batch completion', () => {
  beforeEach(() => {
    postMock.mockReset();
    getAllSettings.mockResolvedValue({ general_max_upload_batch_size_mb: 4 / (1024 * 1024) });
    tracker.calls.length = 0;
    tracker.polled.clear();
  });
  afterEach(() => vi.clearAllMocks());

  it('does not settle while a later batch is still uploading', async () => {
    let finishSecond!: (value: unknown) => void;
    postMock
      .mockImplementationOnce(sent({ count: 1, upload_id: 'u1', errors: [] }))
      .mockImplementationOnce((_url: string, _body: unknown, config: any) => {
        config?.onUploadProgress?.({ loaded: 1, total: 1 });
        return new Promise((resolve) => { finishSecond = resolve; });
      });

    const { onUploadSettled } = await startUpload(['a.png', 'b.png']);

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(2));
    // Batch 1 is fully processed, batch 2 is still in flight.
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(onUploadSettled).not.toHaveBeenCalled();

    await act(async () => {
      finishSecond({ data: { count: 1, upload_id: 'u2', errors: [] } });
    });

    await waitFor(() => expect(onUploadSettled).toHaveBeenCalledTimes(1));
    expect(onUploadSettled).toHaveBeenCalledWith({ hasFailures: false });
  });

  it('tracks processing even when the last batch failed in transfer', async () => {
    // The last batch dies mid-transfer, leaving the phase on 'transferring'.
    // The tracker must still run for the batches that did land, or the
    // upload never settles.
    postMock
      .mockImplementationOnce(sent({ count: 1, upload_id: 'u1', errors: [] }))
      .mockImplementationOnce((_url: string, _body: unknown, config: any) => {
        config?.onUploadProgress?.({ loaded: 1, total: 2 });
        return Promise.reject({ response: { data: { error: 'Request Timeout' } } });
      });

    const { onUploadSettled } = await startUpload(['a.png', 'b.png']);

    await waitFor(() => expect(onUploadSettled).toHaveBeenCalledWith({ hasFailures: true }));
    expect(tracker.calls.some((c) => c.enabled && c.ids.includes('u1'))).toBe(true);
    expect(await screen.findByTestId('upload-failure-report')).toBeTruthy();
  });
});
