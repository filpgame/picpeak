/**
 * Accounting → Incoming invoices inbox ("Neu / Unsortiert").
 *
 * Capture a received supplier invoice via the phone/tablet CAMERA or a file
 * upload, then triage it: confirm the best-effort parsed fields and give it a
 * disposition (re-bill to a client, pass-through, company expense, duplicate,
 * declined). Re-bill mints an editable scheduled invoice on the client's event.
 *
 * Parsing is assist-only and currently a no-op on the backend (extractionService
 * scaffold) — fields are entered/confirmed manually until OCR lands.
 */
import React, { useRef, useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { Camera, Upload, Inbox, X } from 'lucide-react';
import { Button, Card, CardContent, Input, LocalizedDateInput, Loading } from '../../../components/common';
import { DecimalInput } from '../../../components/common/DecimalInput';
import { CustomerAccountPicker, type SelectedCustomer } from '../../../components/admin/CustomerAccountPicker';
import { formatMoneyMinor } from '../../../utils/money';
import { useLocalizedDate } from '../../../hooks/useLocalizedDate';
import {
  accountingService,
  type InboundDocument,
  type Disposition,
  type MarkupType,
  type ExpenseCategory,
} from '../../../services/accounting.service';

const DISPOSITIONS: Disposition[] = ['rebill', 'durchlaufend', 'eigener_aufwand', 'duplikat', 'abgelehnt'];

const statusClasses: Record<string, string> = {
  unsorted: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  categorized: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  declined: 'bg-neutral-200 text-neutral-700 dark:bg-neutral-700 dark:text-neutral-300',
  duplicate: 'bg-neutral-200 text-neutral-700 dark:bg-neutral-700 dark:text-neutral-300',
};

const TriageModal: React.FC<{
  doc: InboundDocument;
  categories: ExpenseCategory[];
  onClose: () => void;
  onDone: () => void;
}> = ({ doc, categories, onClose, onDone }) => {
  const { t } = useTranslation();
  const [supplier, setSupplier] = useState(doc.supplierName || '');
  const [amountMajor, setAmountMajor] = useState<number>(doc.totalAmountMinor != null ? doc.totalAmountMinor / 100 : NaN);
  const [currency, setCurrency] = useState(doc.currency || 'CHF');
  const [invoiceDate, setInvoiceDate] = useState(doc.invoiceDate || '');
  const [disposition, setDisposition] = useState<Disposition>('eigener_aufwand');
  const [categoryId, setCategoryId] = useState<number | undefined>(undefined);
  const [declineReason, setDeclineReason] = useState('');
  const [customer, setCustomer] = useState<SelectedCustomer[]>([]);
  const [eventId, setEventId] = useState('');
  const [markupType, setMarkupType] = useState<MarkupType>('none');
  const [markupValue, setMarkupValue] = useState<number>(NaN);

  const totalMinor = Number.isFinite(amountMajor) ? Math.round(amountMajor * 100) : null;

  // Authenticated preview. PDFs are shown as SERVER-RASTERISED page images
  // (the raw PDF never reaches the browser); images stream directly. Start on
  // the LAST page — the Swiss QR-bill payment part sits at its bottom (no OCR;
  // the admin reads the slip and types the fields).
  const isPdf = (doc.mimeType || '').includes('pdf');
  const pageCount = doc.pageCount || 1;
  const [page, setPage] = useState(pageCount);
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState(false);
  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    setImgUrl(null);
    setPreviewError(false);
    const fetcher = isPdf
      ? accountingService.getInboundPageBlob(doc.id, page)
      : accountingService.getInboundFileBlob(doc.id);
    fetcher
      .then((blob) => { if (!cancelled) { url = URL.createObjectURL(blob); setImgUrl(url); } })
      .catch(() => { if (!cancelled) setPreviewError(true); });
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [doc.id, isPdf, page]);

  const save = useMutation({
    mutationFn: async () => {
      // 1) Confirm the document's fields (assist is never blind-trusted).
      await accountingService.updateInbound(doc.id, {
        supplierName: supplier || null,
        totalAmountMinor: totalMinor,
        currency: currency || null,
        invoiceDate: invoiceDate || null,
      });
      // 2) Create the expense with its disposition.
      const expense = await accountingService.categorizeInbound(doc.id, {
        disposition,
        supplierName: supplier || null,
        chfAmountMinor: totalMinor,
        grossAmountMinor: totalMinor,
        categoryId: disposition === 'eigener_aufwand' ? (categoryId ?? null) : null,
        declineReason: disposition === 'abgelehnt' ? (declineReason || null) : null,
        eventId: eventId ? Number(eventId) : null,
        customerAccountId: disposition === 'rebill' && customer[0] ? customer[0].id : null,
        markupType,
        markupPercent: markupType === 'percent' && Number.isFinite(markupValue) ? markupValue : null,
        markupFlatMinor: markupType === 'flat' && Number.isFinite(markupValue) ? Math.round(markupValue * 100) : null,
      });
      // 3) Re-bill mints the client invoice.
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
    onSuccess: () => {
      toast.success(t('accounting.inbox.categorizedToast', 'Document categorized.'));
      onDone();
    },
    onError: (e: any) => toast.error(e?.response?.data?.error || e.message || 'Failed'),
  });

  const rebillNeedsCustomer = disposition === 'rebill' && !customer[0];

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4">
      <div className="mt-10 w-full max-w-4xl rounded-xl bg-white dark:bg-neutral-900 shadow-xl">
        <div className="flex items-center justify-between border-b border-neutral-200 dark:border-neutral-700 px-5 py-3">
          <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
            {t('accounting.inbox.triageTitle', 'Categorize document')}
          </h2>
          <button onClick={onClose} aria-label={t('common.close', 'Close')} className="text-neutral-400 hover:text-neutral-600">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-5 py-4 grid grid-cols-1 lg:grid-cols-2 gap-5">
          {/* Document preview — PDFs open at the last page (QR-bill area). */}
          <div className="order-2 lg:order-1">
            <div className="overflow-auto rounded-md border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800" style={{ maxHeight: '60vh' }}>
              {previewError ? (
                <div className="flex h-[60vh] items-center justify-center px-3 text-center text-sm text-neutral-500">
                  {t('accounting.inbox.previewError', 'Preview unavailable — enter the fields manually.')}
                </div>
              ) : imgUrl ? (
                <img src={imgUrl} alt="document page" className="w-full h-auto" />
              ) : (
                <div className="flex h-[60vh] items-center justify-center text-sm text-neutral-500">
                  {t('accounting.inbox.previewLoading', 'Loading preview…')}
                </div>
              )}
            </div>
            {isPdf && pageCount > 1 && (
              <div className="mt-2 flex items-center justify-center gap-3 text-sm">
                <Button size="sm" variant="outline" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>{t('accounting.inbox.prevPage', 'Prev')}</Button>
                <span className="text-neutral-600 dark:text-neutral-400">{t('accounting.inbox.pageOf', 'Page {{n}} / {{total}}', { n: page, total: pageCount })}</span>
                <Button size="sm" variant="outline" onClick={() => setPage((p) => Math.min(pageCount, p + 1))} disabled={page >= pageCount}>{t('accounting.inbox.nextPage', 'Next')}</Button>
              </div>
            )}
            {isPdf && (
              <p className="mt-1 text-center text-xs text-neutral-500 dark:text-neutral-400">
                {t('accounting.inbox.qrHint', 'Showing the last page — the Swiss QR-bill usually sits at the bottom.')}
              </p>
            )}
          </div>

          {/* Triage form */}
          <div className="order-1 lg:order-2 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">{t('accounting.inbox.field.supplier', 'Supplier')}</label>
              <Input value={supplier} onChange={(e) => setSupplier(e.target.value)} />
            </div>
            <div>
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">{t('accounting.inbox.field.total', 'Total')}</label>
              <DecimalInput value={amountMajor} onChange={setAmountMajor} fractionDigits={2} className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">{t('accounting.inbox.field.currency', 'Currency')}</label>
              <Input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} maxLength={3} />
            </div>
            <div className="col-span-2">
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">{t('accounting.inbox.field.invoiceDate', 'Invoice date')}</label>
              <LocalizedDateInput value={invoiceDate} onChange={setInvoiceDate} />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">{t('accounting.inbox.field.disposition', 'Disposition')}</label>
            <select
              value={disposition}
              onChange={(e) => setDisposition(e.target.value as Disposition)}
              className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 px-3 py-2 text-sm"
            >
              {DISPOSITIONS.map((d) => (
                <option key={d} value={d}>{t(`accounting.disposition.${d}`, d)}</option>
              ))}
            </select>
          </div>

          {disposition === 'eigener_aufwand' && (
            <div>
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">{t('accounting.inbox.field.category', 'Category')}</label>
              <select
                value={categoryId ?? ''}
                onChange={(e) => setCategoryId(e.target.value ? Number(e.target.value) : undefined)}
                className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 px-3 py-2 text-sm"
              >
                <option value="">{t('accounting.inbox.field.categoryNone', '— none —')}</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
          )}

          {disposition === 'abgelehnt' && (
            <div>
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">{t('accounting.inbox.field.declineReason', 'Reason')}</label>
              <Input value={declineReason} onChange={(e) => setDeclineReason(e.target.value)} />
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
                  <select
                    value={markupType}
                    onChange={(e) => setMarkupType(e.target.value as MarkupType)}
                    className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 px-3 py-2 text-sm"
                  >
                    <option value="none">{t('accounting.markup.none', 'None / from contract')}</option>
                    <option value="percent">{t('accounting.markup.percent', 'Percent')}</option>
                    <option value="flat">{t('accounting.markup.flat', 'Flat')}</option>
                  </select>
                </div>
              </div>
              {markupType !== 'none' && (
                <DecimalInput value={markupValue} onChange={setMarkupValue} fractionDigits={2}
                  className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 px-3 py-2 text-sm"
                  placeholder={markupType === 'percent' ? '%' : currency} />
              )}
              <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('accounting.inbox.rebillHint', 'Creates an editable scheduled invoice on the client. VAT/tax handling is v1 — verify with your Treuhänder.')}</p>
            </div>
          )}
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-neutral-200 dark:border-neutral-700 px-5 py-3">
          <Button variant="outline" onClick={onClose}>{t('common.cancel', 'Cancel')}</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || rebillNeedsCustomer}>
            {save.isPending ? t('common.saving', 'Saving…') : t('accounting.inbox.saveCategorize', 'Save')}
          </Button>
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

  const { data, isLoading } = useQuery({
    queryKey: ['accounting-inbound'],
    queryFn: () => accountingService.listInbound({ pageSize: 100 }),
  });
  const { data: categories } = useQuery({
    queryKey: ['expense-categories'],
    queryFn: () => accountingService.listCategories(),
  });

  const upload = useMutation({
    mutationFn: ({ file, source }: { file: File; source: 'upload' | 'camera' }) => accountingService.uploadInbound(file, source),
    onSuccess: (doc) => {
      toast.success(t('accounting.inbox.capturedToast', 'Document captured.'));
      qc.invalidateQueries({ queryKey: ['accounting-inbound'] });
      if (doc.status === 'unsorted') setTriageDoc(doc); // jump straight into triage
    },
    onError: (e: any) => toast.error(e?.response?.data?.error || e.message || 'Upload failed'),
  });

  const onFile = (source: 'upload' | 'camera') => (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) upload.mutate({ file, source });
    e.target.value = '';
  };

  const items = data?.items ?? [];

  return (
    <div>
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={onFile('camera')} />
      <input ref={uploadRef} type="file" accept="image/*,application/pdf" className="hidden" onChange={onFile('upload')} />

      <Card className="mb-6">
        <CardContent className="flex flex-col sm:flex-row items-center gap-3 p-5">
          <div className="flex-1">
            <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">{t('accounting.inbox.captureTitle', 'Capture a supplier invoice')}</h2>
            <p className="text-sm text-neutral-600 dark:text-neutral-400">{t('accounting.inbox.captureBody', 'Photograph a paper invoice with your device camera, or upload a PDF / image.')}</p>
          </div>
          <Button onClick={() => cameraRef.current?.click()} disabled={upload.isPending}>
            <Camera className="w-4 h-4 mr-2" /> {t('accounting.inbox.scanCamera', 'Scan with camera')}
          </Button>
          <Button variant="outline" onClick={() => uploadRef.current?.click()} disabled={upload.isPending}>
            <Upload className="w-4 h-4 mr-2" /> {t('accounting.inbox.uploadFile', 'Upload file')}
          </Button>
        </CardContent>
      </Card>

      {isLoading ? (
        <Loading />
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-neutral-300 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-900 p-8 text-center">
          <Inbox className="w-10 h-10 mx-auto mb-3 text-neutral-400" />
          <p className="text-sm text-neutral-600 dark:text-neutral-400">{t('accounting.inbox.empty', 'No documents yet — capture one above.')}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((doc) => (
            <div key={doc.id} className="flex items-center gap-3 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-4 py-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${statusClasses[doc.status] || ''}`}>
                    {t(`accounting.inbox.status.${doc.status}`, doc.status)}
                  </span>
                  <span className="text-sm font-medium text-neutral-900 dark:text-neutral-100 truncate">
                    {doc.supplierName || doc.originalFilename || t('accounting.inbox.untitled', 'Untitled document')}
                  </span>
                  {doc.source === 'camera' && <Camera className="w-3.5 h-3.5 text-neutral-400" />}
                </div>
                <div className="text-xs text-neutral-500 dark:text-neutral-400">
                  {doc.totalAmountMinor != null ? formatMoneyMinor(doc.totalAmountMinor, doc.currency || 'CHF') : t('accounting.inbox.noAmount', 'amount not entered')}
                  {' · '}
                  {format(doc.createdAt)}
                </div>
              </div>
              {doc.status === 'unsorted' && (
                <Button size="sm" onClick={() => setTriageDoc(doc)}>{t('accounting.inbox.categorize', 'Categorize')}</Button>
              )}
            </div>
          ))}
        </div>
      )}

      {triageDoc && (
        <TriageModal
          doc={triageDoc}
          categories={categories ?? []}
          onClose={() => setTriageDoc(null)}
          onDone={() => {
            setTriageDoc(null);
            qc.invalidateQueries({ queryKey: ['accounting-inbound'] });
          }}
        />
      )}
    </div>
  );
};

export default AccountingInboxPage;
