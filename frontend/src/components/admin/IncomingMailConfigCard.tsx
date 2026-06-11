/**
 * Incoming mail (IMAP) configuration — a second block under the outgoing SMTP
 * settings. Same field shape as SMTP. Self-contained: loads + saves its own
 * config. Shown only when the `incomingMail` feature flag is on.
 */
import React, { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { Save } from 'lucide-react';
import { Button, Card, Input, Loading } from '../common';
import { emailService, type IncomingMailConfig } from '../../services/email.service';

const labelCls = 'block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1';

export const IncomingMailConfigCard: React.FC = () => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['incoming-mail-config'], queryFn: () => emailService.getIncomingConfig() });
  const [cfg, setCfg] = useState<IncomingMailConfig>({ imap_host: '', imap_port: 993, imap_secure: true, imap_user: '', imap_pass: '', imap_folder: 'INBOX' });

  useEffect(() => { if (data) setCfg(data); }, [data]);

  const save = useMutation({
    mutationFn: () => emailService.updateIncomingConfig(cfg),
    onSuccess: () => { toast.success(t('email.incoming.savedToast', 'Incoming mail settings saved.')); qc.invalidateQueries({ queryKey: ['incoming-mail-config'] }); },
    onError: (e: any) => toast.error(e?.response?.data?.error || e?.response?.data?.errors?.[0]?.msg || e.message || 'Failed'),
  });

  const set = (k: keyof IncomingMailConfig, v: any) => setCfg((c) => ({ ...c, [k]: v }));
  if (isLoading) return <Loading />;

  return (
    <Card className="p-6 mt-6">
      <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-1">{t('email.incoming.title', 'Incoming mail (IMAP)')}</h2>
      <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-4">{t('email.incoming.subtitle', 'A dedicated mailbox polled every minute; attachments land in Accounting → Incoming invoices.')}</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="sm:col-span-2"><label className={labelCls}>{t('email.incoming.host', 'IMAP host')}</label>
          <Input value={cfg.imap_host} onChange={(e) => set('imap_host', e.target.value)} placeholder="imap.example.com" /></div>
        <div><label className={labelCls}>{t('email.incoming.port', 'Port')}</label>
          <Input type="number" value={cfg.imap_port} onChange={(e) => set('imap_port', parseInt(e.target.value, 10) || 0)} /></div>
        <div><label className={labelCls}>{t('email.incoming.security', 'Security')}</label>
          <select className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 px-3 py-2 text-sm"
            value={cfg.imap_secure ? 'ssl' : 'plain'} onChange={(e) => set('imap_secure', e.target.value === 'ssl')}>
            <option value="ssl">{t('email.incoming.ssl', 'SSL/TLS (993)')}</option>
            <option value="plain">{t('email.incoming.plain', 'None / STARTTLS (143)')}</option>
          </select></div>
        <div><label className={labelCls}>{t('email.incoming.user', 'Username')}</label>
          <Input value={cfg.imap_user} onChange={(e) => set('imap_user', e.target.value)} autoComplete="off" /></div>
        <div><label className={labelCls}>{t('email.incoming.pass', 'Password')}</label>
          <Input type="password" value={cfg.imap_pass} onChange={(e) => set('imap_pass', e.target.value)} autoComplete="new-password" /></div>
        <div className="sm:col-span-2"><label className={labelCls}>{t('email.incoming.folder', 'Folder')}</label>
          <Input value={cfg.imap_folder} onChange={(e) => set('imap_folder', e.target.value)} placeholder="INBOX" /></div>
      </div>
      <div className="mt-4">
        <Button onClick={() => save.mutate()} disabled={save.isPending}><Save className="w-4 h-4 mr-2" /> {save.isPending ? t('common.saving', 'Saving…') : t('common.save', 'Save')}</Button>
      </div>
    </Card>
  );
};

export default IncomingMailConfigCard;
