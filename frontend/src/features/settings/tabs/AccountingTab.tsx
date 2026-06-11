/**
 * Accounting settings tab — rates used by internal expenses + the proof
 * requirement. Rates are CHF; stored as integer minor units. Tax/legal
 * guidance only — verify with your Treuhaender.
 */
import React, { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { Save } from 'lucide-react';
import { Button, Card, CardContent, Loading } from '../../../components/common';
import { DecimalInput } from '../../../components/common/DecimalInput';
import { accountingService } from '../../../services/accounting.service';

const labelCls = 'block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1';
const inputCls = 'w-full max-w-xs rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 px-3 py-2 text-sm';

export const AccountingTab: React.FC = () => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['accounting-settings'], queryFn: () => accountingService.getSettings() });

  const [kmMajor, setKmMajor] = useState<number>(NaN);
  const [perDiemMajor, setPerDiemMajor] = useState<number>(NaN);
  const [requireProof, setRequireProof] = useState(false);

  useEffect(() => {
    if (data) {
      setKmMajor(data.accounting_km_rate_minor / 100);
      setPerDiemMajor(data.accounting_per_diem_rate_minor / 100);
      setRequireProof(data.accounting_require_proof);
    }
  }, [data]);

  const save = useMutation({
    mutationFn: () => accountingService.updateSettings({
      accounting_km_rate_minor: Number.isFinite(kmMajor) ? Math.round(kmMajor * 100) : 0,
      accounting_per_diem_rate_minor: Number.isFinite(perDiemMajor) ? Math.round(perDiemMajor * 100) : 0,
      accounting_require_proof: requireProof,
    }),
    onSuccess: () => { toast.success(t('settings.accounting.savedToast', 'Accounting settings saved.')); qc.invalidateQueries({ queryKey: ['accounting-settings'] }); },
    onError: (e: any) => toast.error(e?.response?.data?.error || e.message || 'Failed'),
  });

  if (isLoading) return <Loading />;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-neutral-900 dark:text-neutral-100">{t('settings.accounting.title', 'Accounting')}</h2>
        <p className="text-neutral-600 dark:text-neutral-400 mt-1">{t('settings.accounting.subtitle', 'Default rates for internal expenses and the proof requirement.')}</p>
      </div>

      <Card><CardContent className="p-5 space-y-4">
        <div>
          <label className={labelCls}>{t('settings.accounting.kmRate', 'Mileage rate (CHF / km)')}</label>
          <DecimalInput value={kmMajor} onChange={setKmMajor} fractionDigits={2} className={inputCls} />
          <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{t('settings.accounting.kmRateHint', 'Default applied to mileage expenses; overridable per entry.')}</p>
        </div>
        <div>
          <label className={labelCls}>{t('settings.accounting.perDiemRate', 'Per-diem rate (CHF / day)')}</label>
          <DecimalInput value={perDiemMajor} onChange={setPerDiemMajor} fractionDigits={2} className={inputCls} />
          <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{t('settings.accounting.perDiemRateHint', 'Default applied to per-diem expenses; overridable per entry.')}</p>
        </div>
        <label className="flex items-center gap-2 text-sm text-neutral-800 dark:text-neutral-200">
          <input type="checkbox" checked={requireProof} onChange={(e) => setRequireProof(e.target.checked)} className="rounded border-neutral-300" />
          {t('settings.accounting.requireProof', 'Require a proof file on every expense')}
        </label>
        <p className="text-xs text-amber-600 dark:text-amber-400">{t('settings.accounting.disclaimer', 'Rates and VAT/tax treatment are guidance only — verify with your Treuhaender.')}</p>
      </CardContent></Card>

      <div>
        <Button onClick={() => save.mutate()} disabled={save.isPending}><Save className="w-4 h-4 mr-2" /> {save.isPending ? t('common.saving', 'Saving…') : t('common.save', 'Save')}</Button>
      </div>
    </div>
  );
};

export default AccountingTab;
