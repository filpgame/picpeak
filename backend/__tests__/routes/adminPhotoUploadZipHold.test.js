/**
 * The admin upload route holds the "Download All" rebuild for the life of the
 * request.
 *
 * A large upload arrives as a run of batches, each ending in
 * downloadZipService.invalidate(). Without the hold, a rebuild whose quiet
 * period ran out while the next batch was still being sent would start, only
 * to be thrown away when that batch landed. The hold has to be taken before
 * multer reads the body and released however the request ends.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-upload-ziphold-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'upload-ziphold-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-upload-ziphold-storage-'));

const request = require('supertest');
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const sharp = require('sharp');

const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

const SLUG = 'upload-ziphold-event';
// Big enough to pass the upload route's decode check (10px minimum).
const jpegBytes = () => sharp({ create: { width: 32, height: 32, channels: 3, background: '#888' } }).jpeg().toBuffer();

describe('admin upload holds the Download All rebuild', () => {
  let db; let cleanup; let app; let eventId; let adminToken;
  let downloadZipService;
  let holdsDuringInvalidate;

  const postUpload = (attach) => {
    const req = request(app)
      .post(`/api/admin/photos/${eventId}/upload`)
      .set('Authorization', `Bearer ${adminToken}`);
    return attach ? attach(req) : req;
  };

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);

    const inserted = await db('events').insert({
      slug: SLUG,
      event_type: 'wedding',
      event_name: 'Upload Zip Hold',
      event_date: '2026-09-01',
      host_email: 'host@example.com',
      admin_email: 'admin@example.com',
      password_hash: 'x',
      share_link: `/gallery/${SLUG}/share`,
      share_token: 'upload-ziphold-share',
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      created_at: new Date().toISOString(),
    }).returning('id');
    eventId = inserted[0]?.id ?? inserted[0];

    const superRole = await db('roles').where({ name: 'super_admin' }).first();
    const [rootId] = await db('admin_users').insert({
      username: 'upload-ziphold-admin',
      email: 'upload-ziphold-admin@example.com',
      password_hash: await bcrypt.hash('UploadZipHold123', 4),
      role_id: superRole.id,
      is_active: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).returning('id').then((r) => [r[0]?.id || r[0]]);
    adminToken = jwt.sign(
      { id: rootId, username: 'upload-ziphold-admin', type: 'admin', role: 'super_admin', loginTime: Date.now() },
      process.env.JWT_SECRET,
      { expiresIn: '1h', issuer: 'picpeak-auth' }
    );

    downloadZipService = require('../../src/services/downloadZipService');
    app = express();
    app.use(express.json());
    app.use('/api/admin/photos', require('../../src/routes/adminPhotos'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  beforeEach(() => {
    holdsDuringInvalidate = [];
    jest.spyOn(downloadZipService, 'holdRebuild');
    // Record what the hold looked like when the batch invalidated, but don't
    // arm a real 30s rebuild timer.
    jest.spyOn(downloadZipService, 'invalidate').mockImplementation((id) => {
      holdsDuringInvalidate.push(downloadZipService.uploadHolds.get(id) || 0);
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    downloadZipService.uploadHolds.clear();
  });

  it('holds while the batch is stored and invalidated, and releases when it returns', async () => {
    const photo = await jpegBytes();
    const res = await postUpload((req) => req.attach('photos', photo, { filename: 'shot.jpg', contentType: 'image/jpeg' }));

    expect(res.status).toBe(202);
    expect(downloadZipService.holdRebuild).toHaveBeenCalledTimes(1);
    expect(downloadZipService.holdRebuild).toHaveBeenCalledWith(eventId);
    expect(holdsDuringInvalidate).toEqual([1]);
    expect(downloadZipService.uploadHolds.has(eventId)).toBe(false);
  });

  it('releases the hold when the batch is rejected', async () => {
    const res = await postUpload();

    expect(res.status).toBe(400);
    expect(downloadZipService.holdRebuild).toHaveBeenCalledTimes(1);
    expect(downloadZipService.invalidate).not.toHaveBeenCalled();
    expect(downloadZipService.uploadHolds.has(eventId)).toBe(false);
  });

  it('takes no hold for a request that fails authentication', async () => {
    const res = await request(app)
      .post(`/api/admin/photos/${eventId}/upload`)
      .attach('photos', await jpegBytes(), { filename: 'shot.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(401);
    expect(downloadZipService.holdRebuild).not.toHaveBeenCalled();
  });
});
