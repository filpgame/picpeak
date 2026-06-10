/**
 * Expense / inbound-document service (migration 124).
 *
 * Captures received supplier invoices (upload / camera), lets the admin give
 * them a disposition, and — for "rebill" (Weiterverrechnung) — folds the cost
 * onto a client's event invoice as a line item. The re-bill flow mirrors
 * customerHoursService.billUnbilledEntries: resolve amount + markup, then
 * createInvoice({ customerAccountId, eventId, lineItems }) and stamp the
 * source row billed.
 *
 * Money is integer minor units throughout. The QR-encoded amount on an
 * inbound document is stored separately and NEVER used as the authoritative
 * total. All VAT/tax handling here is v1 (capture-only) and must be reviewed
 * with a Treuhänder before being relied upon.
 */
const crypto = require('crypto');
const fsp = require('fs').promises;
const { db, logActivity } = require('../database/db');
const { AppError } = require('../utils/errors');
const { hasColumnCached } = require('../utils/schemaCache');
const logger = require('../utils/logger');
const invoiceService = require('./invoiceService');

const DISPOSITIONS = ['rebill', 'durchlaufend', 'eigener_aufwand', 'duplikat', 'abgelehnt'];
const TAX_TREATMENTS = ['domestic', 'reverse_charge_service', 'foreign_vat_non_reclaimable', 'import_goods'];
const MARKUP_TYPES = ['none', 'percent', 'flat'];
const PAYMENT_METHODS = ['bank_transfer', 'cash', 'twint', 'paypal', 'card', 'other'];

// Disposition → inbound_documents.status once categorised.
const DISPOSITION_DOC_STATUS = {
  rebill: 'categorized',
  durchlaufend: 'categorized',
  eigener_aufwand: 'categorized',
  duplikat: 'duplicate',
  abgelehnt: 'declined',
};

function toIsoDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10); // PG datetime or SQLite bare date both normalise here
}

function parseTags(raw) {
  if (!raw) return [];
  try { const a = JSON.parse(raw); return Array.isArray(a) ? a : []; } catch (_e) { return []; }
}

function transformInbound(row) {
  if (!row) return null;
  return {
    id: row.id,
    source: row.source,
    originalFilename: row.original_filename,
    mimeType: row.mime_type,
    status: row.status,
    parseStatus: row.parse_status,
    parseMethod: row.parse_method,
    parseError: row.parse_error,
    supplierName: row.supplier_name,
    invoiceNumber: row.invoice_number,
    invoiceDate: toIsoDate(row.invoice_date),
    dueDate: toIsoDate(row.due_date),
    currency: row.currency,
    netAmountMinor: row.net_amount_minor,
    vatAmountMinor: row.vat_amount_minor,
    totalAmountMinor: row.total_amount_minor,
    qrAmountMinor: row.qr_amount_minor,
    iban: row.iban,
    paymentReference: row.payment_reference,
    duplicateOfId: row.duplicate_of_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function transformExpense(row) {
  if (!row) return null;
  return {
    id: row.id,
    inboundDocumentId: row.inbound_document_id,
    disposition: row.disposition,
    taxTreatment: row.tax_treatment,
    eventId: row.event_id,
    customerAccountId: row.customer_account_id,
    supplierName: row.supplier_name,
    description: row.description,
    originalCurrency: row.original_currency,
    originalAmountMinor: row.original_amount_minor,
    chfAmountMinor: row.chf_amount_minor,
    fxLocked: !!row.fx_locked,
    fxLockReason: row.fx_lock_reason,
    netAmountMinor: row.net_amount_minor,
    vatAmountMinor: row.vat_amount_minor,
    grossAmountMinor: row.gross_amount_minor,
    markupType: row.markup_type,
    markupPercent: row.markup_percent != null ? Number(row.markup_percent) : null,
    markupFlatMinor: row.markup_flat_minor,
    categoryId: row.category_id,
    tags: parseTags(row.tags),
    billedInvoiceId: row.billed_invoice_id,
    billedInvoiceLineItemId: row.billed_invoice_line_item_id,
    unbilledParked: !!row.unbilled_parked,
    billedAt: row.billed_at,
    supplierPaid: !!row.supplier_paid,
    supplierPaidAt: row.supplier_paid_at,
    paymentMethod: row.payment_method,
    paymentReference: row.payment_reference,
    declineReason: row.decline_reason,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function clampPage(page, pageSize) {
  const p = Math.max(1, parseInt(page, 10) || 1);
  const ps = Math.min(100, Math.max(1, parseInt(pageSize, 10) || 25));
  return { p, ps };
}

async function sha256OfFile(filePath) {
  const buf = await fsp.readFile(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// ── Inbound documents ──────────────────────────────────────────────────────

/**
 * Persist a received document (the system of record) and run best-effort
 * extraction. Duplicates (same SHA-256) are flagged but still stored.
 */
async function recordInboundDocument({ source, filePath, originalFilename, mimeType }, adminId) {
  let fileSha256 = null;
  try { fileSha256 = await sha256OfFile(filePath); } catch (e) {
    logger.warn?.(`expenseService: could not hash ${filePath}: ${e.message}`);
  }

  let duplicateOfId = null;
  if (fileSha256) {
    const dup = await db('inbound_documents').where({ file_sha256: fileSha256 }).first('id');
    if (dup) duplicateOfId = dup.id;
  }

  // Best-effort extraction (currently a no-op scaffold — see extractionService).
  let parse = { parsed: false, method: 'none', fields: {} };
  try {
    // eslint-disable-next-line global-require
    const extractionService = require('./extractionService');
    parse = await extractionService.extract(filePath, mimeType);
  } catch (e) {
    parse = { parsed: false, method: 'none', fields: {}, error: e.message };
  }
  const f = parse.fields || {};

  const now = new Date();
  const row = {
    source: source || 'upload',
    original_filename: originalFilename || null,
    file_path: filePath,
    mime_type: mimeType || null,
    file_sha256: fileSha256,
    status: duplicateOfId ? 'duplicate' : 'unsorted',
    parse_status: parse.error ? 'failed' : (parse.parsed ? 'parsed' : 'pending'),
    parse_method: parse.method || 'none',
    parse_error: parse.error || null,
    supplier_name: f.supplierName || null,
    invoice_number: f.invoiceNumber || null,
    invoice_date: f.invoiceDate || null,
    due_date: f.dueDate || null,
    currency: f.currency || null,
    net_amount_minor: Number.isInteger(f.netAmountMinor) ? f.netAmountMinor : null,
    vat_amount_minor: Number.isInteger(f.vatAmountMinor) ? f.vatAmountMinor : null,
    total_amount_minor: Number.isInteger(f.totalAmountMinor) ? f.totalAmountMinor : null,
    qr_amount_minor: Number.isInteger(f.qrAmountMinor) ? f.qrAmountMinor : null,
    iban: f.iban || null,
    payment_reference: f.paymentReference || null,
    raw_parsed: parse.raw ? JSON.stringify(parse.raw) : null,
    duplicate_of_id: duplicateOfId,
    created_by_admin_id: adminId || null,
    created_at: now,
    updated_at: now,
  };
  const inserted = await db('inbound_documents').insert(row).returning('id');
  const id = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];
  await logActivity('expense_inbound_captured', { inboundDocumentId: id, source: row.source, duplicate: !!duplicateOfId }, adminId);
  return getInbound(id);
}

async function getInbound(id) {
  const row = await db('inbound_documents').where({ id }).first();
  if (!row) throw new AppError('Inbound document not found', 404, 'INBOUND_NOT_FOUND');
  return transformInbound(row);
}

async function listInbound({ status, page, pageSize } = {}) {
  const { p, ps } = clampPage(page, pageSize);
  const base = db('inbound_documents');
  if (status) base.where({ status });
  const countRow = await base.clone().count({ count: '*' }).first();
  const total = parseInt(countRow?.count || 0, 10);
  const rows = await base.clone()
    .orderBy('created_at', 'desc')
    .limit(ps).offset((p - 1) * ps);
  return {
    items: rows.map(transformInbound),
    pagination: { page: p, pageSize: ps, total, totalPages: Math.ceil(total / ps) },
  };
}

const INBOUND_EDITABLE = {
  supplierName: 'supplier_name', invoiceNumber: 'invoice_number', invoiceDate: 'invoice_date',
  dueDate: 'due_date', currency: 'currency', netAmountMinor: 'net_amount_minor',
  vatAmountMinor: 'vat_amount_minor', totalAmountMinor: 'total_amount_minor', iban: 'iban',
  paymentReference: 'payment_reference',
};

/** Confirm / correct best-effort parsed fields (assist is never blind-trusted). */
async function updateInbound(id, payload, adminId) {
  await getInbound(id);
  const patch = { updated_at: new Date(), parse_status: 'manual' };
  for (const [camel, snake] of Object.entries(INBOUND_EDITABLE)) {
    if (payload[camel] !== undefined) patch[snake] = payload[camel] === '' ? null : payload[camel];
  }
  await db('inbound_documents').where({ id }).update(patch);
  await logActivity('expense_inbound_updated', { inboundDocumentId: id }, adminId);
  return getInbound(id);
}

// ── Expenses ───────────────────────────────────────────────────────────────

function buildExpenseInsert(payload, adminId) {
  const now = new Date();
  const disposition = payload.disposition;
  if (!DISPOSITIONS.includes(disposition)) {
    throw new AppError(`disposition must be one of ${DISPOSITIONS.join(', ')}`, 400, 'BAD_DISPOSITION');
  }
  const taxTreatment = payload.taxTreatment && TAX_TREATMENTS.includes(payload.taxTreatment)
    ? payload.taxTreatment : 'domestic';
  const markupType = payload.markupType && MARKUP_TYPES.includes(payload.markupType)
    ? payload.markupType : 'none';
  let status = 'open';
  if (disposition === 'abgelehnt') status = 'declined';
  else if (payload.unbilledParked) status = 'parked';

  return {
    inbound_document_id: payload.inboundDocumentId || null,
    disposition,
    tax_treatment: taxTreatment,
    event_id: payload.eventId || null,
    customer_account_id: payload.customerAccountId || null,
    supplier_name: payload.supplierName || null,
    description: payload.description || null,
    original_currency: payload.originalCurrency || null,
    original_amount_minor: Number.isInteger(payload.originalAmountMinor) ? payload.originalAmountMinor : null,
    chf_amount_minor: Number.isInteger(payload.chfAmountMinor) ? payload.chfAmountMinor : null,
    fx_locked: !!payload.fxLocked,
    fx_lock_reason: payload.fxLockReason || null,
    net_amount_minor: Number.isInteger(payload.netAmountMinor) ? payload.netAmountMinor : null,
    vat_amount_minor: Number.isInteger(payload.vatAmountMinor) ? payload.vatAmountMinor : null,
    gross_amount_minor: Number.isInteger(payload.grossAmountMinor) ? payload.grossAmountMinor : null,
    markup_type: markupType,
    markup_percent: markupType === 'percent' && payload.markupPercent != null ? payload.markupPercent : null,
    markup_flat_minor: markupType === 'flat' && Number.isInteger(payload.markupFlatMinor) ? payload.markupFlatMinor : null,
    category_id: payload.categoryId || null,
    tags: Array.isArray(payload.tags) ? JSON.stringify(payload.tags) : null,
    unbilled_parked: !!payload.unbilledParked,
    decline_reason: disposition === 'abgelehnt' ? (payload.declineReason || null) : null,
    status,
    created_by_admin_id: adminId || null,
    created_at: now,
    updated_at: now,
  };
}

async function getExpense(id) {
  const row = await db('expenses').where({ id }).first();
  if (!row) throw new AppError('Expense not found', 404, 'EXPENSE_NOT_FOUND');
  return transformExpense(row);
}

async function createManualExpense(payload, adminId) {
  const row = buildExpenseInsert(payload, adminId);
  const inserted = await db('expenses').insert(row).returning('id');
  const id = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];
  await logActivity('expense_created', { expenseId: id, disposition: row.disposition }, adminId);
  return getExpense(id);
}

/** Create an expense FROM an inbound document and move the doc out of "Unsortiert". */
async function categorizeInbound(inboundId, payload, adminId) {
  const doc = await getInbound(inboundId);
  return db.transaction(async (trx) => {
    const row = buildExpenseInsert({
      // Seed expense fields from the (confirmed) document, payload overrides win.
      supplierName: doc.supplierName,
      chfAmountMinor: doc.totalAmountMinor,
      netAmountMinor: doc.netAmountMinor,
      vatAmountMinor: doc.vatAmountMinor,
      grossAmountMinor: doc.totalAmountMinor,
      originalCurrency: doc.currency,
      ...payload,
      inboundDocumentId: inboundId,
    }, adminId);
    const inserted = await trx('expenses').insert(row).returning('id');
    const id = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];

    const docStatus = DISPOSITION_DOC_STATUS[row.disposition] || 'categorized';
    const docPatch = { status: docStatus, updated_at: new Date() };
    if (row.disposition === 'duplikat' && payload.duplicateOfId) {
      docPatch.duplicate_of_id = payload.duplicateOfId;
    }
    await trx('inbound_documents').where({ id: inboundId }).update(docPatch);

    await logActivity('expense_categorized', { expenseId: id, inboundDocumentId: inboundId, disposition: row.disposition }, adminId);
    const created = await trx('expenses').where({ id }).first();
    return transformExpense(created);
  });
}

async function listExpenses({ status, disposition, customerAccountId, eventId, page, pageSize } = {}) {
  const { p, ps } = clampPage(page, pageSize);
  const base = db('expenses');
  if (status) base.where({ status });
  if (disposition) base.where({ disposition });
  if (customerAccountId) base.where({ customer_account_id: customerAccountId });
  if (eventId) base.where({ event_id: eventId });
  const countRow = await base.clone().count({ count: '*' }).first();
  const total = parseInt(countRow?.count || 0, 10);
  const rows = await base.clone()
    .orderBy('created_at', 'desc')
    .limit(ps).offset((p - 1) * ps);
  return {
    items: rows.map(transformExpense),
    pagination: { page: p, pageSize: ps, total, totalPages: Math.ceil(total / ps) },
  };
}

const EXPENSE_EDITABLE = {
  supplierName: 'supplier_name', description: 'description', taxTreatment: 'tax_treatment',
  eventId: 'event_id', customerAccountId: 'customer_account_id', categoryId: 'category_id',
  originalCurrency: 'original_currency', originalAmountMinor: 'original_amount_minor',
  chfAmountMinor: 'chf_amount_minor', netAmountMinor: 'net_amount_minor',
  vatAmountMinor: 'vat_amount_minor', grossAmountMinor: 'gross_amount_minor',
  markupType: 'markup_type', markupPercent: 'markup_percent', markupFlatMinor: 'markup_flat_minor',
  declineReason: 'decline_reason',
};

async function updateExpense(id, payload, adminId) {
  const existing = await getExpense(id);
  if (existing.billedInvoiceId) {
    throw new AppError('Expense already billed — edit is locked', 409, 'EXPENSE_LOCKED');
  }
  const patch = { updated_at: new Date() };
  for (const [camel, snake] of Object.entries(EXPENSE_EDITABLE)) {
    if (payload[camel] !== undefined) patch[snake] = payload[camel] === '' ? null : payload[camel];
  }
  if (payload.tags !== undefined) patch.tags = Array.isArray(payload.tags) ? JSON.stringify(payload.tags) : null;
  // FX lock: once locked, the converted amount can't drift.
  if (existing.fxLocked && (patch.chf_amount_minor !== undefined)) {
    throw new AppError('FX amount is locked (bank-reconciled or billed)', 409, 'FX_LOCKED');
  }
  await db('expenses').where({ id }).update(patch);
  await logActivity('expense_updated', { expenseId: id }, adminId);
  return getExpense(id);
}

/** Toggle the supplier-payment status (decoupled from categorisation). */
async function setSupplierPayment(id, { paid, paidAt, paymentMethod, paymentReference }, adminId) {
  await getExpense(id);
  if (paymentMethod && !PAYMENT_METHODS.includes(paymentMethod)) {
    throw new AppError(`paymentMethod must be one of ${PAYMENT_METHODS.join(', ')}`, 400, 'BAD_PAYMENT_METHOD');
  }
  const patch = {
    supplier_paid: !!paid,
    supplier_paid_at: paid ? (paidAt ? new Date(paidAt) : new Date()) : null,
    payment_method: paid ? (paymentMethod || null) : null,
    payment_reference: paid ? (paymentReference || null) : null,
    updated_at: new Date(),
  };
  await db('expenses').where({ id }).update(patch);
  await logActivity('expense_supplier_payment', { expenseId: id, paid: !!paid }, adminId);
  return getExpense(id);
}

/**
 * Resolve the markup to apply: explicit override → expense's own clause →
 * the event's contract Spesen-Zuschlag clause → none (0%).
 * Returns { type, percent, flatMinor }.
 */
async function resolveMarkup(expense, override, contractId, trx) {
  const pick = (type, percent, flatMinor) => ({
    type: MARKUP_TYPES.includes(type) ? type : 'none',
    percent: percent != null ? Number(percent) : null,
    flatMinor: Number.isInteger(flatMinor) ? flatMinor : null,
  });
  if (override && override.markupType && override.markupType !== 'none') {
    return pick(override.markupType, override.markupPercent, override.markupFlatMinor);
  }
  if (expense.markupType && expense.markupType !== 'none') {
    return pick(expense.markupType, expense.markupPercent, expense.markupFlatMinor);
  }
  if (contractId && (await hasColumnCached('contracts', 'expense_markup_type'))) {
    const c = await (trx || db)('contracts').where({ id: contractId })
      .first('expense_markup_type', 'expense_markup_percent', 'expense_markup_flat_minor');
    if (c && c.expense_markup_type && c.expense_markup_type !== 'none') {
      return pick(c.expense_markup_type, c.expense_markup_percent, c.expense_markup_flat_minor);
    }
  }
  return pick('none', null, null);
}

function computeMarkupMinor(baseMinor, markup) {
  if (markup.type === 'percent' && markup.percent != null) {
    return Math.round(baseMinor * Number(markup.percent) / 100);
  }
  if (markup.type === 'flat' && Number.isInteger(markup.flatMinor)) {
    return markup.flatMinor;
  }
  return 0;
}

/**
 * Re-bill an expense to a client (Weiterverrechnung). Event-scoped: one event
 * → one customer. Mints an editable scheduled invoice with a single line
 * (cost + markup), then stamps the expense billed + FX-locked. Mirrors
 * customerHoursService.billUnbilledEntries.
 *
 * For monthly/manual-cadence customers, createInvoice appends the line to the
 * running draft instead (its accumulator intercept) — same as logged hours.
 */
async function rebillToEvent(expenseId, payload, adminId) {
  const { customerAccountId, eventId, contractId } = payload;
  if (!customerAccountId) throw new AppError('customerAccountId is required to re-bill', 400, 'CUSTOMER_REQUIRED');

  return db.transaction(async (trx) => {
    const row = await trx('expenses').where({ id: expenseId }).first();
    if (!row) throw new AppError('Expense not found', 404, 'EXPENSE_NOT_FOUND');
    const expense = transformExpense(row);
    if (expense.billedInvoiceId) throw new AppError('Expense already billed', 409, 'ALREADY_BILLED');

    const baseMinor = expense.chfAmountMinor != null ? expense.chfAmountMinor
      : (expense.grossAmountMinor != null ? expense.grossAmountMinor : null);
    if (baseMinor == null) throw new AppError('Expense has no amount to re-bill', 400, 'AMOUNT_REQUIRED');

    const markup = await resolveMarkup(expense, payload, contractId, trx);
    const markupMinor = computeMarkupMinor(baseMinor, markup);
    const lineTotalMinor = baseMinor + markupMinor;

    const label = (expense.description || expense.supplierName || 'Weiterverrechnete Auslage');
    const lineItem = {
      description: `${label} (Weiterverrechnung)`,
      quantity: 1,
      unit_price_minor: lineTotalMinor,
      discount_percent: 0,
      line_total_minor: lineTotalMinor,
    };

    const { invoiceIds } = await invoiceService.createInvoice({
      customerAccountId,
      eventId: eventId || expense.eventId || null,
      lineItems: [lineItem],
    }, adminId, trx);
    const invoiceId = Array.isArray(invoiceIds) ? invoiceIds[0] : null;
    if (!invoiceId) throw new AppError('Failed to create the re-bill invoice', 500, 'REBILL_FAILED');

    // Newest line in this invoice within the transaction is the one we added.
    const line = await trx('invoice_line_items').where({ invoice_id: invoiceId })
      .orderBy('id', 'desc').first('id');

    const now = new Date();
    await trx('expenses').where({ id: expenseId }).update({
      disposition: 'rebill',
      status: 'billed',
      event_id: eventId || expense.eventId || null,
      customer_account_id: customerAccountId,
      markup_type: markup.type,
      markup_percent: markup.type === 'percent' ? markup.percent : null,
      markup_flat_minor: markup.type === 'flat' ? markup.flatMinor : null,
      billed_invoice_id: invoiceId,
      billed_invoice_line_item_id: line ? line.id : null,
      billed_at: now,
      fx_locked: true,
      fx_lock_reason: 'billed',
      updated_at: now,
    });

    await logActivity('expense_rebilled', {
      expenseId, invoiceId, customerAccountId, baseMinor, markupMinor, lineTotalMinor,
    }, adminId);

    const updated = await trx('expenses').where({ id: expenseId }).first();
    return { expense: transformExpense(updated), invoiceId };
  });
}

module.exports = {
  // inbound documents
  recordInboundDocument,
  getInbound,
  listInbound,
  updateInbound,
  categorizeInbound,
  // expenses
  createManualExpense,
  getExpense,
  listExpenses,
  updateExpense,
  setSupplierPayment,
  rebillToEvent,
  // constants (for route validators)
  DISPOSITIONS,
  TAX_TREATMENTS,
  MARKUP_TYPES,
  PAYMENT_METHODS,
};
