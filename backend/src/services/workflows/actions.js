/**
 * Workflow action + condition handlers that touch real picpeak data.
 *
 * Registered at load time (index.js requires this module). Kept separate from
 * registry.js (which holds only primitives) so the I/O-coupled handlers don't
 * bloat the pure core.
 *
 * Email routing rule (locked requirement): INTERNAL/admin mail sends
 * immediately; EXTERNAL/customer mail respects the business-hours floor. The
 * action sets queueEmail's `respectBusinessHours` from the recipient class.
 *
 * The create/prepare-document actions (quote/contract/event/gallery/invoice)
 * are registered so flows validate, but are intentionally NOT wired to the
 * services yet — they record a `skipped` step with a clear reason so the gap
 * is observable rather than silent. Wiring is a follow-up commit.
 */
const registry = require('./registry');

const DOCUMENT_ACTIONS = [
  'prepare_quote',
  'prepare_contract',
  'prepare_event',
  'prepare_gallery',
  'prepare_invoice',
  'send_document',
  'reserve_date',
];

// --- Conditions ---

// True once the run's invoice entity is settled (paid_at set, status paid, or
// the cumulative paid amount covers the total).
registry.registerCondition('invoice_paid', async (ctx) => {
  const id = ctx.run.entity_id;
  if (!id) return false;
  const inv = await ctx.db('invoices').where({ id }).first();
  if (!inv) return false;
  if (inv.paid_at) return true;
  if (inv.status === 'paid') return true;
  const paid = Number(inv.paid_amount_minor) || 0;
  const total = Number(inv.total_amount_minor);
  return Number.isFinite(total) && total > 0 && paid >= total;
});

// --- Actions ---

// Queue an email. recipientClass 'admin' (internal) sends immediately;
// anything else (customer/external) respects the business-hours floor.
registry.registerAction('send_email', async (ctx) => {
  const cfg = ctx.node.config || {};
  const recipientClass = cfg.recipientClass || cfg.recipient || 'customer';
  const isInternal = recipientClass === 'admin' || recipientClass === 'internal';
  const to = cfg.to
    || ctx.vars[isInternal ? 'adminEmail' : 'customerEmail']
    || ctx.vars.recipientEmail;
  if (!to) return { skipped: true, reason: 'no recipient resolved' };

  const emailProcessor = require('../emailProcessor');
  const eventId = ctx.vars.eventId || null;
  const emailType = cfg.emailType || cfg.template || 'workflow_notification';
  const emailData = { ...(cfg.emailData || {}), ...(ctx.vars.emailData || {}) };

  // INTERNAL/admin = immediate; EXTERNAL/customer = business-hours floor.
  const respectBusinessHours = !isInternal;
  await emailProcessor.queueEmail(eventId, to, emailType, emailData, { respectBusinessHours });
  return { sent_to: to, recipientClass, respectBusinessHours };
});

// Fire the existing admin payment-check email (the dunning gate). Delegates to
// invoiceService.queuePaymentCheckEmail so the proven escalation +
// Mahngebühr / reminder_level state machine (recordPaymentCheckAction) stays
// the single source of truth — the workflow only decides WHEN it fires. This
// is what makes the built-in dunning flow a faithful replacement for the
// hardcoded ladder (paired with the mutual-exclusion guard in runScheduledTasks).
registry.registerAction('queue_payment_check', async (ctx) => {
  const id = ctx.run.entity_id;
  if (!id) return { skipped: true, reason: 'no invoice entity' };
  await require('../invoiceService').queuePaymentCheckEmail(id);
  return { payment_check_queued: id };
});

// Create/prepare-document actions — registered so flows referencing them are
// valid; service wiring is a follow-up. Records a skipped step (observable).
for (const key of DOCUMENT_ACTIONS) {
  registry.registerAction(key, async (ctx) => {
    ctx.logger?.warn?.('[workflow] document action not yet wired', { action: key, runId: ctx.run.id });
    return { skipped: true, reason: `action ${key} not yet implemented` };
  });
}

module.exports = { DOCUMENT_ACTIONS };
