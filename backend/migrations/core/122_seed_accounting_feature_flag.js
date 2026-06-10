/**
 * Migration 122: seed the `accounting` feature flag (default OFF).
 *
 * Gates the new top-level Accounting area (inbound supplier invoices,
 * billable / re-billable expenses, Erfolgsrechnung). Admins opt in under
 * Settings → Features. Separate from the CRM `bills` flag.
 *
 * Idempotent: inserts only when the row is missing (mirrors the
 * 095_add_customer_portal_flag pattern). 107_crm_consolidated already
 * shipped its flag set on fresh installs and won't re-run.
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('feature_flags'))) return;
  const existing = await knex('feature_flags').where({ key: 'accounting' }).first();
  if (existing) return;
  await knex('feature_flags').insert({ key: 'accounting', value: false });
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('feature_flags'))) return;
  await knex('feature_flags').where({ key: 'accounting' }).del();
};
