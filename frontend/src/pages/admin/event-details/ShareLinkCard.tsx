import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { Copy, CheckCircle, Key, Mail, X } from 'lucide-react';
import type { Event } from '../../../types';
import { Button, Card } from '../../../components/common';
import { eventsService } from '../../../services/events.service';
import { buildShareLinkUrl } from '../../../utils/url';
import { isGalleryPublic } from '../../../utils/accessControl';

interface ShareLinkCardProps {
  event: Event;
  setShowPasswordReset: (show: boolean) => void;
}

export const ShareLinkCard: React.FC<ShareLinkCardProps> = ({ event, setShowPasswordReset }) => {
  const { t } = useTranslation();
  const [copiedLink, setCopiedLink] = useState(false);
  const [showResendEmailModal, setShowResendEmailModal] = useState(false);
  const [resendEmailPassword, setResendEmailPassword] = useState('');
  const [resendEmailLoading, setResendEmailLoading] = useState(false);

  const handleCopyLink = async () => {
    try {
      // Check if share_link exists
      if (!event.share_link) {
        toast.error(t('errors.noShareLink', 'No share link available'));
        return;
      }

      const shareUrl = buildShareLinkUrl(event.share_link);

      // Try modern clipboard API first
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(shareUrl);
      } else {
        // Fallback for non-HTTPS contexts or older browsers
        const textArea = document.createElement('textarea');
        textArea.value = shareUrl;
        textArea.style.position = 'fixed';
        textArea.style.left = '-999999px';
        textArea.style.top = '-999999px';
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        const successful = document.execCommand('copy');
        document.body.removeChild(textArea);
        if (!successful) {
          throw new Error('Copy failed');
        }
      }

setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2000);
    toast.success(t('toast.linkCopied'));
    } catch (err) {
      console.error('Copy failed:', err);
      toast.error(t('errors.copyFailed', 'Failed to copy link. Please copy manually.'));
    }
  };

  const handleResendCreationEmail = async () => {
    setResendEmailLoading(true);
    try {
      await eventsService.resendCreationEmail(
        event.id,
        resendEmailPassword || undefined,
      );
      toast.success(t('events.creationEmailResent'));
      setShowResendEmailModal(false);
    } catch {
      toast.error(t('events.failedToResendEmail'));
    } finally {
      setResendEmailLoading(false);
    }
  };

  return (
    <Card padding="md">
      <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-4">{t('events.shareLink')}</h2>

      <div className="flex items-center gap-2">
        <input
          type="text"
          value={buildShareLinkUrl(event.share_link)}
          readOnly
          className="flex-1 px-3 py-2 bg-neutral-50 dark:bg-neutral-700 border border-neutral-300 dark:border-neutral-600 text-neutral-900 dark:text-neutral-100 rounded-lg text-sm"
        />
        <Button
          variant="outline"
          size="md"
          leftIcon={copiedLink ? <CheckCircle className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
          onClick={handleCopyLink}
        >
          {copiedLink ? t('events.copied') : t('events.copy')}
        </Button>
      </div>

      <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-2">
        {isGalleryPublic(event.require_password)
          ? t('events.shareWithGuestsPublic', 'Anyone with this link can view the gallery. No password is required.')
          : t('events.shareWithGuests')}
      </p>

      {!event.is_archived && (
        <div className="mt-4 pt-4 border-t border-neutral-200 dark:border-neutral-700 space-y-2">
          <Button
            variant="outline"
            size="sm"
            leftIcon={<Key className="w-4 h-4" />}
            onClick={() => setShowPasswordReset(true)}
            className="w-full justify-center"
          >
            {t('events.resetGalleryPassword')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            leftIcon={<Mail className="w-4 h-4" />}
            onClick={() => {
              setResendEmailPassword('');
              setShowResendEmailModal(true);
            }}
            className="w-full justify-center"
          >
            {t('events.resendCreationEmail')}
          </Button>
        </div>
      )}

      {showResendEmailModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="resend-email-title"
        >
          <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl dark:bg-neutral-800">
            <div className="mb-4 flex items-center justify-between">
              <h2
                id="resend-email-title"
                className="text-lg font-semibold text-neutral-900 dark:text-neutral-100"
              >
                {t('events.resendCreationEmail')}
              </h2>
              <button
                type="button"
                onClick={() => setShowResendEmailModal(false)}
                aria-label={t('common.close', 'Close')}
                className="text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {event.require_password && !event.has_encrypted_password && (
              <div className="mb-4">
                <label
                  htmlFor="resend-email-password"
                  className="mb-1 block text-sm font-medium text-neutral-700 dark:text-neutral-300"
                >
                  {t('events.resendEmailPasswordLabel', 'Gallery password (optional)')}
                </label>
                <input
                  id="resend-email-password"
                  type="password"
                  value={resendEmailPassword}
                  onChange={(event) => setResendEmailPassword(event.target.value)}
                  placeholder={t(
                    'events.resendEmailPasswordPlaceholder',
                    'Enter password to include in email',
                  )}
                  className="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100"
                />
                <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                  {t(
                    'events.resendEmailPasswordHint',
                    'If left blank, the email will say the password is not shown for security reasons.',
                  )}
                </p>
              </div>
            )}

            <div className="flex justify-end gap-3">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowResendEmailModal(false)}
              >
                {t('common.cancel')}
              </Button>
              <Button
                variant="primary"
                size="sm"
                isLoading={resendEmailLoading}
                leftIcon={<Mail className="h-4 w-4" />}
                onClick={handleResendCreationEmail}
              >
                {t('events.sendEmail', 'Send email')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
};
