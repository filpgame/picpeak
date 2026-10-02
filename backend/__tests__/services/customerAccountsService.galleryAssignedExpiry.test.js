/**
 * Regression test: on SQLite the "new galleries assigned" customer email
 * listed galleries that had already expired.
 *
 * notifyCustomerOfNewAssignments() drops expired galleries with
 * `expires_at > now`, binding a JS Date (a REAL). events.expires_at is TEXT on
 * SQLite ('YYYY-MM-DD' / ISO 8601) except where the extend endpoint wrote a
 * Date (INTEGER epoch milliseconds), and SQLite sorts every number before
 * every TEXT value — so every TEXT-dated gallery passed the filter and the
 * customer was emailed a link that answers 410. Runs the real query against
 * an in-memory SQLite database.
 */

jest.mock('../../src/database/db', () => {
  const knex = require('knex');
  return {
    db: knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true }),
    logActivity: jest.fn(async () => {}),
  };
});
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));
jest.mock('../../src/services/emailProcessor', () => ({
  queueEmail: jest.fn(async () => {}),
}));
jest.mock('../../src/utils/frontendUrl', () => ({
  getFrontendBaseUrl: jest.fn(async () => 'https://photos.example.test'),
}));

const { db } = require('../../src/database/db');
const { queueEmail } = require('../../src/services/emailProcessor');
const { notifyCustomerOfNewAssignments } = require('../../src/services/customerAccountsService');
const { useMainRealmDate } = require('../helpers/mainRealmDate');

// Bind the fixtures' Dates and the service's own `new Date()` as production
// does (a REAL), not as Jest's sandbox realm would.
const restoreDate = useMainRealmDate();

const DAY_MS = 24 * 60 * 60 * 1000;
const now = Date.now();
const daysFromNow = (days) => new Date(now + days * DAY_MS);
const dateOnly = (date) => date.toISOString().slice(0, 10);

// One row per (expiry, storage format) pair; the JS Date values are stored as
// INTEGER epoch milliseconds, like the extend endpoint's write.
const EVENTS = [
  { slug: 'expired-date-only', expires_at: dateOnly(daysFromNow(-3)) },
  { slug: 'expired-iso', expires_at: daysFromNow(-3).toISOString() },
  { slug: 'expired-epoch-ms', expires_at: daysFromNow(-3) },
  { slug: 'live-date-only', expires_at: dateOnly(daysFromNow(3)) },
  { slug: 'live-iso', expires_at: daysFromNow(3).toISOString() },
  { slug: 'live-epoch-ms', expires_at: daysFromNow(3) },
  { slug: 'never-expires', expires_at: null },
];

const originalDbClient = process.env.DATABASE_CLIENT;
let customerId;

beforeAll(async () => {
  process.env.DATABASE_CLIENT = 'sqlite3';

  await db.schema.createTable('customer_accounts', (table) => {
    table.increments('id').primary();
    table.string('email');
    table.string('display_name');
    table.string('first_name');
    table.string('preferred_language');
    table.boolean('is_active').defaultTo(true);
  });
  // The events columns the query reads, typed as initializeDatabase()
  // creates them (expires_at is a `datetime`, i.e. NUMERIC affinity).
  await db.schema.createTable('events', (table) => {
    table.increments('id').primary();
    table.string('slug').unique().notNullable();
    table.string('event_name').notNullable();
    table.date('event_date');
    table.datetime('expires_at');
    table.boolean('is_archived').defaultTo(false);
  });

  [customerId] = await db('customer_accounts').insert({
    email: 'client@example.test',
    display_name: 'Client',
    preferred_language: 'en',
  });
  await db('events').insert(EVENTS.map((event) => ({ ...event, event_name: `Gallery ${event.slug}` })));
});

afterAll(async () => {
  restoreDate();
  if (originalDbClient === undefined) {
    delete process.env.DATABASE_CLIENT;
  } else {
    process.env.DATABASE_CLIENT = originalDbClient;
  }
  await db.destroy();
});

describe('notifyCustomerOfNewAssignments on SQLite', () => {
  test('lists only the galleries that have not expired, whatever the expires_at storage format', async () => {
    const eventIds = await db('events').pluck('id');

    await notifyCustomerOfNewAssignments(customerId, eventIds);

    expect(queueEmail).toHaveBeenCalledTimes(1);
    const [, recipient, emailType, vars] = queueEmail.mock.calls[0];
    expect(recipient).toBe('client@example.test');
    expect(emailType).toBe('customer_gallery_assigned');
    const listed = vars.gallery_list_text.split('\n').map((line) => line.replace(/^- /, '')).sort();
    expect(listed).toEqual([
      'Gallery live-date-only',
      'Gallery live-epoch-ms',
      'Gallery live-iso',
      'Gallery never-expires',
    ]);
    expect(vars.gallery_count).toBe('4');
  });
});
