const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-events-encryption-')),
  'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'events-encryption-secret';

const express = require('express');
const request = require('supertest');
const {
  bootCrmDb,
  seedMinimal,
  assignAdminRole,
  mintAdminToken,
} = require('../integration/helpers/crmDb');
const { decrypt } = require('../../src/utils/passwordEncryption');

describe('legacy events password encryption', () => {
  let db;
  let cleanup;
  let app;
  let token;
  const previousKey = process.env.GALLERY_ENCRYPTION_KEY_V1;

  beforeAll(async () => {
    process.env.GALLERY_ENCRYPTION_KEY_V1 = crypto.randomBytes(32).toString('hex');
    ({ db, cleanup } = await bootCrmDb());
    const { adminId } = await seedMinimal(db);
    await assignAdminRole(db, adminId, 'super_admin');
    token = mintAdminToken(adminId);
    app = express();
    app.use(express.json());
    app.use('/api/events', require('../../src/routes/events'));
  }, 120000);

  afterAll(async () => {
    await cleanup();
    if (previousKey === undefined) delete process.env.GALLERY_ENCRYPTION_KEY_V1;
    else process.env.GALLERY_ENCRYPTION_KEY_V1 = previousKey;
  });

  it('encrypts create and update while sanitizing list responses', async () => {
    const create = await request(app)
      .post('/api/events')
      .set('Authorization', `Bearer ${token}`)
      .send({
        event_type: 'wedding',
        event_name: 'Legacy encrypted event',
        event_date: '2026-11-01',
        customer_name: 'Client Person',
        customer_email: 'client@example.com',
        admin_email: 'admin@example.com',
        require_password: true,
        password: 'LegacyPass123!',
      });

    expect(create.status).toBe(200);
    let row = await db('events').where({ id: create.body.id }).first();
    expect(decrypt(row.password_encrypted, row.password_iv, row.password_key_version))
      .toBe('LegacyPass123!');

    const list = await request(app)
      .get('/api/events')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const returned = list.body.find((event) => event.id === create.body.id);
    expect(returned.has_encrypted_password).toBe(true);
    expect(returned).not.toHaveProperty('password_hash');
    expect(returned).not.toHaveProperty('password_encrypted');
    expect(returned).not.toHaveProperty('password_iv');
    expect(returned).not.toHaveProperty('password_key_version');

    await request(app)
      .put(`/api/events/${create.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ password: 'UpdatedPass123!' })
      .expect(200);
    row = await db('events').where({ id: create.body.id }).first();
    expect(decrypt(row.password_encrypted, row.password_iv, row.password_key_version))
      .toBe('UpdatedPass123!');

    await request(app)
      .put(`/api/events/${create.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ require_password: false })
      .expect(200);
    row = await db('events').where({ id: create.body.id }).first();
    expect(row.password_encrypted).toBeNull();
  });
});