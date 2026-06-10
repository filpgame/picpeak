import { api } from '../config/api';

// Mirrors backend transformInbound / transformExpense (camelCase).
export type InboundStatus = 'unsorted' | 'categorized' | 'declined' | 'duplicate';
export type Disposition = 'rebill' | 'durchlaufend' | 'eigener_aufwand' | 'duplikat' | 'abgelehnt';
export type TaxTreatment = 'domestic' | 'reverse_charge_service' | 'foreign_vat_non_reclaimable' | 'import_goods';
export type MarkupType = 'none' | 'percent' | 'flat';
export type PaymentMethod = 'bank_transfer' | 'cash' | 'twint' | 'paypal' | 'card' | 'other';

export interface InboundDocument {
  id: number;
  source: 'upload' | 'camera' | 'email' | 'manual';
  originalFilename: string | null;
  mimeType: string | null;
  status: InboundStatus;
  parseStatus: 'pending' | 'parsed' | 'failed' | 'manual';
  parseMethod: string | null;
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
  duplicateOfId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface Expense {
  id: number;
  inboundDocumentId: number | null;
  disposition: Disposition;
  taxTreatment: TaxTreatment;
  eventId: number | null;
  customerAccountId: number | null;
  supplierName: string | null;
  description: string | null;
  chfAmountMinor: number | null;
  grossAmountMinor: number | null;
  markupType: MarkupType;
  markupPercent: number | null;
  markupFlatMinor: number | null;
  categoryId: number | null;
  billedInvoiceId: number | null;
  supplierPaid: boolean;
  status: 'open' | 'parked' | 'billed' | 'declined';
  createdAt: string;
  updatedAt: string;
}

export interface ExpenseCategory {
  id: number;
  name: string;
  color: string | null;
  is_seed: boolean;
  display_order: number;
}

export interface Paginated<T> {
  items: T[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

export interface CategorizePayload {
  disposition: Disposition;
  supplierName?: string | null;
  description?: string | null;
  chfAmountMinor?: number | null;
  netAmountMinor?: number | null;
  vatAmountMinor?: number | null;
  grossAmountMinor?: number | null;
  taxTreatment?: TaxTreatment;
  categoryId?: number | null;
  eventId?: number | null;
  customerAccountId?: number | null;
  declineReason?: string | null;
  duplicateOfId?: number | null;
  markupType?: MarkupType;
  markupPercent?: number | null;
  markupFlatMinor?: number | null;
}

export interface RebillPayload {
  customerAccountId: number;
  eventId?: number | null;
  contractId?: number | null;
  markupType?: MarkupType;
  markupPercent?: number | null;
  markupFlatMinor?: number | null;
}

export const accountingService = {
  async uploadInbound(file: File, source: 'upload' | 'camera' = 'upload'): Promise<InboundDocument> {
    const form = new FormData();
    form.append('file', file);
    form.append('source', source);
    const { data } = await api.post('/admin/expenses/inbound', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return data.document;
  },

  async listInbound(params: { status?: InboundStatus; page?: number; pageSize?: number } = {}): Promise<Paginated<InboundDocument>> {
    const { data } = await api.get('/admin/expenses/inbound', { params });
    return data;
  },

  async getInbound(id: number): Promise<InboundDocument> {
    const { data } = await api.get(`/admin/expenses/inbound/${id}`);
    return data.document;
  },

  async getInboundFileBlob(id: number): Promise<Blob> {
    const { data } = await api.get(`/admin/expenses/inbound/${id}/file`, { responseType: 'blob' });
    return data;
  },

  // Rasterised PDF page (PNG) — the raw PDF is never sent to the browser.
  async getInboundPageBlob(id: number, page: number): Promise<Blob> {
    const { data } = await api.get(`/admin/expenses/inbound/${id}/page/${page}`, { responseType: 'blob' });
    return data;
  },

  async updateInbound(id: number, fields: Partial<Pick<InboundDocument,
    'supplierName' | 'invoiceNumber' | 'invoiceDate' | 'dueDate' | 'currency' |
    'netAmountMinor' | 'vatAmountMinor' | 'totalAmountMinor' | 'iban' | 'paymentReference'>>): Promise<InboundDocument> {
    const { data } = await api.patch(`/admin/expenses/inbound/${id}`, fields);
    return data.document;
  },

  async categorizeInbound(id: number, payload: CategorizePayload): Promise<Expense> {
    const { data } = await api.post(`/admin/expenses/inbound/${id}/categorize`, payload);
    return data.expense;
  },

  // Create a manual expense (no inbound document).
  async createExpense(payload: CategorizePayload): Promise<Expense> {
    const { data } = await api.post('/admin/expenses', payload);
    return data.expense;
  },

  async rebill(expenseId: number, payload: RebillPayload): Promise<{ expense: Expense; invoiceId: number }> {
    const { data } = await api.post(`/admin/expenses/${expenseId}/rebill`, payload);
    return data;
  },

  async setSupplierPayment(expenseId: number, payload: { paid: boolean; paidAt?: string; paymentMethod?: PaymentMethod; paymentReference?: string }): Promise<Expense> {
    const { data } = await api.post(`/admin/expenses/${expenseId}/supplier-payment`, payload);
    return data.expense;
  },

  async listExpenses(params: { status?: string; disposition?: Disposition; customerAccountId?: number; eventId?: number; page?: number; pageSize?: number } = {}): Promise<Paginated<Expense>> {
    const { data } = await api.get('/admin/expenses', { params });
    return data;
  },

  async listCategories(): Promise<ExpenseCategory[]> {
    const { data } = await api.get('/admin/expenses/categories');
    return data.items;
  },
};
