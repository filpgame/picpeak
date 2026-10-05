// PostgreSQL-only behaviours that SQLite hides: date columns, LIKE case
// sensitivity, LIKE on json, string COUNT()s and foreign keys without
// ON DELETE CASCADE. Runs against a real server, like the other
// PICPEAK_PG_TEST_URL suites; skipped otherwise.
const knex = require('knex');
const { randomUUID } = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const request = require('supertest');
const pgUrl = process.env.PICPEAK_PG_TEST_URL;

(pgUrl ? describe : describe.skip)('PostgreSQL compatibility', () => {
  let owner, db, schema, tmpDir, cleanup, previousClient, bearer;
  let eventsApp, archivesApp, dashboardApp;

  beforeAll(async () => {
    // Not "pg_…": PostgreSQL reserves that prefix for system schemas.
    schema = `compat_${randomUUID().replace(/-/g, '')}`;
    owner = knex({ client: 'pg', connection: pgUrl });
    await owner.schema.createSchema(schema);
    previousClient = process.env.DATABASE_CLIENT;
    process.env.DATABASE_CLIENT = 'pg';
    process.env.JWT_SECRET = 'pg-compat-test-secret-at-least-32-characters-long';
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-pg-compat-'));
    process.env.STORAGE_PATH = path.join(tmpDir, 'storage');
    jest.doMock('../../knexfile', () => ({ client: 'pg', connection: pgUrl, searchPath: [schema] }));
    ({ db } = require('../../src/database/db'));
    ({ cleanup } = await require('./helpers/crmDb').bootCrmDb());

    const { seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp } = require('./helpers/crmDb');
    const { adminId } = await seedMinimal(db);
    await assignAdminRole(db, adminId);
    bearer = `Bearer ${mintAdminToken(adminId)}`;
    eventsApp = buildRouteApp('/api/admin/events', require('../../src/routes/adminEvents'));
    eventsApp.use('/api/admin/events', require('../../src/routes/adminPhotos'));
    archivesApp = buildRouteApp('/api/admin/archives', require('../../src/routes/adminArchives'));
    dashboardApp = buildRouteApp('/api/admin/dashboard', require('../../src/routes/adminDashboard'));
  }, 120000);

  afterAll(async () => {
    await require('../../src/services/serviceShutdown').stopServices();
    if (cleanup) await cleanup(); else if (db) await db.destroy();
    if (owner) { await owner.schema.dropSchema(schema, true); await owner.destroy(); }
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
    if (previousClient === undefined) delete process.env.DATABASE_CLIENT; else process.env.DATABASE_CLIENT = previousClient;
    jest.dontMock('../../knexfile');
  });

  async function createEvent(eventName, eventDate) {
    const res = await request(eventsApp).post('/api/admin/events').set('Authorization', bearer).send({
      event_type: 'birthday', event_name: eventName, event_date: eventDate,
      customer_name: 'Customer', customer_email: 'customer@example.test', admin_email: 'admin@example.test',
      password: 'Strong-Test-Photo-Pass-924!', expiration_days: 30,
    });
    expect(res.status).toBe(200);
    return db('events').where({ event_name: eventName }).first();
  }

  async function addAccessLog(eventId, ip) {
    await db('access_logs').insert({
      event_id: eventId, ip_address: ip, user_agent: 'Mozilla/5.0 (iPhone) Mobile', action: 'view',
    });
  }

  it('returns date columns as YYYY-MM-DD text', async () => {
    const event = await createEvent('Date Column Check', '2026-10-01');
    expect(event.event_date).toBe('2026-10-01');
  });

  it('searches events without regard to case', async () => {
    await createEvent('Niver Olivia 1 Ano', '2026-07-25');
    const res = await request(eventsApp).get('/api/admin/events')
      .query({ search: 'OLIVIA' }).set('Authorization', bearer);
    expect(res.status).toBe(200);
    expect(res.body.events.map((e) => e.event_name)).toContain('Niver Olivia 1 Ano');
  });

  it('searches photos without regard to case', async () => {
    const event = await createEvent('Photo Search Check', '2026-08-01');
    await db('photos').insert({
      event_id: event.id, filename: 'photo-search-check_0001.jpg', original_filename: 'DSC_0001.JPG',
      path: 'events/active/photo-search-check/photo-search-check_0001.jpg', type: 'individual',
    });
    const res = await request(eventsApp).get(`/api/admin/events/${event.id}/photos`)
      .query({ search: 'dsc_0001' }).set('Authorization', bearer);
    expect(res.status).toBe(200);
    expect(res.body.photos).toHaveLength(1);
  });

  it('permanently deletes an archive that still has log and mail rows', async () => {
    const event = await createEvent('Archive Delete Check', '2026-05-01');
    await db('events').where({ id: event.id }).update({ is_archived: true, archived_at: new Date() });
    await addAccessLog(event.id, '198.51.100.7');
    await db('activity_logs').insert({ activity_type: 'event_archived', actor_type: 'system', event_id: event.id });
    await db('email_queue').insert({
      event_id: event.id, recipient_email: 'admin@example.test', email_type: 'archive_complete',
      email_data: JSON.stringify({}), status: 'sent',
    });

    const res = await request(archivesApp).delete(`/api/admin/archives/${event.id}`).set('Authorization', bearer);
    expect(res.status).toBe(200);
    expect(await db('events').where({ id: event.id }).first()).toBeUndefined();
    for (const table of ['access_logs', 'activity_logs', 'email_queue']) {
      expect(Number((await db(table).where({ event_id: event.id }).count('* as n').first()).n)).toBe(0);
    }
  });

  it('reads the contract audit trail from json metadata', async () => {
    await db('activity_logs').insert({
      activity_type: 'contract_sent', actor_type: 'admin', metadata: JSON.stringify({ contractId: 4242 }),
    });
    const { getAuditTrail } = require('../../src/services/contract/signatures');
    const trail = await getAuditTrail(4242);
    expect(trail).toHaveLength(1);
    expect(trail[0].metadata.contractId).toBe(4242);
  });

  it('returns numeric dashboard counts', async () => {
    const event = await createEvent('Dashboard Check', '2026-09-01');
    await addAccessLog(event.id, '198.51.100.8');
    await addAccessLog(event.id, '198.51.100.9');

    const analytics = await request(dashboardApp).get('/api/admin/dashboard/analytics')
      .query({ days: 7 }).set('Authorization', bearer);
    expect(analytics.status).toBe(200);
    expect(typeof analytics.body.totals.views).toBe('number');
    expect(analytics.body.totals.views).toBeGreaterThanOrEqual(2);
    const top = analytics.body.topGalleries.find((g) => g.id === event.id);
    expect(top).toMatchObject({ views: 2, uniqueVisitors: 2, downloads: 0 });

    const stats = await request(dashboardApp).get('/api/admin/dashboard/stats').set('Authorization', bearer);
    expect(stats.status).toBe(200);
    for (const key of ['activeEvents', 'totalPhotos', 'totalViews', 'totalEvents']) {
      expect(typeof stats.body[key]).toBe('number');
    }
  });
});
