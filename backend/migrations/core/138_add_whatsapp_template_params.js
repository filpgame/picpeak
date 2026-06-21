/**
 * Migration 138: WhatsApp template parameter selection (#647 follow-up).
 *
 * Adds a `template_params` column to `whatsapp_configs` that stores an
 * ordered JSON array of slot keys naming which built-in values are sent
 * as positional parameters to the configured Meta template (and in what
 * order). Reporter @Rekoo-PS hit the gap that motivated this: their
 * template body uses only `{{1}} = event_name` + `{{2}} = gallery_link`,
 * but the hardcoded `buildComponents` shape always emitted 5 parameters
 * matching `gallery_ready` — so Meta rejected with a parameter-count
 * mismatch even after the language fix landed (migration 137).
 *
 * Schema: TEXT column, empty/null means "fall back to the legacy 5-slot
 * shape" so installs that haven't reconfigured continue to work without
 * intervention. The processor's `buildComponents` reads this column,
 * parses the array, and emits only the listed slots in the listed order.
 *
 * Known slot keys (any other keys are ignored): `customer_name`,
 * `event_name`, `gallery_link`, `password_line`, `expiry_date`.
 *
 * Additive + `hasColumn`-guarded. The settling number depends on the
 * merge order with PR #646; flagged for renumber if that lands first.
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('whatsapp_configs'))) return;
  if (await knex.schema.hasColumn('whatsapp_configs', 'template_params')) return;
  await knex.schema.alterTable('whatsapp_configs', (table) => {
    table.text('template_params').notNullable().defaultTo('');
  });
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('whatsapp_configs'))) return;
  if (!(await knex.schema.hasColumn('whatsapp_configs', 'template_params'))) return;
  await knex.schema.alterTable('whatsapp_configs', (table) => {
    table.dropColumn('template_params');
  });
};
