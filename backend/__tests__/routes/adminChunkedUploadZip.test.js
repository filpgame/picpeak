/**
 * The admin chunked upload and the cached "Download All" zip.
 *
 * Files above the batch size go through chunked upload, and its /complete
 * step stored the photo without calling downloadZipService.invalidate(), so a
 * large video uploaded on its own never reached the cached zip. The chunk and
 * complete requests also hold the rebuild while they run, as the batch upload
 * route does: a rebuild that came due mid-transfer would only be thrown away
 * by /complete.
 */

const mockUploadChunk = jest.fn();
const mockCompleteUpload = jest.fn();
const mockAbortUpload = jest.fn(async () => undefined);
jest.mock('../../src/services/chunkedUploadService', () => ({
  ...jest.requireActual('../../src/services/chunkedUploadService'),
  uploadChunk: (...args) => mockUploadChunk(...args),
  completeUpload: (...args) => mockCompleteUpload(...args),
  abortUpload: (...args) => mockAbortUpload(...args),
}));

const mockProcessUploadedPhotos = jest.fn();
jest.mock('../../src/services/photoProcessor', () => ({
  ...jest.requireActual('../../src/services/photoProcessor'),
  processUploadedPhotos: (...args) => mockProcessUploadedPhotos(...args),
}));

const request = require('supertest');
const express = require('express');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken } = require('../integration/helpers/crmDb');

describe('admin chunked upload and the Download All zip', () => {
  let db; let cleanup; let app; let token; let eventId;
  let downloadZipService;
  // The hold count each invalidate() saw.
  let holdsDuringInvalidate;
  let holdsDuringChunk;

  const unwrap = (rows) => (typeof rows[0] === 'object' && rows[0] !== null ? rows[0].id : rows[0]);

  const complete = () => request(app)
    .post(`/api/admin/photos/${eventId}/chunked-upload/upload-abc/complete`)
    .set('Authorization', `Bearer ${token}`)
    .send({});

  const sendChunk = () => request(app)
    .post(`/api/admin/photos/${eventId}/chunked-upload/upload-abc/chunk/0`)
    .set('Authorization', `Bearer ${token}`)
    .set('Content-Type', 'application/octet-stream')
    .send(Buffer.alloc(1024, 7));

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const { adminId } = await seedMinimal(db);
    await assignAdminRole(db, adminId, 'super_admin');
    token = mintAdminToken(adminId);

    const slug = 'chunked-zip-event';
    eventId = unwrap(await db('events').insert({
      slug,
      event_type: 'wedding',
      event_name: 'Chunked Zip',
      event_date: '2026-08-01',
      host_email: 'host@example.com',
      admin_email: 'admin@example.com',
      password_hash: 'x',
      share_link: `/gallery/${slug}/share`,
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      created_at: new Date().toISOString(),
    }).returning('id'));

    downloadZipService = require('../../src/services/downloadZipService');
    app = express();
    app.use(express.json());
    app.use('/api/admin/photos', require('../../src/routes/adminPhotos'));
  }, 180000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  beforeEach(() => {
    jest.clearAllMocks();
    holdsDuringInvalidate = [];
    holdsDuringChunk = [];
    mockCompleteUpload.mockResolvedValue({
      filename: 'big.mp4', mimeType: 'video/mp4', size: 3, path: '/tmp/not-used', tempDir: '/tmp/not-used-dir',
    });
    mockProcessUploadedPhotos.mockResolvedValue([{ id: 1 }]);
    mockUploadChunk.mockImplementation(async (_uploadId, _index, req) => {
      holdsDuringChunk.push(downloadZipService.uploadHolds.get(eventId) || 0);
      req.resume();
      await new Promise((resolve) => req.once('end', resolve));
      return { progress: 50, complete: false };
    });
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

  it('invalidates the cached zip once the merged file is stored, while still holding the rebuild', async () => {
    const res = await complete();

    expect(res.status).toBe(200);
    expect(res.body.uploaded).toBe(1);
    expect(downloadZipService.invalidate).toHaveBeenCalledTimes(1);
    expect(downloadZipService.invalidate).toHaveBeenCalledWith(eventId);
    expect(holdsDuringInvalidate).toEqual([1]);
    expect(downloadZipService.uploadHolds.has(eventId)).toBe(false);
  });

  it('leaves the cached zip alone when no photo was stored', async () => {
    mockProcessUploadedPhotos.mockResolvedValue([]);

    const res = await complete();

    expect(res.status).toBe(200);
    expect(res.body.uploaded).toBe(0);
    expect(downloadZipService.invalidate).not.toHaveBeenCalled();
    expect(downloadZipService.uploadHolds.has(eventId)).toBe(false);
  });

  it('releases the hold when the merge fails', async () => {
    mockCompleteUpload.mockRejectedValue(Object.assign(new Error('Missing chunks'), { statusCode: 400 }));

    const res = await complete();

    expect(res.status).toBe(400);
    expect(downloadZipService.holdRebuild).toHaveBeenCalledWith(eventId);
    expect(downloadZipService.invalidate).not.toHaveBeenCalled();
    expect(downloadZipService.uploadHolds.has(eventId)).toBe(false);
  });

  it('holds the rebuild while a chunk is received, and releases it after', async () => {
    const res = await sendChunk();

    expect(res.status).toBe(200);
    expect(downloadZipService.holdRebuild).toHaveBeenCalledTimes(1);
    expect(downloadZipService.holdRebuild).toHaveBeenCalledWith(eventId);
    expect(holdsDuringChunk).toEqual([1]);
    expect(downloadZipService.uploadHolds.has(eventId)).toBe(false);
  });

  it('takes no hold for a chunk that fails authentication', async () => {
    const res = await request(app)
      .post(`/api/admin/photos/${eventId}/chunked-upload/upload-abc/chunk/0`)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.alloc(16));

    expect(res.status).toBe(401);
    expect(downloadZipService.holdRebuild).not.toHaveBeenCalled();
  });
});
