/**
 * Fix event email language always defaulting to English.
 *
 * events.language was added with defaultTo('en'), which means every event
 * inserted without an explicit language gets language='en'. The email
 * processor checks event.language first (before app_settings
 * general_default_language), so the 'en' default always wins and the system
 * language setting is never reached.
 *
 * Fix: reset all DB-defaulted 'en' values to NULL and change the column
 * default to NULL. NULL means "use system default" — getRecipientLanguage
 * already falls through to app_settings when event.language is falsy.
 */
exports.up = async function(knex) {
  // On a fresh install the language column is added by legacy/027, which runs
  // after core migrations. Skip gracefully — fresh installs have no events to
  // reset and the INSERT paths already set language=null explicitly.
  const hasColumn = await knex.schema.hasColumn('events', 'language');
  if (!hasColumn) return;

  // Reset all 'en' values set by the DB default.
  // Since there is no UI for per-event language, every 'en' value came from
  // the column default, not from an explicit admin choice.
  await knex('events').update({ language: null }).where('language', 'en');

  // Change the column default to NULL so future inserts also fall through to
  // general_default_language. Knex recreates the table for SQLite, which is
  // the only supported way to change a column default on that driver.
  await knex.schema.alterTable('events', (table) => {
    table.string('language', 5).defaultTo(null).alter();
  });
};

exports.down = async function(knex) {
  const hasColumn = await knex.schema.hasColumn('events', 'language');
  if (!hasColumn) return;

  await knex.schema.alterTable('events', (table) => {
    table.string('language', 5).defaultTo('en').alter();
  });
  // Rows with language=NULL came from this migration; restore to 'en'.
  await knex('events').update({ language: 'en' }).whereNull('language');
};
