/**
 * HTTP smoke tests for the core admin event CRUD endpoints:
 *   POST   /api/admin/events           (create)
 *   GET    /api/admin/events           (list + pagination)
 *   GET    /api/admin/events/:id       (detail + stats)
 *   PUT    /api/admin/events/:id       (update)
 *   DELETE /api/admin/events/:id       (cascade delete)
 *
 * Safety net ahead of the adminEvents.js god-file decomposition —
 * pins the request/response contracts of the main CRUD paths using
 * the same real-SQLite harness as slideshowAdmin.test.js.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-events-smoke-')), 'db.sqlite'
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'admin-events-test-secret';

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const crypto = require('crypto');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken } = require('../integration/helpers/crmDb');
const {
  encrypt,
  decrypt,
} = require('../../src/utils/passwordEncryption');

async function insertEvent(db, adminId, over = {}) {
  const base = {
    slug: `ev-${Math.random().toString(16).slice(2)}`,
    event_type: 'wedding',
    event_name: 'Test Wedding',
    event_date: '2026-05-29',
    host_email: 'host@example.com',
    admin_email: 'admin@example.com',
    password_hash: 'x',
    share_link: `/gallery/share-${Math.random().toString(16).slice(2)}`,
    share_token: `st-${Math.random().toString(16).slice(2)}`,
    expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    is_active: 1, is_archived: 0, is_draft: 0,
    created_by: adminId,
    created_at: new Date().toISOString(),
    ...over,
  };
  const r = await db('events').insert(base).returning('id');
  return r[0]?.id ?? r[0];
}

describe('admin events CRUD endpoints (smoke)', () => {
  let db; let cleanup; let app; let adminId; let token;

  const previousEncryptionKey = process.env.GALLERY_ENCRYPTION_KEY_V1;

  // bootCrmDb's full migration run intermittently exceeds Jest's default
  // 5s beforeAll timeout on slower CI runners; raise it.
  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ adminId } = await seedMinimal(db));
    await assignAdminRole(db, adminId, 'super_admin');
    token = mintAdminToken(adminId);

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/admin/events', require('../../src/routes/adminEvents'));
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
      res.status(err.statusCode || err.status || 500).json({ error: err.message, code: err.code });
    });
  }, 120000);

  afterAll(async () => {
    if (previousEncryptionKey === undefined) delete process.env.GALLERY_ENCRYPTION_KEY_V1;
    else process.env.GALLERY_ENCRYPTION_KEY_V1 = previousEncryptionKey;
    await cleanup();
  });

  beforeEach(async () => {
    process.env.GALLERY_ENCRYPTION_KEY_V1 = crypto.randomBytes(32).toString('hex');
    await db('email_queue').del();
    await db('events').del();
  });

  const auth = (req) => req.set('Authorization', `Bearer ${token}`);

  it('401s without an admin token', async () => {
    const res = await request(app).get('/api/admin/events');
    expect(res.status).toBe(401);
  });

  describe('POST /', () => {
    it('creates an event, mints slug + share link and persists the row', async () => {
      const res = await auth(request(app).post('/api/admin/events')).send({
        event_type: 'wedding',
        event_name: 'Smoke Wedding',
        event_date: '2026-09-01',
        // Field requirements default to ON (getEventFieldRequirements)
        // so customer + admin contact data must be supplied.
        customer_name: 'Client Person',
        customer_email: 'client@example.com',
        admin_email: 'admin@example.com',
        require_password: false,
        is_draft: true,
      });

      expect(res.status).toBe(200);
      expect(res.body.id).toBeDefined();
      expect(res.body.slug).toContain('wedding-smoke-wedding');
      expect(typeof res.body.share_link).toBe('string');
      expect(res.body.is_draft).toBe(true);

      const row = await db('events').where({ id: res.body.id }).first();
      expect(row).toBeDefined();
      expect(row.event_name).toBe('Smoke Wedding');
      expect(row.created_by).toBe(adminId);
      expect(row.language).toBeNull();

      // Folder structure is created under STORAGE_PATH/events/active/<slug>.
      const eventDir = path.join(process.env.STORAGE_PATH, 'events/active', res.body.slug);
      expect(fs.existsSync(path.join(eventDir, 'collages'))).toBe(true);
      expect(fs.existsSync(path.join(eventDir, 'individual'))).toBe(true);

      // Draft creates must NOT queue the gallery_created email.
      const queued = await db('email_queue').where({ event_id: res.body.id });
      expect(queued).toHaveLength(0);
    });

    it('400s on an invalid event type', async () => {
      const res = await auth(request(app).post('/api/admin/events')).send({
        event_type: 'not-a-real-type',
        event_name: 'Broken',
        require_password: false,
      });
      expect(res.status).toBe(400);
      expect(Array.isArray(res.body.errors)).toBe(true);
    });

    it('duplicates an event with system-default language', async () => {
      const sourceId = await insertEvent(db, adminId, { language: 'de' });
      const res = await auth(request(app)
        .post(`/api/admin/events/${sourceId}/duplicate`))
        .send({ event_name: 'Duplicated event', event_date: '2026-10-01' });

      expect(res.status).toBe(200);
      const duplicate = await db('events').where({ id: res.body.id }).first();
      expect(duplicate.language).toBeNull();
    });
  });

  describe('GET /', () => {
    it('lists events with pagination metadata and photo counts', async () => {
      await insertEvent(db, adminId, { event_name: 'Alpha' });
      await insertEvent(db, adminId, { event_name: 'Beta' });

      const res = await auth(request(app).get('/api/admin/events'));
      expect(res.status).toBe(200);
      expect(res.body.events).toHaveLength(2);
      expect(res.body.pagination).toMatchObject({ page: 1, total: 2, totalPages: 1 });
      for (const ev of res.body.events) {
        expect(ev.photo_count).toBe(0);
      }
    });
  });

  describe('GET /:id', () => {
    it('returns the event with photo/view stats', async () => {
      const id = await insertEvent(db, adminId, { event_name: 'Detail Event' });
      const res = await auth(request(app).get(`/api/admin/events/${id}`));
      expect(res.status).toBe(200);
      expect(res.body.event_name).toBe('Detail Event');
      expect(res.body.photo_count).toBe(0);
      expect(res.body.total_views).toBe(0);
      expect(res.body.total_downloads).toBe(0);
      expect(Array.isArray(res.body.recent_photos)).toBe(true);
    });

    it('404s for an unknown event id', async () => {
      const res = await auth(request(app).get('/api/admin/events/999999'));
      expect(res.status).toBe(404);
    });
  });

  describe('PUT /:id', () => {
    it('updates mutable fields and persists them', async () => {
      const id = await insertEvent(db, adminId, { event_name: 'Before' });
      const res = await auth(request(app).put(`/api/admin/events/${id}`)).send({
        event_name: 'After',
        welcome_message: 'Hello guests',
      });
      expect(res.status).toBe(200);
      const row = await db('events').where({ id }).first();
      expect(row.event_name).toBe('After');
      expect(row.welcome_message).toBe('Hello guests');
    });

    it('404s when updating a missing event', async () => {
      const res = await auth(request(app).put('/api/admin/events/999999')).send({
        event_name: 'Ghost',
      });
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /:id', () => {
    it('cascade-deletes the event row', async () => {
      const id = await insertEvent(db, adminId);
      const res = await auth(request(app).delete(`/api/admin/events/${id}`));
      expect(res.status).toBe(200);
      expect(res.body.message).toMatch(/deleted/i);
      const row = await db('events').where({ id }).first();
      expect(row).toBeUndefined();
    });

    it('404s when deleting a missing event', async () => {
      const res = await auth(request(app).delete('/api/admin/events/999999'));
      expect(res.status).toBe(404);
    });
  });

  it('encrypts a protected password and sanitizes admin detail responses', async () => {
    const res = await auth(request(app).post('/api/admin/events')).send({
      event_type: 'wedding',
      event_name: 'Encrypted Wedding',
      event_date: '2026-09-01',
      customer_name: 'Client Person',
      customer_email: 'client@example.com',
      admin_email: 'admin@example.com',
      require_password: true,
      password: 'StrongPass123!',
      is_draft: true,
    });

    expect(res.status).toBe(200);
    const row = await db('events').where({ id: res.body.id }).first();
    expect(decrypt(
      row.password_encrypted,
      row.password_iv,
      row.password_key_version,
    )).toBe('StrongPass123!');

    const detail = await auth(request(app).get(`/api/admin/events/${res.body.id}`));
    expect(detail.body.has_encrypted_password).toBe(true);
    expect(detail.body).not.toHaveProperty('password_encrypted');
    expect(detail.body).not.toHaveProperty('password_iv');
    expect(detail.body).not.toHaveProperty('password_key_version');
  });

  it('re-encrypts updates and clears ciphertext when password protection is disabled', async () => {
    const stored = encrypt('OldPass123!');
    const id = await insertEvent(db, adminId, {
      require_password: 1,
      password_encrypted: stored.encrypted,
      password_iv: stored.iv,
      password_key_version: stored.keyVersion,
    });

    await auth(request(app).put(`/api/admin/events/${id}`)).send({
      password: 'NewPass123!',
    }).expect(200);
    let row = await db('events').where({ id }).first();
    expect(decrypt(row.password_encrypted, row.password_iv, row.password_key_version))
      .toBe('NewPass123!');

    await auth(request(app).put(`/api/admin/events/${id}`)).send({
      require_password: false,
    }).expect(200);
    row = await db('events').where({ id }).first();
    expect(row.password_encrypted).toBeNull();
    expect(row.password_iv).toBeNull();
    expect(row.password_key_version).toBeNull();
  });

  it('encrypts reset passwords and auto-decrypts them for resend', async () => {
    const id = await insertEvent(db, adminId, {
      require_password: 1,
      customer_email: 'client@example.com',
    });

    await auth(request(app).post(`/api/admin/events/${id}/reset-password`)).send({
      sendEmail: false,
      password: 'ResetPass123!',
    }).expect(200);

    const row = await db('events').where({ id }).first();
    expect(decrypt(row.password_encrypted, row.password_iv, row.password_key_version))
      .toBe('ResetPass123!');

    await auth(request(app).post(`/api/admin/events/${id}/resend-email`)).send({}).expect(200);
    const queued = await db('email_queue').where({ event_id: id }).orderBy('id', 'desc').first();
    expect(JSON.parse(queued.email_data).gallery_password).toBe('ResetPass123!');
  });

  it('decrypts a stored draft password when publishing without a request password', async () => {
    const stored = encrypt('DraftPass123!');
    const id = await insertEvent(db, adminId, {
      is_draft: 1,
      require_password: 1,
      customer_email: 'client@example.com',
      password_encrypted: stored.encrypted,
      password_iv: stored.iv,
      password_key_version: stored.keyVersion,
    });

    await auth(request(app).post(`/api/admin/events/${id}/publish`)).send({}).expect(200);
    const queued = await db('email_queue').where({ event_id: id }).orderBy('id', 'desc').first();
    expect(JSON.parse(queued.email_data).gallery_password).toBe('DraftPass123!');
  });

  it('encrypts a password supplied while publishing a draft', async () => {
    const id = await insertEvent(db, adminId, {
      is_draft: 1,
      require_password: 1,
      customer_email: 'client@example.com',
    });

    await auth(request(app).post(`/api/admin/events/${id}/publish`)).send({
      password: 'PublishedPass123!',
    }).expect(200);

    const row = await db('events').where({ id }).first();
    expect(decrypt(row.password_encrypted, row.password_iv, row.password_key_version))
      .toBe('PublishedPass123!');
  });

  it('clears stale ciphertext when a password changes without an encryption key', async () => {
    const stored = encrypt('OldPass123!');
    const id = await insertEvent(db, adminId, {
      require_password: 1,
      password_encrypted: stored.encrypted,
      password_iv: stored.iv,
      password_key_version: stored.keyVersion,
    });
    const configuredKey = process.env.GALLERY_ENCRYPTION_KEY_V1;
    delete process.env.GALLERY_ENCRYPTION_KEY_V1;

    try {
      await auth(request(app).put(`/api/admin/events/${id}`)).send({
        password: 'ChangedWithoutKey123!',
      }).expect(200);
    } finally {
      process.env.GALLERY_ENCRYPTION_KEY_V1 = configuredKey;
    }

    const row = await db('events').where({ id }).first();
    expect(row.password_encrypted).toBeNull();
    expect(row.password_iv).toBeNull();
    expect(row.password_key_version).toBeNull();
  });
});
