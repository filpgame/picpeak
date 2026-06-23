/**
 * Admin workflow management API.
 *
 *   GET    /api/admin/workflows                     list
 *   GET    /api/admin/workflows/approvals           pending-approval inbox
 *   POST   /api/admin/workflows/approvals/:id/:act  confirm|deny (webview)
 *   GET    /api/admin/workflows/runs/:runId/steps   run step audit
 *   GET    /api/admin/workflows/:id/runs            run history
 *   GET    /api/admin/workflows/:id                 one workflow + its graph
 *   POST   /api/admin/workflows                     create
 *   PUT    /api/admin/workflows/:id                 update (bumps version)
 *   PATCH  /api/admin/workflows/:id/enabled         enable/disable
 *   DELETE /api/admin/workflows/:id                 delete (built-ins refused)
 *
 * Versioning: editing writes a fresh node/edge set under version+1 and bumps
 * workflows.version; in-flight runs keep executing the version they pinned.
 * All endpoints gated by the `workflows` feature flag + RBAC (view/manage).
 */
const express = require('express');

const router = express.Router();
const { db } = require('../database/db');
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { requireFeatureFlag } = require('../middleware/requireFeatureFlag');
const workflows = require('../services/workflows');

router.use(adminAuth, requireFeatureFlag('workflows'));

function parseJson(v, fallback) {
  if (v == null) return fallback;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (e) { return fallback; }
}

function validateGraph(body) {
  const nodes = Array.isArray(body.nodes) ? body.nodes : [];
  const edges = Array.isArray(body.edges) ? body.edges : [];
  const triggers = nodes.filter((n) => n.type === 'trigger');
  if (triggers.length !== 1) return 'A workflow must have exactly one trigger node';
  if (nodes.some((n) => !n.node_key || !n.type)) return 'Every node needs a node_key and type';
  const keys = new Set(nodes.map((n) => n.node_key));
  if (keys.size !== nodes.length) return 'Duplicate node_key in graph';
  for (const e of edges) {
    if (!keys.has(e.from_node) || !keys.has(e.to_node)) return 'Edge references an unknown node';
  }
  return null;
}

async function writeGraph(trx, workflowId, version, nodes = [], edges = []) {
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

// --- Approvals inbox (registered before /:id so 'approvals' isn't an id) ---
router.get('/approvals', requirePermission('workflows.view'), async (req, res, next) => {
  try {
    const items = await workflows.listPending();
    res.json(items.map((a) => ({ ...a, payload: parseJson(a.payload, {}) })));
  } catch (e) { next(e); }
});

router.post('/approvals/:id/:action', requirePermission('workflows.manage'), async (req, res, next) => {
  try {
    const { action } = req.params;
    if (!['confirm', 'deny'].includes(action)) return res.status(400).json({ error: 'Invalid action' });
    const result = await workflows.actById(Number(req.params.id), action, req.admin?.id);
    if (!result.ok && result.reason === 'not_found') return res.status(404).json({ error: 'Approval not found' });
    if (!result.ok && result.reason === 'expired') return res.status(410).json({ error: 'Approval expired' });
    res.json(result);
  } catch (e) { next(e); }
});

// --- Run history ---
router.get('/runs/:runId/steps', requirePermission('workflows.view'), async (req, res, next) => {
  try {
    const steps = await db('workflow_run_steps').where({ run_id: Number(req.params.runId) }).orderBy('id', 'asc');
    res.json(steps.map((s) => ({ ...s, result: parseJson(s.result, null) })));
  } catch (e) { next(e); }
});

router.get('/:id/runs', requirePermission('workflows.view'), async (req, res, next) => {
  try {
    const runs = await db('workflow_runs').where({ workflow_id: Number(req.params.id) }).orderBy('id', 'desc').limit(200);
    res.json(runs.map((r) => ({ ...r, context: parseJson(r.context, {}) })));
  } catch (e) { next(e); }
});

// Test-fire: run the workflow on demand (default dry-run — side effects mocked,
// waits skipped, gates auto-confirm) and return the step-by-step log.
router.post('/:id/test-run', requirePermission('workflows.manage'), async (req, res, next) => {
  try {
    const { entityType, entityId, payload, dryRun } = req.body || {};
    const runId = await workflows.testRun(Number(req.params.id), {
      entityType: entityType || null,
      entityId: entityId != null && entityId !== '' ? Number(entityId) : null,
      payload: payload && typeof payload === 'object' ? payload : {},
      dryRun: dryRun !== false, // default true (safe)
    });
    const run = await db('workflow_runs').where({ id: runId }).first();
    const steps = await db('workflow_run_steps').where({ run_id: runId }).orderBy('id', 'asc');
    res.json({
      runId,
      dryRun: dryRun !== false,
      status: run?.status,
      steps: steps.map((s) => ({ ...s, result: parseJson(s.result, null) })),
    });
  } catch (e) { next(e); }
});

// --- List / get ---
router.get('/', requirePermission('workflows.view'), async (req, res, next) => {
  try {
    const rows = await db('workflows').orderBy('id', 'desc');
    res.json(rows.map((w) => ({ ...w, trigger_config: parseJson(w.trigger_config, null) })));
  } catch (e) { next(e); }
});

router.get('/:id', requirePermission('workflows.view'), async (req, res, next) => {
  try {
    const wf = await db('workflows').where({ id: Number(req.params.id) }).first();
    if (!wf) return res.status(404).json({ error: 'Workflow not found' });
    const nodes = await db('workflow_nodes').where({ workflow_id: wf.id, version: wf.version });
    const edges = await db('workflow_edges').where({ workflow_id: wf.id, version: wf.version });
    res.json({
      ...wf,
      trigger_config: parseJson(wf.trigger_config, null),
      nodes: nodes.map((n) => ({ ...n, config: parseJson(n.config, {}) })),
      edges,
    });
  } catch (e) { next(e); }
});

// --- Create / update / toggle / delete ---
router.post('/', requirePermission('workflows.manage'), async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.name || !b.trigger_type) return res.status(400).json({ error: 'name and trigger_type are required' });
    const err = validateGraph(b);
    if (err) return res.status(400).json({ error: err });
    const id = await db.transaction(async (trx) => {
      const ins = await trx('workflows').insert({
        name: b.name, description: b.description || null, enabled: !!b.enabled, version: 1,
        trigger_type: b.trigger_type, trigger_config: b.trigger_config ? JSON.stringify(b.trigger_config) : null,
        created_by: req.admin?.id || null,
      }).returning('id');
      // Postgres returns [] without an explicit returning clause, so ins[0]
      // would be undefined → the child node inserts would violate NOT NULL.
      // Normalise the {id} (pg) vs bare id (sqlite) shapes.
      const newId = ins[0]?.id ?? ins[0];
      await writeGraph(trx, newId, 1, b.nodes, b.edges);
      return newId;
    });
    res.status(201).json({ id });
  } catch (e) { next(e); }
});

router.put('/:id', requirePermission('workflows.manage'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const wf = await db('workflows').where({ id }).first();
    if (!wf) return res.status(404).json({ error: 'Workflow not found' });
    const b = req.body || {};
    const err = validateGraph(b);
    if (err) return res.status(400).json({ error: err });
    const newVersion = wf.version + 1;
    await db.transaction(async (trx) => {
      await trx('workflows').where({ id }).update({
        name: b.name ?? wf.name,
        description: b.description ?? wf.description,
        enabled: b.enabled != null ? !!b.enabled : wf.enabled,
        trigger_type: b.trigger_type ?? wf.trigger_type,
        trigger_config: b.trigger_config !== undefined
          ? (b.trigger_config ? JSON.stringify(b.trigger_config) : null)
          : wf.trigger_config,
        version: newVersion,
        updated_at: trx.fn.now(),
      });
      await writeGraph(trx, id, newVersion, b.nodes, b.edges);
    });
    res.json({ id, version: newVersion });
  } catch (e) { next(e); }
});

router.patch('/:id/enabled', requirePermission('workflows.manage'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const enabled = !!(req.body && req.body.enabled);
    const updated = await db('workflows').where({ id }).update({ enabled, updated_at: db.fn.now() });
    if (!updated) return res.status(404).json({ error: 'Workflow not found' });
    res.json({ id, enabled });
  } catch (e) { next(e); }
});

router.delete('/:id', requirePermission('workflows.manage'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const wf = await db('workflows').where({ id }).first();
    if (!wf) return res.status(404).json({ error: 'Workflow not found' });
    if (wf.is_builtin) return res.status(409).json({ error: 'Built-in workflows cannot be deleted' });
    await db.transaction(async (trx) => {
      const runIds = (await trx('workflow_runs').where({ workflow_id: id }).select('id')).map((r) => r.id);
      if (runIds.length) {
        await trx('workflow_run_steps').whereIn('run_id', runIds).del();
        await trx('workflow_approvals').whereIn('run_id', runIds).del();
      }
      await trx('workflow_runs').where({ workflow_id: id }).del();
      await trx('workflow_edges').where({ workflow_id: id }).del();
      await trx('workflow_nodes').where({ workflow_id: id }).del();
      await trx('workflows').where({ id }).del();
    });
    res.json({ deleted: true });
  } catch (e) { next(e); }
});

module.exports = router;
