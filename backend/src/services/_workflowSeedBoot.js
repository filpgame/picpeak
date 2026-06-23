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

function buildDunningGraph({ firstDays, gapDays, maxReminders }) {
  const nodes = [
    { node_key: 't', type: 'trigger', config: {}, pos_x: 240, pos_y: 0 },
    { node_key: 'waitDue', type: 'wait', config: { untilVar: 'dueDate' }, pos_x: 240, pos_y: 110 },
    { node_key: 'waitGrace', type: 'wait', config: { delayDays: firstDays }, pos_x: 240, pos_y: 220 },
    { node_key: 'checkPaid', type: 'condition', config: { condition: 'invoice_paid' }, pos_x: 240, pos_y: 330 },
    { node_key: 'gate', type: 'gate', config: { type: 'payment_confirm', prompt: 'No payment received yet — send a reminder?' }, pos_x: 240, pos_y: 440 },
    { node_key: 'loop', type: 'loop', config: { maxIterations: maxReminders }, pos_x: 240, pos_y: 550 },
    { node_key: 'remind', type: 'action', config: { action: 'send_email', recipientClass: 'customer', emailType: 'invoice_reminder' }, pos_x: 240, pos_y: 660 },
    { node_key: 'waitGap', type: 'wait', config: { delayDays: gapDays }, pos_x: 240, pos_y: 770 },
    { node_key: 'final', type: 'action', config: { action: 'send_email', recipientClass: 'customer', emailType: 'invoice_final_notice' }, pos_x: 520, pos_y: 660 },
    { node_key: 'doneEnd', type: 'action', config: { action: 'noop' }, pos_x: 520, pos_y: 770 },
    { node_key: 'donePaid', type: 'action', config: { action: 'noop' }, pos_x: 520, pos_y: 330 },
  ];
  const edges = [
    { from_node: 't', to_node: 'waitDue' },
    { from_node: 'waitDue', to_node: 'waitGrace' },
    { from_node: 'waitGrace', to_node: 'checkPaid' },
    { from_node: 'checkPaid', from_handle: 'yes', to_node: 'donePaid' },
    { from_node: 'checkPaid', from_handle: 'no', to_node: 'gate' },
    { from_node: 'gate', from_handle: 'confirm', to_node: 'loop' },
    { from_node: 'gate', from_handle: 'deny', to_node: 'donePaid' },
    { from_node: 'loop', from_handle: 'loop', to_node: 'remind' },
    { from_node: 'loop', from_handle: 'exit', to_node: 'final' },
    { from_node: 'remind', to_node: 'waitGap' },
    { from_node: 'waitGap', to_node: 'checkPaid', loop_back: true },
    { from_node: 'final', to_node: 'doneEnd' },
  ];
  return { nodes, edges };
}

let booted = false;

async function seedBuiltinWorkflowsAtBoot(db, logger) {
  try {
    if (!(await db.schema.hasTable('workflows'))) return;
    const existing = await db('workflows').where({ builtin_key: DUNNING_KEY }).first();
    if (existing) { booted = true; return; }

    const firstDays = Number(await getAppSetting('crm_invoices_reminder_first_days')) || 14;
    const secondDays = Number(await getAppSetting('crm_invoices_reminder_second_days')) || 30;
    const gapDays = Math.max(1, secondDays - firstDays);
    const { nodes, edges } = buildDunningGraph({ firstDays, gapDays, maxReminders: 2 });

    await db.transaction(async (trx) => {
      const ins = await trx('workflows').insert({
        name: 'Invoice dunning (built-in)',
        description: 'Editable copy of the overdue-reminder ladder: wait to due date, '
          + 'confirm-no-payment gate, then up to two reminders before a final notice. '
          + 'Disabled by default — the live reminder ladder still runs via the scheduler '
          + 'until an explicit cutover, so enabling this without that change would double-send.',
        enabled: false,
        version: 1,
        trigger_type: 'invoice.sent',
        trigger_config: null,
        is_builtin: true,
        builtin_key: DUNNING_KEY,
      });
      const workflowId = ins[0];
      for (const n of nodes) {
        await trx('workflow_nodes').insert({
          workflow_id: workflowId, version: 1, node_key: n.node_key, type: n.type,
          config: JSON.stringify(n.config || {}), pos_x: n.pos_x || 0, pos_y: n.pos_y || 0,
        });
      }
      for (const e of edges) {
        await trx('workflow_edges').insert({
          workflow_id: workflowId, version: 1, from_node: e.from_node, from_handle: e.from_handle || null,
          to_node: e.to_node, label: e.label || null, loop_back: !!e.loop_back,
        });
      }
    });

    booted = true;
    logger?.info?.('Seeded built-in workflow: invoice dunning (disabled)');
  } catch (err) {
    logger?.warn?.('Built-in workflow seed failed at boot:', err.message);
  }
}

module.exports = { seedBuiltinWorkflowsAtBoot, buildDunningGraph, DUNNING_KEY };
