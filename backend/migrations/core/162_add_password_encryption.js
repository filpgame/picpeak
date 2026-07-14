exports.up = async (knex) => {
  const hasEncrypted = await knex.schema.hasColumn('events', 'password_encrypted');
  const hasIv = await knex.schema.hasColumn('events', 'password_iv');
  const hasVersion = await knex.schema.hasColumn('events', 'password_key_version');

  if (hasEncrypted && hasIv && hasVersion) return;
  await knex.schema.alterTable('events', (table) => {
    if (!hasEncrypted) table.text('password_encrypted').nullable();
    if (!hasIv) table.text('password_iv').nullable();
    if (!hasVersion) table.integer('password_key_version').nullable().defaultTo(1);
  });
};

exports.down = async (knex) => {
  const hasEncrypted = await knex.schema.hasColumn('events', 'password_encrypted');
  const hasIv = await knex.schema.hasColumn('events', 'password_iv');
  const hasVersion = await knex.schema.hasColumn('events', 'password_key_version');

  if (!hasEncrypted && !hasIv && !hasVersion) return;
  await knex.schema.alterTable('events', (table) => {
    if (hasEncrypted) table.dropColumn('password_encrypted');
    if (hasIv) table.dropColumn('password_iv');
    if (hasVersion) table.dropColumn('password_key_version');
  });
};