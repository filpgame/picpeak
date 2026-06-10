/**
 * Accounting → Expenses ledger.
 *
 * Lists the expenses booked from triaged inbound documents (and manual ones).
 * Shows disposition + status, the linked client invoice for re-billed items,
 * and a supplier-payment toggle ("Zu zahlen / Bezahlt") with method capture —
 * decoupled from categorisation, per the locked design.
 */
import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { CheckCircle2, Circle, X, ExternalLink, Plus } from 'lucide-react';
import { Button, Card, CardContent, Input, LocalizedDateInput, Loading } from '../../../components/common';
import { DecimalInput } from '../../../components/common/DecimalInput';
import { CustomerAccountPicker, type SelectedCustomer } from '../../../components/admin/CustomerAccountPicker';
import { formatMoneyMinor } from '../../../utils/money';
import { useLocalizedDate } from '../../../hooks/useLocalizedDate';
import {
  accountingService,
  type Expense,
  type Disposition,
  type MarkupType,
  type PaymentMethod,
} from '../../../services/accounting.service';

const DISPOSITIONS: Disposition[] = ['rebill', 'durchlaufend', 'eigener_aufwand', 'duplikat', 'abgelehnt'];
const STATUSES = ['open', 'parked', 'billed', 'declined'];
const PAYMENT_METHODS: PaymentMethod[] = ['bank_transfer', 'cash', 'twint', 'paypal', 'card', 'other'];

const statusClasses: Record<string, string> = {
  open: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  parked: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
  billed: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  declined: 'bg-neutral-200 text-neutral-700 dark:bg-neutral-700 dark:text-neutral-300',
};

const PayModal: React.FC<{ expense: Expense; onClose: () => void; onDone: () => void }> = ({ expense, onClose, onDone }) => {
  const { t } = useTranslation();
  const [paidAt, setPaidAt] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('bank_transfer');
  const [reference, setReference] = useState('');

  const save = useMutation({
    mutationFn: () => accountingService.setSupplierPayment(expense.id, {
      paid: true, paidAt: paidAt || undefined, paymentMethod: method, paymentReference: reference || undefined,
    }),
    onSuccess: () => { toast.success(t('accounting.ledger.paidToast', 'Marked as paid.')); onDone(); },
    onError: (e: any) => toast.error(e?.response?.data?.error || e.message || 'Failed'),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4">
      <div className="mt-16 w-full max-w-sm rounded-xl bg-white dark:bg-neutral-900 shadow-xl">
        <div className="flex items-center justify-between border-b border-neutral-200 dark:border-neutral-700 px-5 py-3">
          <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">{t('accounting.ledger.markPaidTitle', 'Mark supplier paid')}</h2>
          <button onClick={onClose} aria-label={t('common.close', 'Close')} className="text-neutral-400 hover:text-neutral-600"><X className="w-5 h-5" /></button>
        </div>
        <div className="px-5 py-4 space-y-3">
          <div>
            <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">{t('accounting.ledger.paidDate', 'Payment date')}</label>
            <LocalizedDateInput value={paidAt} onChange={setPaidAt} />
          </div>
          <div>
            <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">{t('accounting.ledger.method', 'Method')}</label>
            <select value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}
              className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 px-3 py-2 text-sm">
              {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{t(`accounting.paymentMethod.${m}`, m)}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">{t('accounting.ledger.reference', 'Reference (optional)')}</label>
            <Input value={reference} onChange={(e) => setReference(e.target.value)} />
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-neutral-200 dark:border-neutral-700 px-5 py-3">
          <Button variant="outline" onClick={onClose}>{t('common.cancel', 'Cancel')}</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>{save.isPending ? t('common.saving', 'Saving…') : t('accounting.ledger.confirmPaid', 'Mark paid')}</Button>
        </div>
      </div>
    </div>
  );
};

const MANUAL_DISPOSITIONS: Disposition[] = ['eigener_aufwand', 'durchlaufend', 'rebill'];

const AddExpenseModal: React.FC<{ onClose: () => void; onDone: () => void }> = ({ onClose, onDone }) => {
  const { t } = useTranslation();
  const [supplier, setSupplier] = useState('');
  const [description, setDescription] = useState('');
  const [amountMajor, setAmountMajor] = useState<number>(NaN);
  const [currency, setCurrency] = useState('CHF');
  const [disposition, setDisposition] = useState<Disposition>('eigener_aufwand');
  const [categoryId, setCategoryId] = useState<number | undefined>(undefined);
  const [customer, setCustomer] = useState<SelectedCustomer[]>([]);
  const [eventId, setEventId] = useState('');
  const [markupType, setMarkupType] = useState<MarkupType>('none');
  const [markupValue, setMarkupValue] = useState<number>(NaN);

  const { data: categories } = useQuery({ queryKey: ['expense-categories'], queryFn: () => accountingService.listCategories() });
  const totalMinor = Number.isFinite(amountMajor) ? Math.round(amountMajor * 100) : null;
  const selectClass = 'w-full rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 px-3 py-2 text-sm';

  const save = useMutation({
    mutationFn: async () => {
      const expense = await accountingService.createExpense({
        disposition,
        supplierName: supplier || null,
        description: description || null,
        chfAmountMinor: totalMinor,
        grossAmountMinor: totalMinor,
        categoryId: disposition === 'eigener_aufwand' ? (categoryId ?? null) : null,
        eventId: eventId ? Number(eventId) : null,
        customerAccountId: disposition === 'rebill' && customer[0] ? customer[0].id : null,
        markupType,
        markupPercent: markupType === 'percent' && Number.isFinite(markupValue) ? markupValue : null,
        markupFlatMinor: markupType === 'flat' && Number.isFinite(markupValue) ? Math.round(markupValue * 100) : null,
      });
      if (disposition === 'rebill') {
        await accountingService.rebill(expense.id, {
          customerAccountId: customer[0].id,
          eventId: eventId ? Number(eventId) : null,
          markupType,
          markupPercent: markupType === 'percent' && Number.isFinite(markupValue) ? markupValue : null,
          markupFlatMinor: markupType === 'flat' && Number.isFinite(markupValue) ? Math.round(markupValue * 100) : null,
        });
      }
    },
    onSuccess: () => { toast.success(t('accounting.ledger.createdToast', 'Expense added.')); onDone(); },
    onError: (e: any) => toast.error(e?.response?.data?.error || e.message || 'Failed'),
  });

  const rebillNeedsCustomer = disposition === 'rebill' && !customer[0];

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4">
      <div className="mt-12 w-full max-w-md rounded-xl bg-white dark:bg-neutral-900 shadow-xl">
        <div className="flex items-center justify-between border-b border-neutral-200 dark:border-neutral-700 px-5 py-3">
          <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">{t('accounting.ledger.addTitle', 'Add expense')}</h2>
          <button onClick={onClose} aria-label={t('common.close', 'Close')} className="text-neutral-400 hover:text-neutral-600"><X className="w-5 h-5" /></button>
        </div>
        <div className="px-5 py-4 space-y-3">
          <div>
            <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">{t('accounting.inbox.field.supplier', 'Supplier')}</label>
            <Input value={supplier} onChange={(e) => setSupplier(e.target.value)} />
          </div>
          <div>
            <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">{t('accounting.ledger.description', 'Description')}</label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t('accounting.ledger.descriptionHint', 'e.g. mileage, per-diem, cash receipt')} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">{t('accounting.inbox.field.total', 'Total')}</label>
              <DecimalInput value={amountMajor} onChange={setAmountMajor} fractionDigits={2} className={selectClass} />
            </div>
            <div>
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">{t('accounting.inbox.field.currency', 'Currency')}</label>
              <Input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} maxLength={3} />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">{t('accounting.inbox.field.disposition', 'Disposition')}</label>
            <select value={disposition} onChange={(e) => setDisposition(e.target.value as Disposition)} className={selectClass}>
              {MANUAL_DISPOSITIONS.map((d) => <option key={d} value={d}>{t(`accounting.disposition.${d}`, d)}</option>)}
            </select>
          </div>
          {disposition === 'eigener_aufwand' && (
            <div>
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">{t('accounting.inbox.field.category', 'Category')}</label>
              <select value={categoryId ?? ''} onChange={(e) => setCategoryId(e.target.value ? Number(e.target.value) : undefined)} className={selectClass}>
                <option value="">{t('accounting.inbox.field.categoryNone', '— none —')}</option>
                {(categories ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
          )}
          {disposition === 'rebill' && (
            <div className="space-y-3 rounded-lg border border-neutral-200 dark:border-neutral-700 p-3">
              <div>
                <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">{t('accounting.inbox.field.customer', 'Client')} *</label>
                <CustomerAccountPicker value={customer.slice(0, 1)} onChange={(next) => setCustomer(next.slice(-1))} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">{t('accounting.inbox.field.eventId', 'Event ID (optional)')}</label>
                  <Input value={eventId} onChange={(e) => setEventId(e.target.value.replace(/[^0-9]/g, ''))} inputMode="numeric" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">{t('accounting.inbox.field.markup', 'Markup')}</label>
                  <select value={markupType} onChange={(e) => setMarkupType(e.target.value as MarkupType)} className={selectClass}>
                    <option value="none">{t('accounting.markup.none', 'None / from contract')}</option>
                    <option value="percent">{t('accounting.markup.percent', 'Percent')}</option>
                    <option value="flat">{t('accounting.markup.flat', 'Flat')}</option>
                  </select>
                </div>
              </div>
              {markupType !== 'none' && (
                <DecimalInput value={markupValue} onChange={setMarkupValue} fractionDigits={2} className={selectClass} placeholder={markupType === 'percent' ? '%' : currency} />
              )}
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-neutral-200 dark:border-neutral-700 px-5 py-3">
          <Button variant="outline" onClick={onClose}>{t('common.cancel', 'Cancel')}</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || rebillNeedsCustomer || totalMinor == null}>
            {save.isPending ? t('common.saving', 'Saving…') : t('accounting.ledger.addExpense', 'Add expense')}
          </Button>
        </div>
      </div>
    </div>
  );
};

export const ExpensesLedgerPage: React.FC = () => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { format } = useLocalizedDate();
  const [status, setStatus] = useState('');
  const [disposition, setDisposition] = useState('');
  const [payExpense, setPayExpense] = useState<Expense | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['accounting-expenses', status, disposition],
    queryFn: () => accountingService.listExpenses({
      status: status || undefined,
      disposition: (disposition || undefined) as Disposition | undefined,
      pageSize: 100,
    }),
  });

  const unpay = useMutation({
    mutationFn: (id: number) => accountingService.setSupplierPayment(id, { paid: false }),
    onSuccess: () => { toast.success(t('accounting.ledger.unpaidToast', 'Marked as not paid.')); qc.invalidateQueries({ queryKey: ['accounting-expenses'] }); },
    onError: (e: any) => toast.error(e?.response?.data?.error || e.message || 'Failed'),
  });

  const selectClass = 'rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 px-3 py-2 text-sm';
  const items = data?.items ?? [];

  return (
    <div>
      <div className="mb-4 flex flex-wrap gap-3">
        <select value={status} onChange={(e) => setStatus(e.target.value)} className={selectClass}>
          <option value="">{t('accounting.ledger.allStatuses', 'All statuses')}</option>
          {STATUSES.map((s) => <option key={s} value={s}>{t(`accounting.expenseStatus.${s}`, s)}</option>)}
        </select>
        <select value={disposition} onChange={(e) => setDisposition(e.target.value)} className={selectClass}>
          <option value="">{t('accounting.ledger.allDispositions', 'All dispositions')}</option>
          {DISPOSITIONS.map((d) => <option key={d} value={d}>{t(`accounting.disposition.${d}`, d)}</option>)}
        </select>
        <Button className="ml-auto" onClick={() => setShowAdd(true)}>
          <Plus className="w-4 h-4 mr-1" /> {t('accounting.ledger.addExpense', 'Add expense')}
        </Button>
      </div>

      {isLoading ? (
        <Loading />
      ) : items.length === 0 ? (
        <Card><CardContent className="p-8 text-center text-sm text-neutral-600 dark:text-neutral-400">{t('accounting.ledger.empty', 'No expenses yet — categorize documents in the inbox.')}</CardContent></Card>
      ) : (
        <div className="space-y-2">
          {items.map((ex) => (
            <div key={ex.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-4 py-3">
              <div className="flex-1 min-w-[12rem]">
                <div className="flex items-center gap-2">
                  <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${statusClasses[ex.status] || ''}`}>{t(`accounting.expenseStatus.${ex.status}`, ex.status)}</span>
                  <span className="text-sm font-medium text-neutral-900 dark:text-neutral-100 truncate">{ex.supplierName || ex.description || t('accounting.ledger.untitled', 'Expense')}</span>
                </div>
                <div className="text-xs text-neutral-500 dark:text-neutral-400">
                  {t(`accounting.disposition.${ex.disposition}`, ex.disposition)}
                  {' · '}
                  {format(ex.createdAt)}
                  {ex.billedInvoiceId ? (
                    <>{' · '}<Link to={`/admin/clients/bills/${ex.billedInvoiceId}`} className="inline-flex items-center gap-0.5 text-primary-600 hover:underline">{t('accounting.ledger.invoiceLink', 'Invoice')}<ExternalLink className="w-3 h-3" /></Link></>
                  ) : null}
                </div>
              </div>

              <div className="text-sm font-medium text-neutral-900 dark:text-neutral-100 tabular-nums">
                {ex.chfAmountMinor != null ? formatMoneyMinor(ex.chfAmountMinor, 'CHF') : '—'}
              </div>

              {/* Supplier-payment toggle (skip for declined/duplicate). */}
              {ex.disposition !== 'abgelehnt' && ex.disposition !== 'duplikat' && (
                ex.supplierPaid ? (
                  <button onClick={() => unpay.mutate(ex.id)} disabled={unpay.isPending}
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-green-700 dark:text-green-300 hover:bg-green-50 dark:hover:bg-green-900/30">
                    <CheckCircle2 className="w-4 h-4" /> {t('accounting.ledger.paid', 'Paid')}
                  </button>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => setPayExpense(ex)}>
                    <Circle className="w-3.5 h-3.5 mr-1" /> {t('accounting.ledger.markPaid', 'Mark paid')}
                  </Button>
                )
              )}
            </div>
          ))}
        </div>
      )}

      {payExpense && (
        <PayModal expense={payExpense} onClose={() => setPayExpense(null)} onDone={() => { setPayExpense(null); qc.invalidateQueries({ queryKey: ['accounting-expenses'] }); }} />
      )}

      {showAdd && (
        <AddExpenseModal onClose={() => setShowAdd(false)} onDone={() => { setShowAdd(false); qc.invalidateQueries({ queryKey: ['accounting-expenses'] }); }} />
      )}
    </div>
  );
};

export default ExpensesLedgerPage;
