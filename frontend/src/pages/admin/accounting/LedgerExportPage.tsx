/**
 * Accounting → Treuhänder export (Layer A).
 *
 * Picks a period + currency + target tool, then downloads the collective
 * journal (accrual Buchungssätze) as CSV for import into the Treuhänder's
 * double-entry software. Output is a guideline — disclaimer on the page.
 */
import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { FileSpreadsheet, Download, AlertCircle } from 'lucide-react';
import { Button, Card, CardContent, LocalizedDateInput } from '../../../components/common';
import { ledgerService, type ExportFormat } from '../../../services/ledger.service';

const selectCls = 'w-full rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 px-3 py-2 text-sm text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-primary-500';
const labelCls = 'block text-xs font-medium text-neutral-700 dark:text-neutral-300 mb-1';

type PeriodPreset = 'thisYear' | 'lastYear' | 'thisQuarter' | 'lastQuarter' | 'custom';
const FORMATS: ExportFormat[] = ['generic', 'banana', 'bexio'];

function periodForPreset(preset: PeriodPreset, today = new Date()): { from: string; to: string } {
  const y = today.getFullYear();
  const pad = (n: number) => String(n).padStart(2, '0');
  if (preset === 'thisYear') return { from: `${y}-01-01`, to: `${y}-12-31` };
  if (preset === 'lastYear') return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31` };
  const quarter = Math.floor(today.getMonth() / 3);
  if (preset === 'thisQuarter') {
    const sm = quarter * 3; const em = sm + 2;
    return { from: `${y}-${pad(sm + 1)}-01`, to: `${y}-${pad(em + 1)}-${pad(new Date(y, em + 1, 0).getDate())}` };
  }
  let qy = y; let q = quarter - 1; if (q < 0) { q = 3; qy = y - 1; }
  const sm = q * 3; const em = sm + 2;
  return { from: `${qy}-${pad(sm + 1)}-01`, to: `${qy}-${pad(em + 1)}-${pad(new Date(qy, em + 1, 0).getDate())}` };
}

function triggerDownload(url: string, filename: string) {
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.style.display = 'none';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export const LedgerExportPage: React.FC = () => {
  const { t } = useTranslation();
  const [preset, setPreset] = useState<PeriodPreset>('thisYear');
  const initial = useMemo(() => periodForPreset('thisYear'), []);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [currency, setCurrency] = useState('CHF');
  const [format, setFormat] = useState<ExportFormat>('generic');
  const [busy, setBusy] = useState(false);

  const onPreset = (next: PeriodPreset) => {
    setPreset(next);
    if (next !== 'custom') { const p = periodForPreset(next); setFrom(p.from); setTo(p.to); }
  };

  const handleExport = async () => {
    setBusy(true);
    try {
      const { url, filename } = await ledgerService.downloadExportUrl({ from, to, currency, format });
      triggerDownload(url, filename);
    } catch (e: any) {
      toast.error(e?.response?.data?.error || e.message || t('ledger.export.failed', 'Export failed.'));
    } finally { setBusy(false); }
  };

  return (
    <Card padding="md">
      <CardContent className="p-0">
        <div className="flex items-start gap-3 mb-4">
          <div className="w-10 h-10 rounded-lg bg-accent-soft text-on-accent-soft flex items-center justify-center flex-shrink-0">
            <FileSpreadsheet className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">{t('ledger.export.title', 'Treuhänder export')}</h1>
            <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-0.5">{t('ledger.export.intro', 'Download the collective journal (revenue + costs as accrual postings with account and VAT codes) for import into your Treuhänder’s accounting software.')}</p>
          </div>
        </div>

        <div className="space-y-3 max-w-md">
          <div>
            <label className={labelCls}>{t('taxReport.filters.period', 'Period')}</label>
            <select value={preset} onChange={(e) => onPreset(e.target.value as PeriodPreset)} className={selectCls}>
              <option value="thisYear">{t('taxReport.filters.thisYear', 'This year')}</option>
              <option value="lastYear">{t('taxReport.filters.lastYear', 'Last year')}</option>
              <option value="thisQuarter">{t('taxReport.filters.thisQuarter', 'This quarter')}</option>
              <option value="lastQuarter">{t('taxReport.filters.lastQuarter', 'Last quarter')}</option>
              <option value="custom">{t('taxReport.filters.custom', 'Custom range')}</option>
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className={labelCls}>{t('taxReport.filters.from', 'From')}</label><LocalizedDateInput value={from} onChange={(iso) => { setFrom(iso); setPreset('custom'); }} /></div>
            <div><label className={labelCls}>{t('taxReport.filters.to', 'To')}</label><LocalizedDateInput value={to} onChange={(iso) => { setTo(iso); setPreset('custom'); }} /></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>{t('taxReport.filters.currency', 'Currency')}</label>
              <select value={currency} onChange={(e) => setCurrency(e.target.value)} className={selectCls}>
                <option value="CHF">CHF</option><option value="EUR">EUR</option><option value="USD">USD</option><option value="GBP">GBP</option>
              </select>
            </div>
            <div>
              <label className={labelCls}>{t('ledger.export.format', 'Target tool')}</label>
              <select value={format} onChange={(e) => setFormat(e.target.value as ExportFormat)} className={selectCls}>
                {FORMATS.map((f) => <option key={f} value={f}>{t(`ledger.export.format_${f}`, f)}</option>)}
              </select>
            </div>
          </div>
          <div className="flex justify-end pt-1">
            <Button onClick={handleExport} disabled={busy || !from || !to} isLoading={busy} leftIcon={<Download className="w-4 h-4" />}>
              {t('ledger.export.download', 'Download CSV')}
            </Button>
          </div>
        </div>

        <p className="flex items-start gap-2 mt-5 text-xs text-neutral-500 dark:text-neutral-400">
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <span>{t('ledger.export.disclaimer', 'Accrual basis only (document dates) — payments/bank movements are not included. Account + VAT codes follow your Chart-of-accounts mapping. Always review the import with your Treuhänder before filing.')}</span>
        </p>
      </CardContent>
    </Card>
  );
};

export default LedgerExportPage;
