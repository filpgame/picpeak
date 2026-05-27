exports.up = async (knex) => {
  const hasPasswordEncrypted = await knex.schema.hasColumn('events', 'password_encrypted');
  const hasPasswordIv = await knex.schema.hasColumn('events', 'password_iv');
  const hasPasswordKeyVersion = await knex.schema.hasColumn('events', 'password_key_version');

  if (!hasPasswordEncrypted || !hasPasswordIv || !hasPasswordKeyVersion) {
    await knex.schema.alterTable('events', (table) => {
      if (!hasPasswordEncrypted) {
        table.text('password_encrypted').nullable();
      }
      if (!hasPasswordIv) {
        table.text('password_iv').nullable();
      }
      if (!hasPasswordKeyVersion) {
        table.integer('password_key_version').nullable().defaultTo(1);
      }
    });
  }
};

exports.down = async (knex) => {
  const hasPasswordEncrypted = await knex.schema.hasColumn('events', 'password_encrypted');
  const hasPasswordIv = await knex.schema.hasColumn('events', 'password_iv');
  const hasPasswordKeyVersion = await knex.schema.hasColumn('events', 'password_key_version');

  if (hasPasswordEncrypted || hasPasswordIv || hasPasswordKeyVersion) {
    await knex.schema.alterTable('events', (table) => {
      if (hasPasswordEncrypted) {
        table.dropColumn('password_encrypted');
      }
      if (hasPasswordIv) {
        table.dropColumn('password_iv');
      }
      if (hasPasswordKeyVersion) {
        table.dropColumn('password_key_version');
      }
    });
  }
};
