const knexFactory = require('knex');
const migration = require('../../migrations/core/161_fix_event_language_default');

describe('161_fix_event_language_default', () => {
  let knex;

  beforeEach(() => {
    knex = knexFactory({
      client: 'sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
    });
  });

  afterEach(async () => {
    await knex.destroy();
  });

  it('adds a nullable language column with a null default on fresh schemas', async () => {
    await knex.schema.createTable('events', (table) => {
      table.increments('id');
      table.string('event_name');
    });

    await migration.up(knex);

    const columns = await knex('events').columnInfo();
    expect(columns.language).toBeDefined();
    await knex('events').insert({ event_name: 'Fresh event' });
    const row = await knex('events').first();
    expect(row.language).toBeNull();
  });

  it('normalizes defaulted English rows and preserves explicit languages', async () => {
    await knex.schema.createTable('events', (table) => {
      table.increments('id');
      table.string('event_name');
      table.string('language', 5).defaultTo('en');
    });
    await knex('events').insert([
      { event_name: 'Default English' },
      { event_name: 'Explicit German', language: 'de' },
      { event_name: 'System default', language: null },
    ]);

    await migration.up(knex);

    const rows = await knex('events').orderBy('id');
    expect(rows.map((row) => row.language)).toEqual([null, 'de', null]);
    await knex('events').insert({ event_name: 'After migration' });
    const inserted = await knex('events').where({ event_name: 'After migration' }).first();
    expect(inserted.language).toBeNull();
  });

  it('is safe to run twice', async () => {
    await knex.schema.createTable('events', (table) => {
      table.increments('id');
      table.string('language', 5).defaultTo('en');
    });

    await migration.up(knex);
    await expect(migration.up(knex)).resolves.toBeUndefined();
  });
});