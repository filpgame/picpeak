/**
 * The v1 photo upload and the cached "Download All" zip.
 *
 * POST /api/v1/events/:id/photos only invalidated the cached zip when it
 * replaced a photo. A new photo was stored and never reached the zip, so
 * guests kept downloading a gallery without anything added through the API
 * (the Lightroom plugin). The route now invalidates after the insert, and
 * holds the rebuild while each photo arrives, as the admin upload route does.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-v1zip-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'v1zip-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-v1zip-storage-'));

const request = require('supertest');
const express = require('express');
const bcrypt = require('bcrypt');
const sharp = require('sharp');

const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');
const { generateApiToken } = require('../../src/middleware/apiTokenAuth');

const SLUG = 'v1-zip-event';
const jpegBytes = () => sharp({ create: { width: 32, height: 32, channels: 3, background: '#888' } }).jpeg().toBuffer();

describe('v1 photo upload and the Download All zip', () => {
  let db; let cleanup; let app; let token; let eventId;
  let downloadZipService;
  // The hold count each invalidate() saw.
  let holdsDuringInvalidate;

  const upload = (attach) => {
    const req = request(app)
      .post(`/api/v1/events/${eventId}/photos`)
      .set('Authorization', `Bearer ${token}`);
    return attach ? attach(req) : req;
  };

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);

    const role = await db('roles').where({ name: 'super_admin' }).first();
    const r = await db('admin_users').insert({
      username: 'v1-zip-admin',
      email: 'v1-zip-admin@example.com',
      password_hash: await bcrypt.hash('Passw0rd!', 4),
      role_id: role.id,
      is_active: 1,
      created_at: new Date(),
      updated_at: new Date(),
    }).returning('id');
    const adminId = r[0]?.id ?? r[0];

    const { plaintext, hashed } = generateApiToken();
    await db('api_tokens').insert({
      name: 'v1-zip-token',
      hashed_token: hashed,
      scopes: 'write',
      created_by: adminId,
      created_at: new Date().toISOString(),
    });
    token = plaintext;

    const ev = await db('events').insert({
      slug: SLUG,
      event_type: 'wedding',
      event_name: 'V1 Zip',
      event_date: '2026-08-01',
      host_email: 'h@example.com',
      admin_email: 'a@example.com',
      password_hash: 'x',
      share_token: 'v1zipshare',
      share_link: `/gallery/${SLUG}/v1zipshare`,
      created_by: adminId,
      expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0,
      created_at: new Date().toISOString(),
    }).returning('id');
    eventId = ev[0]?.id ?? ev[0];

    downloadZipService = require('../../src/services/downloadZipService');
    app = express();
    app.use(express.json());
    app.use('/api/v1', require('../../src/routes/v1/events'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  beforeEach(() => {
    holdsDuringInvalidate = [];
    jest.spyOn(downloadZipService, 'holdRebuild');
    // Record the hold at the time of the invalidate, but don't arm a real 30s
    // rebuild timer.
    jest.spyOn(downloadZipService, 'invalidate').mockImplementation((id) => {
      holdsDuringInvalidate.push(downloadZipService.uploadHolds.get(id) || 0);
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    downloadZipService.uploadHolds.clear();
  });

  it('invalidates the cached zip after storing a new photo, while still holding the rebuild', async () => {
    const photo = await jpegBytes();
    const res = await upload((req) => req.attach('photo', photo, { filename: 'edit.jpg', contentType: 'image/jpeg' }));

    expect(res.status).toBe(201);
    const stored = await db('photos').where({ id: res.body.id }).first();
    expect(stored.event_id).toBe(eventId);
    expect(downloadZipService.holdRebuild).toHaveBeenCalledTimes(1);
    expect(downloadZipService.holdRebuild).toHaveBeenCalledWith(eventId);
    expect(downloadZipService.invalidate).toHaveBeenCalledTimes(1);
    expect(downloadZipService.invalidate).toHaveBeenCalledWith(eventId);
    expect(holdsDuringInvalidate).toEqual([1]);
    expect(downloadZipService.uploadHolds.has(eventId)).toBe(false);
  });

  it('releases the hold when the request carries no photo', async () => {
    const res = await upload();

    expect(res.status).toBe(400);
    expect(downloadZipService.holdRebuild).toHaveBeenCalledTimes(1);
    expect(downloadZipService.invalidate).not.toHaveBeenCalled();
    expect(downloadZipService.uploadHolds.has(eventId)).toBe(false);
  });

  it('takes no hold for a request without a valid token', async () => {
    const res = await request(app)
      .post(`/api/v1/events/${eventId}/photos`)
      .attach('photo', await jpegBytes(), { filename: 'edit.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(401);
    expect(downloadZipService.holdRebuild).not.toHaveBeenCalled();
  });
});
