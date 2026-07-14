exports.up = async function(knex) {
  const hasLanguage = await knex.schema.hasColumn('events', 'language');
  if (!hasLanguage) {
    await knex.schema.alterTable('events', (table) => {
      table.string('language', 5).nullable().defaultTo(null);
    });
    return;
  }

  await knex('events').where('language', 'en').update({ language: null });
  await knex.schema.alterTable('events', (table) => {
    table.string('language', 5).nullable().defaultTo(null).alter();
  });
};

exports.down = async function(knex) {
  const hasLanguage = await knex.schema.hasColumn('events', 'language');
  if (!hasLanguage) return;

  await knex.schema.alterTable('events', (table) => {
    table.string('language', 5).defaultTo('en').alter();
  });
  await knex('events').whereNull('language').update({ language: 'en' });
};