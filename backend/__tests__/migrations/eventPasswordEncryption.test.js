const knexFactory = require('knex');
const migration = require('../../migrations/core/162_add_password_encryption');

describe('162_add_password_encryption', () => {
  let knex;

  beforeEach(async () => {
    knex = knexFactory({
      client: 'sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
    });
    await knex.schema.createTable('events', (table) => {
      table.increments('id');
      table.string('event_name');
    });
  });

  afterEach(async () => {
    await knex.destroy();
  });

  it('adds nullable encrypted-password columns', async () => {
    await migration.up(knex);

    const columns = await knex('events').columnInfo();
    expect(columns.password_encrypted).toBeDefined();
    expect(columns.password_iv).toBeDefined();
    expect(columns.password_key_version).toBeDefined();
  });

  it('is safe to run twice', async () => {
    await migration.up(knex);
    await expect(migration.up(knex)).resolves.toBeUndefined();
  });

  it('removes all three columns on rollback', async () => {
    await migration.up(knex);
    await migration.down(knex);

    const columns = await knex('events').columnInfo();
    expect(columns.password_encrypted).toBeUndefined();
    expect(columns.password_iv).toBeUndefined();
    expect(columns.password_key_version).toBeUndefined();
  });
});