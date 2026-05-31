import React from 'react';
import { ArrowUpCircle, RefreshCw, Download, CheckCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Card } from '../../../components/common';
import { buildResourceUrl } from '../../../utils/url';
import { useUpdateCard } from '../hooks/useUpdateCard';

export const UpdateCard: React.FC = () => {
  const { t } = useTranslation();
  const { state, triggerUpdate, checkAgain } = useUpdateCard();

  if (state.phase === 'disabled') return null;

  const channelBadge =
    ('channel' in state && state.channel === 'beta') ? (
      <span className="ml-1 px-1.5 py-0.5 text-xs bg-amber-100 text-amber-700 rounded font-bold">
        BETA
      </span>
    ) : null;

  return (
    <Card padding="md">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 flex items-center gap-2">
          <ArrowUpCircle className="w-5 h-5" />
          {t('admin.updates.card.title')}
          {channelBadge}
        </h2>

        {state.phase === 'update-available' && (
          <button
            onClick={triggerUpdate}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-colors"
          >
            <ArrowUpCircle className="w-4 h-4" />
            {t('admin.updates.card.updateTo', { version: `v${state.latest}` })}
          </button>
        )}

        {(state.phase === 'updating' || state.phase === 'restarting') && (
          <button
            disabled
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-neutral-400 bg-neutral-100 dark:bg-neutral-700 rounded-lg cursor-not-allowed"
          >
            <RefreshCw className="w-4 h-4 animate-spin" />
            {state.phase === 'updating'
              ? t('admin.updates.card.updating')
              : t('admin.updates.card.restarting')}
          </button>
        )}

        {state.phase === 'error' && (
          <button
            onClick={triggerUpdate}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-colors"
          >
            {t('admin.updates.card.retry')}
          </button>
        )}
      </div>

      {(state.phase === 'idle' || state.phase === 'update-available') && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-neutral-600 dark:text-neutral-400 mb-3">
          <span>
            v<span className="font-semibold text-neutral-900 dark:text-neutral-100">{state.current}</span>
          </span>
          {state.phase === 'update-available' && (
            <>
              <span className="text-indigo-500 font-bold">→</span>
              <span className="text-indigo-600 dark:text-indigo-400 font-semibold">
                v{state.latest}
              </span>
            </>
          )}
        </div>
      )}

      {state.phase === 'idle' && (
        <div className="flex items-center gap-2 text-sm text-green-700 dark:text-green-400">
          <CheckCircle className="w-4 h-4" />
          <span>{t('admin.updates.card.upToDate')}</span>
        </div>
      )}

      {state.phase === 'updating' && (
        <div className="p-3 bg-blue-50 dark:bg-blue-900/30 rounded-lg text-sm text-blue-800 dark:text-blue-200">
          {t('admin.updates.card.updatingDesc', { version: `v${state.targetVersion}` })}
        </div>
      )}

      {state.phase === 'restarting' && (
        <div className="p-3 bg-blue-50 dark:bg-blue-900/30 rounded-lg text-sm text-blue-800 dark:text-blue-200">
          {t('admin.updates.card.restartingDesc')}
        </div>
      )}

      {state.phase === 'complete' && (
        <div className="p-3 bg-green-50 dark:bg-green-900/30 rounded-lg text-sm text-green-800 dark:text-green-200">
          {t('admin.updates.card.complete', { version: `v${state.version}` })}
        </div>
      )}

      {state.phase === 'error' && (
        <div className="p-3 bg-amber-50 dark:bg-amber-900/30 rounded-lg text-sm text-amber-800 dark:text-amber-200">
          <p>{t('admin.updates.card.errorTitle')}</p>
          <div className="flex flex-wrap gap-4 mt-2">
            <a
              href={buildResourceUrl('/api/admin/system/logs/download?type=combined')}
              className="inline-flex items-center gap-1 font-semibold underline hover:text-amber-900 dark:hover:text-amber-100"
            >
              <Download className="w-3.5 h-3.5" />
              {t('admin.updates.card.downloadCombinedLog')}
            </a>
            <a
              href={buildResourceUrl('/api/admin/system/logs/download?type=error')}
              className="inline-flex items-center gap-1 font-semibold underline hover:text-amber-900 dark:hover:text-amber-100"
            >
              <Download className="w-3.5 h-3.5" />
              {t('admin.updates.card.downloadErrorLog')}
            </a>
          </div>
        </div>
      )}

      {(state.phase === 'idle' || state.phase === 'update-available') && state.lastChecked && (
        <div className="mt-3 text-xs text-neutral-500 dark:text-neutral-400">
          {t('admin.updates.card.lastChecked', {
            time: new Date(state.lastChecked).toLocaleString(),
          })}{' '}
          ·{' '}
          <button
            onClick={checkAgain}
            className="text-indigo-600 dark:text-indigo-400 hover:underline"
          >
            {t('admin.updates.card.checkAgain')}
          </button>
        </div>
      )}
    </Card>
  );
};
