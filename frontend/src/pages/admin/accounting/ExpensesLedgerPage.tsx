/**
 * Accounting → Expenses (internal own costs).
 *
 * Mileage (km) / per-diem (days) / plain amount, booked to an event or the
 * company, with an optional proof file (required when the accounting setting
 * says so). Rates default from the Accounting settings tab, overridable per
 * entry. No supplier payment here — that lives on incoming invoices.
 */
import React, { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { X, Plus, Paperclip, Car, CalendarDays, Coins } from 'lucide-react';
import { Button, Card, CardContent, Input, Loading } from '../../../components/common';
import { DecimalInput } from '../../../components/common/DecimalInput';
import { formatMoneyMinor } from '../../../utils/money';
import { useLocalizedDate } from '../../../hooks/useLocalizedDate';
import {
  accountingService, categoryLabel,
  type Expense, type ExpenseKind, type ExpenseCategory,
} from '../../../services/accounting.service';

const KINDS: ExpenseKind[] = ['amount', 'mileage', 'per_diem'];
const labelCls = 'block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1';
const selectCls = 'w-full rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 px-3 py-2 text-sm';
const kindIcon: Record<ExpenseKind, React.ReactNode> = {
  amount: <Coins className="w-3.5 h-3.5" />, mileage: <Car className="w-3.5 h-3.5" />, per_diem: <CalendarDays className="w-3.5 h-3.5" />,
};

const AddExpenseModal: React.FC<{ categories: ExpenseCategory[]; onClose: () => void; onDone: () => void }> = ({ categories, onClose, onDone }) => {
  const { t } = useTranslation();
  const { data: settings } = useQuery({ queryKey: ['accounting-settings'], queryFn: () => accountingService.getSettings() });
  const [kind, setKind] = useState<ExpenseKind>('amount');
  const [supplier, setSupplier] = useState('');
  const [description, setDescription] = useState('');
  const [amountMajor, setAmountMajor] = useState<number>(NaN);
  const [quantity, setQuantity] = useState<number>(NaN);
  const [rateMajor, setRateMajor] = useState<number>(NaN); // per-entry override (major units)
  const [categoryId, setCategoryId] = useState<number | undefined>(undefined);
  const [eventId, setEventId] = useState<number | null>(null);
  const [file, setFile] = useState<File | null>(null);

  const defaultRateMinor = kind === 'mileage' ? (settings?.accounting_km_rate_minor ?? 0)
    : kind === 'per_diem' ? (settings?.accounting_per_diem_rate_minor ?? 0) : 0;
  const effRateMinor = Number.isFinite(rateMajor) ? Math.round(rateMajor * 100) : defaultRateMinor;
  const computedMinor = useMemo(() => {
    if (kind === 'amount') return Number.isFinite(amountMajor) ? Math.round(amountMajor * 100) : null;
    return Number.isFinite(quantity) ? Math.round(quantity * effRateMinor) : null;
  }, [kind, amountMajor, quantity, effRateMinor]);
  const requireProof = !!settings?.accounting_require_proof;

  const save = useMutation({
    mutationFn: () => accountingService.createExpense({
      kind,
      quantity: kind === 'amount' ? undefined : (Number.isFinite(quantity) ? quantity : undefined),
      rateMinor: kind === 'amount' ? undefined : (Number.isFinite(rateMajor) ? Math.round(rateMajor * 100) : undefined),
      chfAmountMinor: kind === 'amount' && Number.isFinite(amountMajor) ? Math.round(amountMajor * 100) : undefined,
      eventId,
      categoryId: categoryId ?? null,
      supplierName: supplier || null,
      description: description || null,
    }, file),
    onSuccess: () => { toast.success(t('accounting.ledger.createdToast', 'Expense added.')); onDone(); },
    onError: (e: any) => toast.error(e?.response?.data?.error || e.message || 'Failed'),
  });

  const qtyLabel = kind === 'mileage' ? t('accounting.expense.km', 'Kilometres') : t('accounting.expense.days', 'Days');
  const incomplete = (kind === 'amount' && !Number.isFinite(amountMajor)) || (kind !== 'amount' && !Number.isFinite(quantity)) || (requireProof && !file);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4">
      <div className="mt-12 w-full max-w-md rounded-xl bg-white dark:bg-neutral-900 shadow-xl">
        <div className="flex items-center justify-between border-b border-neutral-200 dark:border-neutral-700 px-5 py-3">
          <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">{t('accounting.ledger.addTitle', 'Add expense')}</h2>
          <button onClick={onClose} className="text-neutral-400 hover:text-neutral-600"><X className="w-5 h-5" /></button>
        </div>
        <div className="px-5 py-4 space-y-3">
          <div><label className={labelCls}>{t('accounting.expense.kind', 'Type')}</label>
            <select value={kind} onChange={(e) => setKind(e.target.value as ExpenseKind)} className={selectCls}>
              {KINDS.map((k) => <option key={k} value={k}>{t(`accounting.expenseKind.${k}`, k)}</option>)}
            </select>
          </div>

          {kind === 'amount' ? (
            <div><label className={labelCls}>{t('accounting.inbox.field.total', 'Total')}</label><DecimalInput value={amountMajor} onChange={setAmountMajor} fractionDigits={2} className={selectCls} /></div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <div><label className={labelCls}>{qtyLabel}</label><DecimalInput value={quantity} onChange={setQuantity} fractionDigits={2} className={selectCls} /></div>
              <div><label className={labelCls}>{t('accounting.expense.rate', 'Rate')}</label>
                <DecimalInput value={rateMajor} onChange={setRateMajor} fractionDigits={2} className={selectCls} placeholder={(defaultRateMinor / 100).toFixed(2)} />
                <p className="mt-1 text-xs text-neutral-500">{t('accounting.expense.rateDefault', 'Default {{rate}} — leave blank to use it', { rate: (defaultRateMinor / 100).toFixed(2) })}</p>
              </div>
            </div>
          )}

          {computedMinor != null && <p className="text-sm text-neutral-700 dark:text-neutral-300">{t('accounting.expense.computed', 'Amount')}: <span className="font-semibold">{formatMoneyMinor(computedMinor, 'CHF')}</span></p>}

          <div><label className={labelCls}>{t('accounting.expense.who', 'Paid by / vendor')}</label><Input value={supplier} onChange={(e) => setSupplier(e.target.value)} placeholder={t('accounting.expense.whoHint', 'e.g. coworker name or shop')} /></div>
          <div><label className={labelCls}>{t('accounting.ledger.description', 'Description')}</label><Input value={description} onChange={(e) => setDescription(e.target.value)} /></div>

          <div><label className={labelCls}>{t('accounting.inbox.field.category', 'Category')}</label>
            <select value={categoryId ?? ''} onChange={(e) => setCategoryId(e.target.value ? Number(e.target.value) : undefined)} className={selectCls}>
              <option value="">{t('accounting.inbox.field.categoryNone', '— none —')}</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{categoryLabel(c, t)}</option>)}
            </select>
          </div>

          <div><label className={labelCls}>{t('accounting.booking.label', 'Book to')}</label>
            <div className="flex gap-2">
              <select className={selectCls} style={{ maxWidth: 160 }} value={eventId != null ? 'event' : 'company'} onChange={(e) => setEventId(e.target.value === 'event' ? (eventId ?? 0) : null)}>
                <option value="company">{t('accounting.booking.company', 'Company')}</option>
                <option value="event">{t('accounting.booking.event', 'Event')}</option>
              </select>
              {eventId != null && <Input placeholder={t('accounting.booking.eventId', 'Event ID')} inputMode="numeric" value={eventId ? String(eventId) : ''} onChange={(e) => setEventId(Number(e.target.value.replace(/[^0-9]/g, '')) || 0)} />}
            </div>
          </div>

          <div>
            <label className={labelCls}>{t('accounting.expense.proof', 'Proof')}{requireProof ? ' *' : ''}</label>
            <input type="file" accept="image/*,application/pdf" onChange={(e) => setFile(e.target.files?.[0] || null)} className="text-sm" />
            {requireProof && !file && <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">{t('accounting.expense.proofRequired', 'A proof file is required.')}</p>}
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-neutral-200 dark:border-neutral-700 px-5 py-3">
          <Button variant="outline" onClick={onClose}>{t('common.cancel', 'Cancel')}</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || incomplete}>{save.isPending ? t('common.saving', 'Saving…') : t('accounting.ledger.addExpense', 'Add expense')}</Button>
        </div>
      </div>
    </div>
  );
};

export const ExpensesLedgerPage: React.FC = () => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { format } = useLocalizedDate();
  const [kind, setKind] = useState('');
  const [showAdd, setShowAdd] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['accounting-expenses', kind],
    queryFn: () => accountingService.listExpenses({ kind: (kind || undefined) as ExpenseKind | undefined, pageSize: 100 }),
  });
  const { data: categories } = useQuery({ queryKey: ['expense-categories'], queryFn: () => accountingService.listCategories() });
  const catById = useMemo(() => new Map((categories ?? []).map((c) => [c.id, c])), [categories]);

  const openProof = async (id: number) => {
    try { const blob = await accountingService.getExpenseProofBlob(id); window.open(URL.createObjectURL(blob), '_blank'); }
    catch (e: any) { toast.error(e?.response?.data?.error || e.message || 'Failed'); }
  };

  const items = data?.items ?? [];

  return (
    <div>
      <div className="mb-4 flex flex-wrap gap-3">
        <select value={kind} onChange={(e) => setKind(e.target.value)} className={selectCls} style={{ maxWidth: 200 }}>
          <option value="">{t('accounting.ledger.allKinds', 'All types')}</option>
          {KINDS.map((k) => <option key={k} value={k}>{t(`accounting.expenseKind.${k}`, k)}</option>)}
        </select>
        <Button className="ml-auto" onClick={() => setShowAdd(true)}><Plus className="w-4 h-4 mr-1" /> {t('accounting.ledger.addExpense', 'Add expense')}</Button>
      </div>

      {isLoading ? <Loading /> : items.length === 0 ? (
        <Card><CardContent className="p-8 text-center text-sm text-neutral-600 dark:text-neutral-400">{t('accounting.ledger.empty', 'No expenses yet — add one above.')}</CardContent></Card>
      ) : (
        <div className="space-y-2">
          {items.map((ex: Expense) => {
            const cat = ex.categoryId ? catById.get(ex.categoryId) : null;
            return (
              <div key={ex.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-4 py-3">
                <span className="inline-flex items-center gap-1 rounded bg-neutral-100 dark:bg-neutral-800 px-2 py-0.5 text-xs font-medium text-neutral-700 dark:text-neutral-300">{kindIcon[ex.kind]} {t(`accounting.expenseKind.${ex.kind}`, ex.kind)}</span>
                <div className="flex-1 min-w-[10rem]">
                  <div className="text-sm font-medium text-neutral-900 dark:text-neutral-100 truncate">{ex.description || ex.supplierName || t('accounting.ledger.untitled', 'Expense')}</div>
                  <div className="text-xs text-neutral-500 dark:text-neutral-400">
                    {ex.eventId != null ? `${t('accounting.booking.event', 'Event')} #${ex.eventId}` : t('accounting.booking.company', 'Company')}
                    {cat && <>{' · '}{categoryLabel(cat, t)}</>}
                    {' · '}{format(ex.createdAt)}
                  </div>
                </div>
                {ex.hasProof && <button onClick={() => openProof(ex.id)} className="inline-flex items-center gap-1 text-xs text-primary-600 hover:underline"><Paperclip className="w-3.5 h-3.5" /> {t('accounting.expense.viewProof', 'Proof')}</button>}
                <div className="text-sm font-medium tabular-nums text-neutral-900 dark:text-neutral-100">{ex.chfAmountMinor != null ? formatMoneyMinor(ex.chfAmountMinor, 'CHF') : '—'}</div>
              </div>
            );
          })}
        </div>
      )}

      {showAdd && <AddExpenseModal categories={categories ?? []} onClose={() => setShowAdd(false)} onDone={() => { setShowAdd(false); qc.invalidateQueries({ queryKey: ['accounting-expenses'] }); }} />}
    </div>
  );
};

export default ExpensesLedgerPage;
