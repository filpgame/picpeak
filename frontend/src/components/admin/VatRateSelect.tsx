/**
 * VAT-rate picker for the invoice/quote editors. A dropdown of the configured
 * OUTPUT VAT codes (Settings → Accounting) plus an "Other (custom rate)" escape
 * hatch. Controlled by `(rate, code)`: selecting a code emits its rate + code
 * string (snapshotted on the document for the accounting export); "Other" emits
 * the typed rate with a null code. Reads the un-gated /admin/vat-codes endpoint,
 * so it works even when the accounting feature is off.
 */
import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { vatCodesService, type VatCodeOption } from '../../services/vatCodes.service';

const CUSTOM = '__custom__';
const selectCls =
  'w-full rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 px-3 py-2 text-sm text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-primary-500';

interface Props {
  rate: number;
  code: string | null;
  onChange: (rate: number, code: string | null) => void;
  label?: string;
  disabled?: boolean;
}

export const VatRateSelect: React.FC<Props> = ({ rate, code, onChange, label, disabled }) => {
  const { t } = useTranslation();
  const { data: codes = [] } = useQuery({
    queryKey: ['vat-codes', 'output'],
    queryFn: () => vatCodesService.listOutput(),
    staleTime: 5 * 60 * 1000,
  });

  // Selected option: prefer the snapshotted code; else a code whose rate matches
  // (legacy rows / no code stored); else "custom".
  const matched: VatCodeOption | undefined =
    (code ? codes.find((c) => c.code === code) : undefined)
    || (!code ? codes.find((c) => Number(c.rate) === Number(rate)) : undefined);
  const isCustom = !matched;

  return (
    <div>
      {label && (
        <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">{label}</label>
      )}
      <select
        className={selectCls}
        disabled={disabled}
        value={isCustom ? CUSTOM : String(matched!.id)}
        onChange={(e) => {
          if (e.target.value === CUSTOM) { onChange(rate, null); return; }
          const c = codes.find((x) => String(x.id) === e.target.value);
          if (c) onChange(Number(c.rate), c.code);
        }}
      >
        {codes.map((c) => (
          <option key={c.id} value={String(c.id)}>
            {c.name} ({Number(c.rate).toFixed(1)}%)
          </option>
        ))}
        <option value={CUSTOM}>{t('vat.customRate', 'Other (custom rate)')}</option>
      </select>
      {isCustom && (
        <input
          type="number"
          step="0.1"
          min="0"
          className={`${selectCls} mt-2`}
          disabled={disabled}
          value={rate}
          placeholder={t('vat.ratePercent', 'VAT rate %') as string}
          onChange={(e) => onChange(Number(e.target.value) || 0, null)}
        />
      )}
    </div>
  );
};
