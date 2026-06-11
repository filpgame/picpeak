import { api } from '../config/api';

export type InboundStatus = 'unsorted' | 'categorized' | 'declined' | 'duplicate';
export type Disposition = 'rebill' | 'durchlaufend' | 'eigener_aufwand' | 'duplikat' | 'abgelehnt';
export type TaxTreatment = 'domestic' | 'reverse_charge_service' | 'foreign_vat_non_reclaimable' | 'import_goods';
export type MarkupType = 'none' | 'percent' | 'flat';
export type PaymentMethod = 'bank_transfer' | 'cash' | 'twint' | 'paypal' | 'card' | 'other';
export type ExpenseKind = 'amount' | 'mileage' | 'per_diem';

/** Incoming invoice (external supplier document). The payable lives here. */
export interface InboundDocument {
  id: number;
  source: 'upload' | 'camera' | 'email' | 'manual';
  originalFilename: string | null;
  mimeType: string | null;
  status: InboundStatus;
  parseStatus: 'pending' | 'parsed' | 'failed' | 'manual';
  pageCount: number | null;
  supplierName: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  currency: string | null;
  netAmountMinor: number | null;
  vatAmountMinor: number | null;
  totalAmountMinor: number | null;
  qrAmountMinor: number | null;
  iban: string | null;
  paymentReference: string | null;
  disposition: Disposition | null;
  taxTreatment: TaxTreatment | null;
  eventId: number | null;
  categoryId: number | null;
  markupType: MarkupType | null;
  markupPercent: number | null;
  markupFlatMinor: number | null;
  billedInvoiceId: number | null;
  supplierPaid: boolean;
  supplierPaidAt: string | null;
  supplierPaymentMethod: PaymentMethod | null;
  supplierPaymentRef: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Internal expense (own cost). */
export interface Expense {
  id: number;
  kind: ExpenseKind;
  quantity: number | null;
  rateMinor: number | null;
  eventId: number | null; // null = company
  supplierName: string | null;
  description: string | null;
  chfAmountMinor: number | null;
  categoryId: number | null;
  hasProof: boolean;
  taxTreatment: TaxTreatment | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface ExpenseCategory { id: number; name: string; color: string | null; is_seed: boolean; display_order: number; }
export interface Paginated<T> { items: T[]; pagination: { page: number; pageSize: number; total: number; totalPages: number }; }

export interface AccountingSettings {
  accounting_km_rate_minor: number;
  accounting_per_diem_rate_minor: number;
  accounting_require_proof: boolean;
}

export interface CategorizePayload {
  disposition: Disposition;
  taxTreatment?: TaxTreatment;
  eventId?: number | null;
  categoryId?: number | null;
  customerAccountId?: number | null; // re-bill
  contractId?: number | null;
  markupType?: MarkupType;
  markupPercent?: number | null;
  markupFlatMinor?: number | null;
  duplicateOfId?: number | null;
}

export interface ExpensePayload {
  kind: ExpenseKind;
  quantity?: number;
  rateMinor?: number;        // per-entry override
  chfAmountMinor?: number;   // kind 'amount'
  eventId?: number | null;   // null = company
  categoryId?: number | null;
  supplierName?: string | null;
  description?: string | null;
  taxTreatment?: TaxTreatment;
}

function expenseFormData(payload: ExpensePayload, file?: File | null): FormData {
  const fd = new FormData();
  fd.append('kind', payload.kind);
  if (payload.quantity != null && Number.isFinite(payload.quantity)) fd.append('quantity', String(payload.quantity));
  if (payload.rateMinor != null && Number.isFinite(payload.rateMinor)) fd.append('rateMinor', String(payload.rateMinor));
  if (payload.chfAmountMinor != null && Number.isFinite(payload.chfAmountMinor)) fd.append('chfAmountMinor', String(payload.chfAmountMinor));
  if (payload.eventId != null) fd.append('eventId', String(payload.eventId));
  if (payload.categoryId != null) fd.append('categoryId', String(payload.categoryId));
  if (payload.supplierName) fd.append('supplierName', payload.supplierName);
  if (payload.description) fd.append('description', payload.description);
  if (payload.taxTreatment) fd.append('taxTreatment', payload.taxTreatment);
  if (file) fd.append('proof', file);
  return fd;
}

export const accountingService = {
  // ── incoming invoices ──
  async uploadInbound(file: File, source: 'upload' | 'camera' = 'upload'): Promise<InboundDocument> {
    const fd = new FormData(); fd.append('file', file); fd.append('source', source);
    const { data } = await api.post('/admin/expenses/inbound', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
    return data.document;
  },
  async listInbound(params: { status?: InboundStatus; page?: number; pageSize?: number } = {}): Promise<Paginated<InboundDocument>> {
    const { data } = await api.get('/admin/expenses/inbound', { params }); return data;
  },
  async getInbound(id: number): Promise<InboundDocument> { const { data } = await api.get(`/admin/expenses/inbound/${id}`); return data.document; },
  async updateInbound(id: number, fields: Partial<InboundDocument>): Promise<InboundDocument> { const { data } = await api.patch(`/admin/expenses/inbound/${id}`, fields); return data.document; },
  async categorizeInbound(id: number, payload: CategorizePayload): Promise<InboundDocument> { const { data } = await api.post(`/admin/expenses/inbound/${id}/categorize`, payload); return data.document; },
  async rebillInbound(id: number, payload: CategorizePayload): Promise<{ document: InboundDocument; invoiceId: number }> { const { data } = await api.post(`/admin/expenses/inbound/${id}/rebill`, payload); return data; },
  async markInboundPaid(id: number, payload: { paid: boolean; paidAt?: string; paymentMethod?: PaymentMethod; paymentReference?: string }): Promise<InboundDocument> { const { data } = await api.post(`/admin/expenses/inbound/${id}/supplier-payment`, payload); return data.document; },
  async getInboundFileBlob(id: number): Promise<Blob> { const { data } = await api.get(`/admin/expenses/inbound/${id}/file`, { responseType: 'blob' }); return data; },
  async getInboundPageBlob(id: number, page: number): Promise<Blob> { const { data } = await api.get(`/admin/expenses/inbound/${id}/page/${page}`, { responseType: 'blob' }); return data; },

  // ── expenses (internal) ──
  async listExpenses(params: { kind?: ExpenseKind; categoryId?: number; eventId?: number | 'company'; page?: number; pageSize?: number } = {}): Promise<Paginated<Expense>> {
    const { data } = await api.get('/admin/expenses', { params }); return data;
  },
  async getExpense(id: number): Promise<Expense> { const { data } = await api.get(`/admin/expenses/${id}`); return data.expense; },
  async createExpense(payload: ExpensePayload, file?: File | null): Promise<Expense> {
    const { data } = await api.post('/admin/expenses', expenseFormData(payload, file), { headers: { 'Content-Type': 'multipart/form-data' } });
    return data.expense;
  },
  async updateExpense(id: number, payload: ExpensePayload, file?: File | null): Promise<Expense> {
    const { data } = await api.patch(`/admin/expenses/${id}`, expenseFormData(payload, file), { headers: { 'Content-Type': 'multipart/form-data' } });
    return data.expense;
  },
  async getExpenseProofBlob(id: number): Promise<Blob> { const { data } = await api.get(`/admin/expenses/${id}/proof`, { responseType: 'blob' }); return data; },

  // ── categories + settings ──
  async listCategories(): Promise<ExpenseCategory[]> { const { data } = await api.get('/admin/expenses/categories'); return data.items; },
  async getSettings(): Promise<AccountingSettings> {
    const { data } = await api.get('/admin/settings/accounting');
    return {
      accounting_km_rate_minor: Number(data.accounting_km_rate_minor) || 0,
      accounting_per_diem_rate_minor: Number(data.accounting_per_diem_rate_minor) || 0,
      accounting_require_proof: data.accounting_require_proof === true,
    };
  },
  async updateSettings(payload: Partial<AccountingSettings>): Promise<{ updated: string[] }> {
    const { data } = await api.put('/admin/settings/accounting', payload); return data;
  },
};

// Seed categories are stored with literal German names; localize them by a
// stable key. Admin-created categories show their own free-text name.
const SEED_CATEGORY_KEYS: Record<string, string> = {
  'Infrastruktur & Miete': 'infrastructure',
  'Equipment & Hardware': 'equipment',
  'Software & Lizenzen': 'software',
  'Material & Verbrauch': 'material',
  'Reise & Spesen': 'travel',
  'Werbung & Marketing': 'marketing',
  'Dienstleistungen/Fremdleistungen': 'services',
  'Versicherungen & Gebühren': 'insurance',
  'Weiterbildung': 'training',
  'Sonstiges': 'other',
};
export function categoryLabel(cat: ExpenseCategory, t: (k: string, d?: string) => string): string {
  if (cat?.is_seed && SEED_CATEGORY_KEYS[cat.name]) return t(`accounting.category.${SEED_CATEGORY_KEYS[cat.name]}`, cat.name);
  return cat?.name ?? '';
}
