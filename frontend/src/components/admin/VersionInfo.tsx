import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Info, ArrowUpCircle } from 'lucide-react';
import { api } from '../../config/api';
import { githubReleaseUrl as releaseUrl } from '../../utils/githubReleaseUrl';
import packageJson from '../../../package.json';

// Frontend version from package.json
const FRONTEND_VERSION = packageJson.version;

interface SystemVersion {
  backend: string;
  frontend: string;
  node: string;
  environment: string;
  channel?: 'stable' | 'beta';
}

interface UpdateInfo {
  enabled: boolean;
  updateAvailable: boolean;
  latest?: {
    forChannel: string;
  };
}

async function fetchSystemVersion(): Promise<SystemVersion> {
  const response = await api.get<SystemVersion>('/admin/system/version');
  return response.data;
}

async function fetchUpdateInfo(): Promise<UpdateInfo> {
  const response = await api.get<UpdateInfo>('/admin/system/updates');
  return response.data;
}

export const VersionInfo: React.FC = () => {
  const { t } = useTranslation();
  const { data: versionInfo } = useQuery({
    queryKey: ['system-version'],
    queryFn: fetchSystemVersion,
    staleTime: 5 * 60 * 1000, // Cache for 5 minutes
  });

  const { data: updateInfo } = useQuery({
    queryKey: ['update-check'],
    queryFn: fetchUpdateInfo,
    staleTime: 60 * 60 * 1000, // 1 hour
    retry: false
  });

  const channelBadge = versionInfo?.channel === 'beta' ? (
    <span className="ml-1 px-1.5 py-0.5 text-xs bg-amber-100 text-amber-700 rounded">
      {t('admin.updates.beta', 'BETA')}
    </span>
  ) : null;

  return (
    <div className="px-4 py-3 border-t border-neutral-200">
      <div className="flex items-center gap-2 text-xs text-neutral-600">
        <Info className="w-3 h-3" />
        <span className="font-medium">{t('admin.version')}</span>
        {channelBadge}
      </div>
      <div className="mt-1 space-y-0.5 text-xs text-neutral-500">
        <div>
          Frontend:{' '}
          <a
            href={releaseUrl(FRONTEND_VERSION)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-neutral-500 hover:text-neutral-700 hover:underline"
            title={t('admin.viewReleaseNotes', 'View release notes on GitHub')}
          >
            v{FRONTEND_VERSION}
          </a>
        </div>
        {versionInfo && (
          <div>
            Backend:{' '}
            <a
              href={releaseUrl(versionInfo.backend)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-neutral-500 hover:text-neutral-700 hover:underline"
              title={t('admin.viewReleaseNotes', 'View release notes on GitHub')}
            >
              v{versionInfo.backend}
            </a>
          </div>
        )}
      </div>
      {updateInfo?.enabled && updateInfo?.updateAvailable && updateInfo.latest && (
        <a
          href={releaseUrl(updateInfo.latest.forChannel)}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 hover:underline"
          title={t('admin.viewReleaseNotes', 'View release notes on GitHub')}
        >
          <ArrowUpCircle className="w-3 h-3" />
          <span>
            {t('admin.updates.updateAvailableShort', 'v{{version}} available', {
              version: updateInfo.latest.forChannel
            })}
          </span>
        </a>
      )}
    </div>
  );
};