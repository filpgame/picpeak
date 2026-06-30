/**
 * Coverage for the upload failure report — the "which files failed" list.
 *
 * Before this, a partial upload only showed a count ("some files failed"),
 * and the backend's per-file `errors[]` were dropped entirely. These tests
 * pin that every failure stage is now named with its reason:
 *   - rejected:   from the upload response's `errors: [{filename, error}]`
 *   - processing: from useUploadProgress's `failedPhotos`
 * and that the report can be dismissed.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';

import { PhotoUpload } from '../PhotoUpload';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (_key: string, fallback?: any) => (typeof fallback === 'string' ? fallback : _key),
    }),
  };
});

vi.mock('react-toastify', () => ({
  toast: { warning: vi.fn(), info: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

// The upload POST: 202 Accepted, one file queued, one rejected per-file.
const postMock = vi.fn().mockResolvedValue({
  data: {
    successCount: 1,
    upload_id: 'u1',
    errors: [{ filename: 'too-big.png', error: 'File too large' }],
  },
});
vi.mock('../../../config/api', () => ({ api: { post: (...a: any[]) => postMock(...a), get: vi.fn() } }));

// One photo failed in the background worker.
vi.mock('../../../hooks/useUploadProgress', () => ({
  useUploadProgress: () => ({
    snapshots: {},
    error: null,
    aggregate: {
      total: 2, pending: 0, processing: 0, complete: 1, failed: 1,
      failedPhotos: [{ id: 5, filename: 'corrupt.jpg', error: 'Unsupported format' }],
      isComplete: true, isReady: true,
    },
  }),
}));

vi.mock('../../../services/categories.service', () => ({
  categoriesService: { getEventCategories: vi.fn().mockResolvedValue([]) },
}));
vi.mock('../../../services/settings.service', () => ({
  settingsService: { getAllSettings: vi.fn().mockResolvedValue({}) },
}));

const renderWithClient = (ui: ReactElement) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
};

async function uploadOneFile(container: HTMLElement, user: ReturnType<typeof userEvent.setup>) {
  const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
  await user.upload(fileInput, new File([new Uint8Array([1, 2, 3])], 'too-big.png', { type: 'image/png' }));
  await user.click(screen.getByRole('button', { name: /common\.upload/ }));
}

describe('PhotoUpload failure report', () => {
  beforeEach(() => postMock.mockClear());
  afterEach(() => vi.clearAllMocks());

  it('names each failed file with its reason and failure stage', async () => {
    const user = userEvent.setup();
    const { container } = renderWithClient(<PhotoUpload eventId={1} />);

    await uploadOneFile(container, user);

    const report = await screen.findByTestId('upload-failure-report');

    // Rejected file (from the response errors[] that used to be dropped)
    expect(within(report).getByText('too-big.png')).toBeInTheDocument();
    expect(within(report).getByText(/File too large/)).toBeInTheDocument();
    expect(within(report).getByText('Rejected')).toBeInTheDocument();

    // Processing failure (from useUploadProgress.failedPhotos)
    expect(within(report).getByText('corrupt.jpg')).toBeInTheDocument();
    expect(within(report).getByText(/Unsupported format/)).toBeInTheDocument();
    expect(within(report).getByText('Processing failed')).toBeInTheDocument();
  });

  it('can be dismissed', async () => {
    const user = userEvent.setup();
    const { container } = renderWithClient(<PhotoUpload eventId={1} />);

    await uploadOneFile(container, user);
    const report = await screen.findByTestId('upload-failure-report');

    await user.click(within(report).getByRole('button', { name: /Dismiss/i }));
    expect(screen.queryByTestId('upload-failure-report')).not.toBeInTheDocument();
  });
});
