/**
 * Regression test: on SQLite the hourly expiration checker never archived
 * expired galleries and never queued expiration warnings.
 *
 * SQLite has no date type. events.expires_at is written as TEXT — 'YYYY-MM-DD'
 * by the event edit form, ISO 8601 by event creation — or, by the extend
 * endpoint (which writes a JS Date), as INTEGER epoch milliseconds. The checker
 * compared the column against a JS Date, which node-sqlite3 binds as a REAL,
 * and SQLite orders every number before every TEXT value: `expires_at <= now`
 * was never true for TEXT rows and `expires_at > now` always was. Binding an
 * ISO string instead would flip the problem onto the INTEGER rows (a gallery
 * extended into the future would be archived), so every format is covered.
 *
 * Runs one real checkExpirations() pass against an in-memory SQLite database;
 * only the side effects beyond the database (archiving files, email, workflow
 * and webhook dispatch) are stubbed.
 */

jest.mock('../../src/database/db', () => {
  const knex = require('knex');
  return {
    db: knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true }),
  };
});
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));
jest.mock('../../src/services/archiveService', () => ({
  archiveEvent: jest.fn(async () => {}),
}));
jest.mock('../../src/services/emailProcessor', () => ({
  queueEmail: jest.fn(async () => {}),
  getSupportEmail: jest.fn(async () => 'support@example.test'),
}));
jest.mock('../../src/services/shareLinkService', () => ({
  buildShareLinkVariants: jest.fn(async ({ slug, shareToken }) => ({
    shortEnabled: false,
    sharePath: `/gallery/${slug}/${shareToken}`,
    shareUrl: `https://photos.example.test/gallery/${slug}/${shareToken}`,
    shareLinkToStore: `/gallery/${slug}/${shareToken}`,
  })),
}));
jest.mock('../../src/services/workflows', () => ({
  // Built-in flows disabled: the checker sends the legacy emails itself.
  isBuiltinFlowActive: jest.fn(async () => false),
  emitWorkflowEvent: jest.fn(async () => []),
}));
jest.mock('../../src/services/webhookService', () => ({
  fire: jest.fn(async () => {}),
  buildEventSubject: jest.fn((subject) => subject),
}));

const { db } = require('../../src/database/db');
const logger = require('../../src/utils/logger');
const { archiveEvent } = require('../../src/services/archiveService');
const { queueEmail } = require('../../src/services/emailProcessor');
const { checkExpirations } = require('../../src/services/expirationChecker');
const { useMainRealmDate } = require('../helpers/mainRealmDate');

// Bind the fixtures' Dates and the checker's own `new Date()` as production
// does (a REAL), not as Jest's sandbox realm would.
const restoreDate = useMainRealmDate();

const DAY_MS = 24 * 60 * 60 * 1000;
const now = Date.now();
const daysFromNow = (days) => new Date(now + days * DAY_MS);
const dateOnly = (date) => date.toISOString().slice(0, 10);

// One row per (expiry, storage format) pair. The JS Date values are stored
// as INTEGER epoch milliseconds, exactly like the extend endpoint's write.
const EVENTS = [
  { slug: 'expired-date-only', expires_at: dateOnly(daysFromNow(-3)) },
  { slug: 'expired-iso', expires_at: daysFromNow(-3).toISOString() },
  { slug: 'expired-epoch-ms', expires_at: daysFromNow(-3) },
  { slug: 'expiring-date-only', expires_at: dateOnly(daysFromNow(3)) },
  { slug: 'expiring-iso', expires_at: daysFromNow(3).toISOString() },
  { slug: 'expiring-epoch-ms', expires_at: daysFromNow(3) },
  { slug: 'later-date-only', expires_at: dateOnly(daysFromNow(30)) },
  { slug: 'later-iso', expires_at: daysFromNow(30).toISOString() },
  { slug: 'later-epoch-ms', expires_at: daysFromNow(30) },
  { slug: 'never-expires', expires_at: null },
];

const originalDbClient = process.env.DATABASE_CLIENT;
let slugById;

beforeAll(async () => {
  process.env.DATABASE_CLIENT = 'sqlite3';

  // The events columns the checker reads, typed as initializeDatabase()
  // creates them (expires_at is a `datetime`, i.e. NUMERIC affinity).
  await db.schema.createTable('events', (table) => {
    table.increments('id').primary();
    table.string('slug').unique().notNullable();
    table.string('event_type').notNullable();
    table.string('event_name').notNullable();
    table.date('event_date');
    table.string('customer_name');
    table.string('customer_email');
    table.string('host_name');
    table.string('host_email');
    table.string('admin_email');
    table.string('share_link');
    table.string('share_token');
    table.datetime('expires_at');
    table.boolean('is_active').defaultTo(true);
    table.boolean('is_archived').defaultTo(false);
  });
  await db.schema.createTable('email_queue', (table) => {
    table.increments('id').primary();
    table.integer('event_id');
    table.string('email_type');
  });

  await db('events').insert(EVENTS.map((event) => ({
    ...event,
    event_type: 'wedding',
    event_name: `Gallery ${event.slug}`,
    customer_email: `${event.slug}@example.test`,
    admin_email: 'admin@example.test',
    share_token: `token-${event.slug}`,
  })));
  const rows = await db('events').select('id', 'slug');
  slugById = Object.fromEntries(rows.map((row) => [row.id, row.slug]));

  await checkExpirations();
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

describe('checkExpirations on SQLite', () => {
  test('fixture stores expires_at as both TEXT and INTEGER, like real installs', async () => {
    const rows = await db('events')
      .whereNotNull('expires_at')
      .select('slug', db.raw('typeof(expires_at) AS storage'));

    expect(Object.fromEntries(rows.map((row) => [row.slug, row.storage]))).toEqual({
      'expired-date-only': 'text',
      'expired-iso': 'text',
      'expired-epoch-ms': 'integer',
      'expiring-date-only': 'text',
      'expiring-iso': 'text',
      'expiring-epoch-ms': 'integer',
      'later-date-only': 'text',
      'later-iso': 'text',
      'later-epoch-ms': 'integer',
    });
  });

  test('completes the pass without logging an error', () => {
    expect(logger.error).not.toHaveBeenCalled();
  });

  test('archives and deactivates exactly the galleries past their expiry', async () => {
    const archived = archiveEvent.mock.calls.map(([event]) => event.slug).sort();
    expect(archived).toEqual(['expired-date-only', 'expired-epoch-ms', 'expired-iso']);

    const inactive = (await db('events').where('is_active', 0).pluck('slug')).sort();
    expect(inactive).toEqual(['expired-date-only', 'expired-epoch-ms', 'expired-iso']);
  });

  test('queues an expiration warning for exactly the galleries expiring within 7 days', () => {
    const warned = queueEmail.mock.calls
      .filter(([, , emailType]) => emailType === 'expiration_warning')
      .map(([eventId]) => slugById[eventId])
      .sort();
    expect(warned).toEqual(['expiring-date-only', 'expiring-epoch-ms', 'expiring-iso']);
  });
});
