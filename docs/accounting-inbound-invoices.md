# Accounting — Inbound supplier invoices, expenses & re-bill (MVP)

> **Status:** new feature, in development on `feat/accounting-inbound-invoices` (based on `upstream/beta`).
> **Maintainer scope decision required** before merge — this introduces a new top-level **Accounting** area, separate from CRM (see "Scope decisions" below).
> **Legal:** every VAT / tax-treatment surface is an *example only* and must be reviewed with a Treuhänder before relying on it. Jurisdiction scope is **Liechtenstein-first** (Swiss/LI rails — QR-bill, LI MWST), not German DATEV/ELSTER.

## Why
The studio receives supplier invoices/receipts (hotels, equipment, fremdleistungen). Today they live in email/paper and are re-typed. This feature lets an admin **capture an incoming invoice** (upload, or **phone/tablet camera**), have its fields **best-effort extracted**, then give it a **disposition** — most importantly **re-bill it to a client** ("Weiterverrechnung") onto the relevant event's invoice with a contract-driven markup.

This mirrors the existing **billable-hours** model (`customerHoursService`): an item is parked against a customer/event and folded into an invoice as a line item.

## Scope decisions (maintainer)
1. **New top-level "Accounting" area**, gated behind a new `accounting` feature flag (default OFF) and `accounting.view` / `accounting.manage` permissions — *not* bolted onto CRM. The existing tax-export page is a candidate to move here later (not in this MVP).
2. **picpeak owns documents + books up to the export boundary**; certified external systems (Treuhänder / Abacus / Bexio) own statutory filing.
3. **No paperless-ngx sidecar** — picpeak is the system of record; files live under `storage/` and are covered by the existing `backup_paths` walker.

## MVP scope (this branch)
- **Intake**: file upload **and camera capture** (phone/tablet) → `POST /api/admin/expenses/inbound` (accepts PDF + JPEG/PNG). Stored as the system of record; deduped by SHA-256.
- **Best-effort extraction** (`extractionService`): ladder of Swiss-QR decode → PDF text layer → OCR. *Scaffolded with the interface in place; the heavy extractors (Tesseract OS package, QR decoder, isolated rasterise worker) are a follow-up — see "Deferred".*
- **Inbox**: list documents as **„Neu / Unsortiert"**; parsed fields are editable/confirmable (parsing is assist, never blind trust). The **QR-encoded amount is stored separately** and surfaced for tamper cross-check — the **authoritative total is the text/line-item value**.
- **5 dispositions**: `rebill` (Weiterverrechnen) · `durchlaufend` (Durchlaufender Posten) · `eigener_aufwand` (company expense) · `duplikat` · `abgelehnt` (with reason).
- **Re-bill flow**: event-scoped (one event → one customer). Markup resolved **expense override → contract `Spesen-Zuschlag` clause → 0%** (percent or flat). Mints an editable **scheduled** invoice (admin can add more lines) — same pattern as `billUnbilledEntries`.
- **Supplier-payment status** (decoupled from categorisation): „Zu zahlen / Bezahlt" with `payment_method` (unified with the outgoing list incl. **bank_transfer**).
- **Expense categories**: seeded + admin-editable (colored label) — feed the future Erfolgsrechnung.
- **`tax_treatment` captured from day 1** (`domestic` default) — stored for the books; reclaim/Bezugsteuer math is future (switches on when `business_profile.vat_id` is set).

## Data model (migrations 122–125)
Numbered from **122** to avoid colliding with the in-flight `feat/crm-improvements` migrations **117–121** (which are expected to merge first). If this lands before that branch, renumber to 117+.

- **122** — seed `accounting` feature flag (default OFF).
- **123** — seed `accounting.view` / `accounting.manage` permissions + grant to super_admin/admin.
- **124** — `inbound_documents`, `expenses`, `expense_categories` (+ seed categories).
- **125** — `contracts.expense_markup_type|_percent|_flat_minor` (the Spesen-Zuschlag clause).

Key tables (all money in integer minor units, `*_amount_minor`):
- `inbound_documents` — raw received doc + parsed/confirmable fields + `qr_amount_minor` (separate, untrusted) + `status` (unsorted/categorized/declined/duplicate).
- `expenses` — the booking: `disposition`, `tax_treatment`, `event_id`, `customer_account_id`, FX (`original_*` + `chf_amount_minor` + `fx_locked`), `markup_type/_percent/_flat_minor`, `category_id`, `billed_invoice_id`, supplier-payment fields, `status`.
- `expense_categories` — seeded colored labels.

## API (`/api/admin/expenses`, gated by `accounting` flag + `accounting.*`)
- `POST /inbound` (multipart) — capture an inbound doc (upload/camera).
- `GET  /inbound` — list (filter by status, paginated).
- `GET  /inbound/:id` — one doc.
- `PATCH /inbound/:id` — confirm/edit parsed fields.
- `POST /inbound/:id/categorize` — create an expense with a disposition.
- `POST / ` — create a manual expense (no document).
- `GET  / ` — list expenses (filter by status/disposition/customer/event).
- `GET  /:id` — one expense.
- `PATCH /:id` — edit (locked once billed).
- `POST /:id/rebill` — re-bill to a client (event-scoped, contract markup) → scheduled invoice.
- `POST /:id/supplier-payment` — toggle supplier paid + method.
- `GET/POST/PATCH/DELETE /categories` — manage expense categories.

## Camera capture (step 3)
The `POST /inbound` endpoint accepts images, so a **mobile web** widget using
`<input type="file" accept="image/*" capture="environment">` already enables phone/tablet camera capture — **no native app required for v1**. A native document-scanner (edge-detect/dewarp, multi-page) is a later UX upgrade that improves OCR accuracy.

## Deferred (follow-ups)
- Real extraction: Tesseract OCR (OS package in the Docker image, shell-out — *not* a sidecar), Swiss-QR decoder, **network-isolated rasterise worker** (no egress), CSP-locked image preview, never serve the raw PDF.
- Email intake (`rechnungen@…` IMAP poll, forwarded-message parsing, message-id dedupe).
- Bank reconciliation, FX auto-lock backstop (30-day), Erfolgsrechnung, customer-account close guard.
- Frontend: the Accounting tab UI (inbox, disposition actions, re-bill dialog) + the camera widget.

## Conventions followed
Idempotent migrations (hasTable/hasColumn-guarded); new flag default OFF; flag reads tolerate `true|1|'1'`; money as integer `*_minor`; `requirePermission` guards; camelCase API ↔ snake_case service; multer + `safePath` containment at every file boundary; localized dates on display; tax/legal surfaces carry a "verify with Treuhänder" disclaimer.
