/**
 * Boot-time seed for built-in workflows.
 *
 * Seeds the invoice-dunning ladder as an EDITABLE built-in flow (the corrected
 * gate-in-loop graph), so the canvas has real content and admins can see their
 * reminder process as blocks. Seeded from the current reminder settings.
 *
 * IMPORTANT — seeded DISABLED, and live behaviour is UNCHANGED: the existing
 * hardcoded reminder ladder in invoiceService.runScheduledTasks still runs. The
 * cutover (drive reminders through the engine + stop the hardcoded ladder) is a
 * deliberate follow-up so we never double-send. Enabling this flow before that
 * cutover would duplicate reminders — hence default off.
 *
 * Idempotent: keyed on builtin_key='invoice_dunning'. Once seeded, admin edits
 * are preserved (we never overwrite an existing built-in). Self-heal pattern
 * per [[feedback_self_heal_pattern]].
 */
const { getAppSetting } = require('../utils/appSettings');

const DUNNING_KEY = 'invoice_dunning';
// Bump when the built-in graph changes so a disabled, never-activated copy is
// re-seeded on boot. v2 = the delegation/cutover graph (payment-check gate).
const SEED_VERSION = 2;

function buildDunningGraph({ firstDays, gapDays, maxReminders }) {
  // Delegation model: the payment-check email IS the admin gate (it drives the
  // existing confirm + reminder_level + Mahngebühr state machine), so the flow
  // just decides WHEN to fire it. After due date + grace, loop up to
  // maxReminders times: if still unpaid, queue a payment-check, wait the gap,
  // repeat; stop early once paid.
  const nodes = [
    { node_key: 't', type: 'trigger', config: {}, pos_x: 240, pos_y: 0 },
    { node_key: 'waitDue', type: 'wait', config: { untilVar: 'dueDate' }, pos_x: 240, pos_y: 110 },
    { node_key: 'waitGrace', type: 'wait', config: { delayDays: firstDays }, pos_x: 240, pos_y: 220 },
    { node_key: 'loop', type: 'loop', config: { maxIterations: maxReminders }, pos_x: 240, pos_y: 330 },
    { node_key: 'checkPaid', type: 'condition', config: { condition: 'invoice_paid' }, pos_x: 240, pos_y: 440 },
    { node_key: 'paymentCheck', type: 'action', config: { action: 'queue_payment_check' }, pos_x: 240, pos_y: 550 },
    { node_key: 'waitGap', type: 'wait', config: { delayDays: gapDays }, pos_x: 240, pos_y: 660 },
    { node_key: 'donePaid', type: 'action', config: { action: 'noop' }, pos_x: 520, pos_y: 440 },
    { node_key: 'doneEnd', type: 'action', config: { action: 'noop' }, pos_x: 520, pos_y: 330 },
  ];
  const edges = [
    { from_node: 't', to_node: 'waitDue' },
    { from_node: 'waitDue', to_node: 'waitGrace' },
    { from_node: 'waitGrace', to_node: 'loop' },
    { from_node: 'loop', from_handle: 'loop', to_node: 'checkPaid' },
    { from_node: 'loop', from_handle: 'exit', to_node: 'doneEnd' },
    { from_node: 'checkPaid', from_handle: 'yes', to_node: 'donePaid' },
    { from_node: 'checkPaid', from_handle: 'no', to_node: 'paymentCheck' },
    { from_node: 'paymentCheck', to_node: 'waitGap' },
    { from_node: 'waitGap', to_node: 'loop', loop_back: true },
  ];
  return { nodes, edges };
}

let booted = false;

function parseSeedConfig(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw) || {}; } catch (e) { return {}; }
}

async function writeGraph(trx, workflowId, version, nodes, edges) {
  for (const n of nodes) {
    await trx('workflow_nodes').insert({
      workflow_id: workflowId, version, node_key: n.node_key, type: n.type,
      config: JSON.stringify(n.config || {}), pos_x: n.pos_x || 0, pos_y: n.pos_y || 0,
    });
  }
  for (const e of edges) {
    await trx('workflow_edges').insert({
      workflow_id: workflowId, version, from_node: e.from_node, from_handle: e.from_handle || null,
      to_node: e.to_node, label: e.label || null, loop_back: !!e.loop_back,
    });
  }
}

async function seedBuiltinWorkflowsAtBoot(db, logger) {
  try {
    if (!(await db.schema.hasTable('workflows'))) return;

    const firstDays = Number(await getAppSetting('crm_invoices_reminder_first_days')) || 14;
    const secondDays = Number(await getAppSetting('crm_invoices_reminder_second_days')) || 30;
    const gapDays = Math.max(1, secondDays - firstDays);
    const { nodes, edges } = buildDunningGraph({ firstDays, gapDays, maxReminders: 2 });

    const description = 'Drives overdue dunning through the engine: wait to the due date, then up '
      + 'to two payment-check cycles. Each cycle fires the existing admin confirm-payment email '
      + '(the gate), which applies reminders + Mahngebühr via the proven payment-check flow. '
      + 'Disabled by default; while it is enabled the hardcoded reminder ladder is skipped '
      + 'automatically, so the two never double-send.';

    const existing = await db('workflows').where({ builtin_key: DUNNING_KEY }).first();

    if (existing) {
      // Re-seed the graph only when (a) it has never been activated and (b) our
      // seed version moved on (the dunning cutover). Once the admin enables it,
      // it's their live flow — never overwrite it.
      const storedVersion = Number(parseSeedConfig(existing.trigger_config).seedVersion) || 0;
      const isEnabled = existing.enabled === true || existing.enabled === 1;
      if (isEnabled || storedVersion >= SEED_VERSION) { booted = true; return; }

      const newVersion = (existing.version || 1) + 1;
      await db.transaction(async (trx) => {
        await trx('workflows').where({ id: existing.id }).update({
          name: 'Invoice dunning (built-in)',
          description,
          trigger_config: JSON.stringify({ seedVersion: SEED_VERSION }),
          version: newVersion,
          updated_at: trx.fn.now(),
        });
        await writeGraph(trx, existing.id, newVersion, nodes, edges);
      });
      booted = true;
      logger?.info?.('Re-seeded built-in workflow: invoice dunning (delegation graph v2)');
      return;
    }

    await db.transaction(async (trx) => {
      const ins = await trx('workflows').insert({
        name: 'Invoice dunning (built-in)',
        description,
        enabled: false,
        version: 1,
        trigger_type: 'invoice.sent',
        trigger_config: JSON.stringify({ seedVersion: SEED_VERSION }),
        is_builtin: true,
        builtin_key: DUNNING_KEY,
      }).returning('id');
      // Postgres returns [] without `.returning`, so ins[0] would be undefined
      // and the child node inserts would roll back on NOT NULL. Normalise the
      // {id} (pg) vs bare-id (sqlite) shapes.
      const workflowId = ins[0]?.id ?? ins[0];
      await writeGraph(trx, workflowId, 1, nodes, edges);
    });

    booted = true;
    logger?.info?.('Seeded built-in workflow: invoice dunning (disabled)');
  } catch (err) {
    logger?.warn?.('Built-in workflow seed failed at boot:', err.message);
  }
}

module.exports = { seedBuiltinWorkflowsAtBoot, buildDunningGraph, DUNNING_KEY };
