/**
 * Accounting → Incoming invoices (external supplier invoices).
 *
 * Capture (camera/upload) → triage (confirm fields + disposition + booking) →
 * the supplier invoice is the payable: mark it PAID here, or re-bill it to a
 * client. PDFs are previewed as server-rasterised page images (never raw).
 */
import React, { useRef, useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { Camera, Upload, Inbox, X, CheckCircle2, Circle } from 'lucide-react';
import { Button, Card, CardContent, Input, LocalizedDateInput, Loading } from '../../../components/common';
import { DecimalInput } from '../../../components/common/DecimalInput';
import { CustomerAccountPicker, type SelectedCustomer } from '../../../components/admin/CustomerAccountPicker';
import { formatMoneyMinor } from '../../../utils/money';
import { useLocalizedDate } from '../../../hooks/useLocalizedDate';
import {
  accountingService, categoryLabel,
  type InboundDocument, type Disposition, type MarkupType, type PaymentMethod, type ExpenseCategory,
} from '../../../services/accounting.service';

const DISPOSITIONS: Disposition[] = ['rebill', 'durchlaufend', 'eigener_aufwand', 'duplikat', 'abgelehnt'];
const PAYMENT_METHODS: PaymentMethod[] = ['bank_transfer', 'cash', 'twint', 'paypal', 'card', 'other'];
const BOOKING_DISPOSITIONS: Disposition[] = ['rebill', 'durchlaufend', 'eigener_aufwand'];

const statusClasses: Record<string, string> = {
  unsorted: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  categorized: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  declined: 'bg-neutral-200 text-neutral-700 dark:bg-neutral-700 dark:text-neutral-300',
  duplicate: 'bg-neutral-200 text-neutral-700 dark:bg-neutral-700 dark:text-neutral-300',
};

const labelCls = 'block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1';
const selectCls = 'w-full rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 px-3 py-2 text-sm';

const BookingField: React.FC<{ eventId: number | null; onChange: (id: number | null) => void }> = ({ eventId, onChange }) => {
  const { t } = useTranslation();
  const isEvent = eventId != null;
  return (
    <div>
      <label className={labelCls}>{t('accounting.booking.label', 'Book to')}</label>
      <div className="flex gap-2">
        <select className={selectCls} style={{ maxWidth: 160 }} value={isEvent ? 'event' : 'company'}
          onChange={(e) => onChange(e.target.value === 'event' ? (eventId ?? 0) : null)}>
          <option value="company">{t('accounting.booking.company', 'Company')}</option>
          <option value="event">{t('accounting.booking.event', 'Event')}</option>
        </select>
        {isEvent && (
          <Input placeholder={t('accounting.booking.eventId', 'Event ID')} inputMode="numeric"
            value={eventId ? String(eventId) : ''} onChange={(e) => onChange(Number(e.target.value.replace(/[^0-9]/g, '')) || 0)} />
        )}
      </div>
    </div>
  );
};

const PayModal: React.FC<{ doc: InboundDocument; onClose: () => void; onDone: () => void }> = ({ doc, onClose, onDone }) => {
  const { t } = useTranslation();
  const [paidAt, setPaidAt] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('bank_transfer');
  const [reference, setReference] = useState(doc.paymentReference || '');
  const save = useMutation({
    mutationFn: () => accountingService.markInboundPaid(doc.id, { paid: true, paidAt: paidAt || undefined, paymentMethod: method, paymentReference: reference || undefined }),
    onSuccess: () => { toast.success(t('accounting.incoming.paidToast', 'Marked as paid.')); onDone(); },
    onError: (e: any) => toast.error(e?.response?.data?.error || e.message || 'Failed'),
  });
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4">
      <div className="mt-16 w-full max-w-sm rounded-xl bg-white dark:bg-neutral-900 shadow-xl">
        <div className="flex items-center justify-between border-b border-neutral-200 dark:border-neutral-700 px-5 py-3">
          <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">{t('accounting.incoming.payTitle', 'Mark supplier paid')}</h2>
          <button onClick={onClose} className="text-neutral-400 hover:text-neutral-600"><X className="w-5 h-5" /></button>
        </div>
        <div className="px-5 py-4 space-y-3">
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            {t('accounting.incoming.outstanding', 'Outstanding')}: <span className="font-semibold text-neutral-900 dark:text-neutral-100">{doc.totalAmountMinor != null ? formatMoneyMinor(doc.totalAmountMinor, doc.currency || 'CHF') : '—'}</span>
          </p>
          <div><label className={labelCls}>{t('accounting.ledger.paidDate', 'Payment date')}</label><LocalizedDateInput value={paidAt} onChange={setPaidAt} /></div>
          <div><label className={labelCls}>{t('accounting.ledger.method', 'Method')}</label>
            <select value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)} className={selectCls}>
              {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{t(`accounting.paymentMethod.${m}`, m)}</option>)}
            </select>
          </div>
          <div><label className={labelCls}>{t('accounting.ledger.reference', 'Reference (optional)')}</label><Input value={reference} onChange={(e) => setReference(e.target.value)} /></div>
        </div>
        <div className="flex justify-end gap-2 border-t border-neutral-200 dark:border-neutral-700 px-5 py-3">
          <Button variant="outline" onClick={onClose}>{t('common.cancel', 'Cancel')}</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>{save.isPending ? t('common.saving', 'Saving…') : t('accounting.incoming.confirmPaid', 'Mark paid')}</Button>
        </div>
      </div>
    </div>
  );
};

const TriageModal: React.FC<{ doc: InboundDocument; categories: ExpenseCategory[]; onClose: () => void; onDone: () => void }> = ({ doc, categories, onClose, onDone }) => {
  const { t } = useTranslation();
  const [supplier, setSupplier] = useState(doc.supplierName || '');
  const [amountMajor, setAmountMajor] = useState<number>(doc.totalAmountMinor != null ? doc.totalAmountMinor / 100 : NaN);
  const [currency, setCurrency] = useState(doc.currency || 'CHF');
  const [invoiceDate, setInvoiceDate] = useState(doc.invoiceDate || '');
  const [disposition, setDisposition] = useState<Disposition>('eigener_aufwand');
  const [categoryId, setCategoryId] = useState<number | undefined>(undefined);
  const [eventId, setEventId] = useState<number | null>(null);
  const [customer, setCustomer] = useState<SelectedCustomer[]>([]);
  const [markupType, setMarkupType] = useState<MarkupType>('none');
  const [markupValue, setMarkupValue] = useState<number>(NaN);

  const totalMinor = Number.isFinite(amountMajor) ? Math.round(amountMajor * 100) : null;

  // Rasterised preview (last page = QR-bill).
  const isPdf = (doc.mimeType || '').includes('pdf');
  const pageCount = doc.pageCount || 1;
  const [page, setPage] = useState(pageCount);
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState(false);
  useEffect(() => {
    let url: string | null = null; let cancelled = false;
    setImgUrl(null); setPreviewError(false);
    (isPdf ? accountingService.getInboundPageBlob(doc.id, page) : accountingService.getInboundFileBlob(doc.id))
      .then((b) => { if (!cancelled) { url = URL.createObjectURL(b); setImgUrl(url); } })
      .catch(() => { if (!cancelled) setPreviewError(true); });
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [doc.id, isPdf, page]);

  const markupPayload = () => ({
    markupType,
    markupPercent: markupType === 'percent' && Number.isFinite(markupValue) ? markupValue : null,
    markupFlatMinor: markupType === 'flat' && Number.isFinite(markupValue) ? Math.round(markupValue * 100) : null,
  });

  const save = useMutation({
    mutationFn: async () => {
      await accountingService.updateInbound(doc.id, { supplierName: supplier || null, totalAmountMinor: totalMinor, currency: currency || null, invoiceDate: invoiceDate || null });
      await accountingService.categorizeInbound(doc.id, {
        disposition,
        eventId: BOOKING_DISPOSITIONS.includes(disposition) ? eventId : null,
        categoryId: disposition === 'eigener_aufwand' ? (categoryId ?? null) : null,
        customerAccountId: disposition === 'rebill' && customer[0] ? customer[0].id : null,
        ...markupPayload(),
      });
    },
    onSuccess: () => { toast.success(t('accounting.incoming.categorizedToast', 'Categorized.')); onDone(); },
    onError: (e: any) => toast.error(e?.response?.data?.error || e.message || 'Failed'),
  });

  const rebillNeedsCustomer = disposition === 'rebill' && !customer[0];

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4">
      <div className="mt-10 w-full max-w-4xl rounded-xl bg-white dark:bg-neutral-900 shadow-xl">
        <div className="flex items-center justify-between border-b border-neutral-200 dark:border-neutral-700 px-5 py-3">
          <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">{t('accounting.incoming.triageTitle', 'Categorize incoming invoice')}</h2>
          <button onClick={onClose} className="text-neutral-400 hover:text-neutral-600"><X className="w-5 h-5" /></button>
        </div>
        <div className="px-5 py-4 grid grid-cols-1 lg:grid-cols-2 gap-5">
          <div className="order-2 lg:order-1">
            <div className="overflow-auto rounded-md border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800" style={{ maxHeight: '60vh' }}>
              {previewError ? <div className="flex h-[60vh] items-center justify-center px-3 text-center text-sm text-neutral-500">{t('accounting.inbox.previewError', 'Preview unavailable — enter the fields manually.')}</div>
                : imgUrl ? <img src={imgUrl} alt="document page" className="w-full h-auto" />
                  : <div className="flex h-[60vh] items-center justify-center text-sm text-neutral-500">{t('accounting.inbox.previewLoading', 'Loading preview…')}</div>}
            </div>
            {isPdf && pageCount > 1 && (
              <div className="mt-2 flex items-center justify-center gap-3 text-sm">
                <Button size="sm" variant="outline" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>{t('accounting.inbox.prevPage', 'Prev')}</Button>
                <span className="text-neutral-600 dark:text-neutral-400">{t('accounting.inbox.pageOf', 'Page {{n}} / {{total}}', { n: page, total: pageCount })}</span>
                <Button size="sm" variant="outline" onClick={() => setPage((p) => Math.min(pageCount, p + 1))} disabled={page >= pageCount}>{t('accounting.inbox.nextPage', 'Next')}</Button>
              </div>
            )}
            {isPdf && <p className="mt-1 text-center text-xs text-neutral-500 dark:text-neutral-400">{t('accounting.inbox.qrHint', 'Showing the last page — the Swiss QR-bill usually sits at the bottom.')}</p>}
          </div>

          <div className="order-1 lg:order-2 space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2"><label className={labelCls}>{t('accounting.inbox.field.supplier', 'Supplier')}</label><Input value={supplier} onChange={(e) => setSupplier(e.target.value)} /></div>
              <div><label className={labelCls}>{t('accounting.inbox.field.total', 'Total')}</label><DecimalInput value={amountMajor} onChange={setAmountMajor} fractionDigits={2} className={selectCls} /></div>
              <div><label className={labelCls}>{t('accounting.inbox.field.currency', 'Currency')}</label><Input value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value.toUpperCase())} /></div>
              <div className="col-span-2"><label className={labelCls}>{t('accounting.inbox.field.invoiceDate', 'Invoice date')}</label><LocalizedDateInput value={invoiceDate} onChange={setInvoiceDate} /></div>
            </div>

            <div><label className={labelCls}>{t('accounting.inbox.field.disposition', 'Disposition')}</label>
              <select value={disposition} onChange={(e) => setDisposition(e.target.value as Disposition)} className={selectCls}>
                {DISPOSITIONS.map((d) => <option key={d} value={d}>{t(`accounting.disposition.${d}`, d)}</option>)}
              </select>
            </div>

            {BOOKING_DISPOSITIONS.includes(disposition) && <BookingField eventId={eventId} onChange={setEventId} />}

            {disposition === 'eigener_aufwand' && (
              <div><label className={labelCls}>{t('accounting.inbox.field.category', 'Category')}</label>
                <select value={categoryId ?? ''} onChange={(e) => setCategoryId(e.target.value ? Number(e.target.value) : undefined)} className={selectCls}>
                  <option value="">{t('accounting.inbox.field.categoryNone', '— none —')}</option>
                  {categories.map((c) => <option key={c.id} value={c.id}>{categoryLabel(c, t)}</option>)}
                </select>
              </div>
            )}

            {disposition === 'rebill' && (
              <div className="space-y-3 rounded-lg border border-neutral-200 dark:border-neutral-700 p-3">
                <div><label className={labelCls}>{t('accounting.inbox.field.customer', 'Client')} *</label>
                  <CustomerAccountPicker value={customer.slice(0, 1)} onChange={(next) => setCustomer(next.slice(-1))} /></div>
                <div><label className={labelCls}>{t('accounting.inbox.field.markup', 'Markup')}</label>
                  <select value={markupType} onChange={(e) => setMarkupType(e.target.value as MarkupType)} className={selectCls}>
                    <option value="none">{t('accounting.markup.none', 'None / from contract')}</option>
                    <option value="percent">{t('accounting.markup.percent', 'Percent')}</option>
                    <option value="flat">{t('accounting.markup.flat', 'Flat')}</option>
                  </select>
                </div>
                {markupType !== 'none' && <DecimalInput value={markupValue} onChange={setMarkupValue} fractionDigits={2} className={selectCls} placeholder={markupType === 'percent' ? '%' : currency} />}
              </div>
            )}
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-neutral-200 dark:border-neutral-700 px-5 py-3">
          <Button variant="outline" onClick={onClose}>{t('common.cancel', 'Cancel')}</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || rebillNeedsCustomer}>{save.isPending ? t('common.saving', 'Saving…') : t('accounting.inbox.saveCategorize', 'Save')}</Button>
        </div>
      </div>
    </div>
  );
};

export const AccountingInboxPage: React.FC = () => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { format } = useLocalizedDate();
  const cameraRef = useRef<HTMLInputElement>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const [triageDoc, setTriageDoc] = useState<InboundDocument | null>(null);
  const [payDoc, setPayDoc] = useState<InboundDocument | null>(null);

  const { data, isLoading } = useQuery({ queryKey: ['accounting-inbound'], queryFn: () => accountingService.listInbound({ pageSize: 100 }) });
  const { data: categories } = useQuery({ queryKey: ['expense-categories'], queryFn: () => accountingService.listCategories() });

  const upload = useMutation({
    mutationFn: ({ file, source }: { file: File; source: 'upload' | 'camera' }) => accountingService.uploadInbound(file, source),
    onSuccess: (doc) => { toast.success(t('accounting.inbox.capturedToast', 'Document captured.')); qc.invalidateQueries({ queryKey: ['accounting-inbound'] }); if (doc.status === 'unsorted') setTriageDoc(doc); },
    onError: (e: any) => toast.error(e?.response?.data?.error || e.message || 'Upload failed'),
  });
  const unpay = useMutation({
    mutationFn: (id: number) => accountingService.markInboundPaid(id, { paid: false }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['accounting-inbound'] }); },
    onError: (e: any) => toast.error(e?.response?.data?.error || e.message || 'Failed'),
  });

  const onFile = (source: 'upload' | 'camera') => (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (file) upload.mutate({ file, source }); e.target.value = '';
  };
  const refresh = () => qc.invalidateQueries({ queryKey: ['accounting-inbound'] });
  const items = data?.items ?? [];

  return (
    <div>
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={onFile('camera')} />
      <input ref={uploadRef} type="file" accept="image/*,application/pdf" className="hidden" onChange={onFile('upload')} />

      <Card className="mb-6"><CardContent className="flex flex-col sm:flex-row items-center gap-3 p-5">
        <div className="flex-1">
          <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">{t('accounting.inbox.captureTitle', 'Capture a supplier invoice')}</h2>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">{t('accounting.inbox.captureBody', 'Photograph a paper invoice with your device camera, or upload a PDF / image.')}</p>
        </div>
        <Button onClick={() => cameraRef.current?.click()} disabled={upload.isPending}><Camera className="w-4 h-4 mr-2" /> {t('accounting.inbox.scanCamera', 'Scan with camera')}</Button>
        <Button variant="outline" onClick={() => uploadRef.current?.click()} disabled={upload.isPending}><Upload className="w-4 h-4 mr-2" /> {t('accounting.inbox.uploadFile', 'Upload file')}</Button>
      </CardContent></Card>

      {isLoading ? <Loading /> : items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-neutral-300 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-900 p-8 text-center">
          <Inbox className="w-10 h-10 mx-auto mb-3 text-neutral-400" />
          <p className="text-sm text-neutral-600 dark:text-neutral-400">{t('accounting.inbox.empty', 'No documents yet — capture one above.')}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((doc) => (
            <div key={doc.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-4 py-3">
              <div className="flex-1 min-w-[12rem]">
                <div className="flex items-center gap-2">
                  <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${statusClasses[doc.status] || ''}`}>{t(`accounting.inbox.status.${doc.status}`, doc.status)}</span>
                  <span className="text-sm font-medium text-neutral-900 dark:text-neutral-100 truncate">{doc.supplierName || doc.originalFilename || t('accounting.inbox.untitled', 'Untitled document')}</span>
                  {doc.source === 'camera' && <Camera className="w-3.5 h-3.5 text-neutral-400" />}
                </div>
                <div className="text-xs text-neutral-500 dark:text-neutral-400">
                  {doc.totalAmountMinor != null ? formatMoneyMinor(doc.totalAmountMinor, doc.currency || 'CHF') : t('accounting.inbox.noAmount', 'amount not entered')}
                  {' · '}{format(doc.createdAt)}
                  {doc.disposition && <>{' · '}{t(`accounting.disposition.${doc.disposition}`, doc.disposition)}</>}
                </div>
              </div>
              {doc.status !== 'declined' && doc.status !== 'duplicate' && (
                doc.supplierPaid
                  ? <button onClick={() => unpay.mutate(doc.id)} disabled={unpay.isPending} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-green-700 dark:text-green-300 hover:bg-green-50 dark:hover:bg-green-900/30"><CheckCircle2 className="w-4 h-4" /> {t('accounting.incoming.paid', 'Paid')}</button>
                  : <Button size="sm" variant="outline" onClick={() => setPayDoc(doc)}><Circle className="w-3.5 h-3.5 mr-1" /> {t('accounting.incoming.markPaid', 'Mark paid')}</Button>
              )}
              {doc.status === 'unsorted' && <Button size="sm" onClick={() => setTriageDoc(doc)}>{t('accounting.inbox.categorize', 'Categorize')}</Button>}
            </div>
          ))}
        </div>
      )}

      {triageDoc && <TriageModal doc={triageDoc} categories={categories ?? []} onClose={() => setTriageDoc(null)} onDone={() => { setTriageDoc(null); refresh(); }} />}
      {payDoc && <PayModal doc={payDoc} onClose={() => setPayDoc(null)} onDone={() => { setPayDoc(null); refresh(); }} />}
    </div>
  );
};

export default AccountingInboxPage;
