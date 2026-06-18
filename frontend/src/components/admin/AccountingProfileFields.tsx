/**
 * Business-profile financial fields surfaced on the Accounting tab: the
 * **VAT label** (printed on invoice/quote PDFs) and the **default hourly rate**
 * (install-wide fallback for hours logging). The values still live on
 * `business_profile`; this is a self-contained card with its own save (mirrors
 * VatCodesManager) so it can't clobber the rest of the business profile, and it
 * shares the `business-profile` query cache so both pages stay in sync.
 */
import React, { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { Save } from 'lucide-react';
import { Button, Card, CardContent, Input, Loading } from '../common';
import { DecimalInput } from '../common/DecimalInput';
import { businessProfileService } from '../../services/businessProfile.service';

const labelCls = 'block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1';
const inputCls = 'w-full max-w-xs rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 px-3 py-2 text-sm';

export const AccountingProfileFields: React.FC = () => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['business-profile'], queryFn: () => businessProfileService.get() });

  const [vatLabel, setVatLabel] = useState('');
  const [hourlyMajor, setHourlyMajor] = useState<number>(NaN);
  const currency = data?.profile?.defaultCurrency || 'CHF';

  useEffect(() => {
    if (data?.profile) {
      setVatLabel(data.profile.vatLabel || '');
      setHourlyMajor(data.profile.defaultHourlyRateMinor != null ? data.profile.defaultHourlyRateMinor / 100 : NaN);
    }
  }, [data]);

  const save = useMutation({
    mutationFn: () => businessProfileService.update({
      vatLabel: vatLabel || '',
      defaultHourlyRateMinor: Number.isFinite(hourlyMajor) ? Math.max(0, Math.round(hourlyMajor * 100)) : null,
    }),
    onSuccess: () => {
      toast.success(t('settings.accounting.profileFields.savedToast', 'Saved.'));
      qc.invalidateQueries({ queryKey: ['business-profile'] });
    },
    onError: (e: any) => toast.error(e?.response?.data?.error || e.message || 'Failed'),
  });

  if (isLoading) return <Loading />;

  return (
    <Card><CardContent className="p-5 space-y-4">
      <h3 className="text-sm font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
        {t('settings.accounting.profileFields.title', 'VAT label & hourly rate')}
      </h3>

      <div>
        <label className={labelCls}>{t('settings.accounting.profileFields.vatLabel', 'VAT label (e.g. MwSt., VAT)')}</label>
        <Input value={vatLabel} onChange={(e) => setVatLabel(e.target.value)} className={inputCls} />
        <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{t('settings.accounting.profileFields.vatLabelHint', 'Printed as the VAT-line label on invoice / quote PDFs. Leave blank to use the document language default.')}</p>
      </div>

      <div>
        <label className={labelCls}>{t('settings.accounting.profileFields.hourlyRate', 'Default hourly rate')}</label>
        <DecimalInput
          value={hourlyMajor}
          fractionDigits={2}
          onChange={setHourlyMajor}
          className={inputCls}
          placeholder={t('settings.accounting.profileFields.hourlyRatePlaceholder', 'e.g. 120.00') as string}
        />
        <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
          {t('settings.accounting.profileFields.hourlyRateHint', 'Fallback used when a customer has no own rate. In {{currency}}, major units. Leave blank to require a per-customer or per-entry rate.', { currency })}
        </p>
      </div>

      <Button onClick={() => save.mutate()} disabled={save.isPending}><Save className="w-4 h-4 mr-2" /> {save.isPending ? t('common.saving', 'Saving…') : t('common.save', 'Save')}</Button>
    </CardContent></Card>
  );
};

export default AccountingProfileFields;
