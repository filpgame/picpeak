/**
 * invalidateAll() must also stop builds that are already running.
 *
 * It is called after a global setting the archive depends on changes (the
 * original-filenames toggle). It only selected events with a
 * download_zip_path, but an event whose zip is being built has none yet:
 * invalidate() clears it, and only a finished build sets it. So a build that
 * read the settings before the change carried on and published its archive
 * under the old settings, and nothing rebuilt it.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-zipinvall-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'zipinvall-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-zipinvall-storage-'));

const LocalFsStorage = require('../../src/services/storage/LocalFsStorage');

const mockStorageRoot = process.env.STORAGE_PATH;
const mockLocal = new LocalFsStorage({ root: mockStorageRoot });
// While armed, every photo read parks until the test lets it through, which
// holds the build after it has read the settings and before it publishes.
const mockGate = { armed: false, reached: null, open: null };
const mockStorage = {
  kind: () => mockLocal.kind(),
  resolveLocalPath: (key) => mockLocal.resolveLocalPath(key),
  stat: (key) => mockLocal.stat(key),
  delete: (key) => mockLocal.delete(key),
  putFromFile: (...args) => mockLocal.putFromFile(...args),
  get: async (key) => {
    if (mockGate.armed) {
      mockGate.reached();
      await mockGate.open;
    }
    return mockLocal.get(key);
  },
};

jest.mock('../../src/services/storage', () => ({
  getStorage: () => mockStorage,
  initStorage: async () => mockStorage,
}));

const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');
const service = require('../../src/services/downloadZipService');

describe('downloadZipService.invalidateAll and builds in flight', () => {
  let db; let cleanup;
  let slugCounter = 0;

  async function createEvent() {
    slugCounter += 1;
    const slug = `zipinvall-${slugCounter}`;
    const ev = await db('events').insert({
      slug,
      event_type: 'wedding',
      event_name: `Zip InvalidateAll ${slugCounter}`,
      event_date: '2026-09-01',
      host_email: 'h@example.com',
      admin_email: 'a@example.com',
      password_hash: 'x',
      share_link: `/gallery/${slug}/s`,
      share_token: `${slug}-share`,
      expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      require_password: 0,
      allow_downloads: 1,
      created_at: new Date().toISOString(),
    }).returning('id');
    const event = { id: ev[0]?.id ?? ev[0], slug };

    const dir = path.join(mockStorageRoot, 'events/active', slug);
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 1; i <= 3; i += 1) {
      const filename = `photo-${i}.jpg`;
      fs.writeFileSync(path.join(dir, filename), Buffer.alloc(4096, i));
      // eslint-disable-next-line no-await-in-loop
      await db('photos').insert({
        event_id: event.id,
        filename,
        path: `${slug}/${filename}`,
        type: 'individual',
        source_origin: 'managed',
        mime_type: 'image/jpeg',
        visibility: 'visible',
        uploaded_at: new Date(Date.now() + i).toISOString(),
      });
    }
    return event;
  }

  // Arm the gate; resolves once a build is parked on it.
  function armGate() {
    mockGate.armed = true;
    let openGate;
    mockGate.open = new Promise((resolve) => { openGate = resolve; });
    const reached = new Promise((resolve) => { mockGate.reached = resolve; });
    return {
      reached,
      open: () => { mockGate.armed = false; openGate(); },
    };
  }

  const zipRow = (event) => db('events').where({ id: event.id }).first('download_zip_path');
  const flush = async () => {
    for (let i = 0; i < 20; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setImmediate(resolve));
    }
  };

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
  }, 120000);

  afterEach(() => {
    // Don't let a real 30s rebuild timer outlive the test.
    for (const timer of service.debounceTimers.values()) clearTimeout(timer);
    service.debounceTimers.clear();
    service.pendingSince.clear();
  });

  afterAll(async () => {
    await service.stop();
    if (cleanup) await cleanup();
  });

  it('stops a build that started before the change, and schedules a rebuild', async () => {
    const event = await createEvent();
    const gate = armGate();

    // A guest's download-all, or a rebuild after an earlier change: the event
    // has no zip yet.
    const building = service.generateZip(event.id);
    await gate.reached;
    expect((await zipRow(event)).download_zip_path).toBeNull();

    await service.invalidateAll();
    gate.open();
    const result = await building;
    await flush();

    expect(result).toEqual({ success: false, error: 'Build invalidated' });
    expect((await zipRow(event)).download_zip_path).toBeNull();
    expect(fs.existsSync(path.join(mockStorageRoot, service.getCacheKey(event.slug)))).toBe(false);
    expect(service.debounceTimers.has(event.id)).toBe(true);
  });

  it('still invalidates events whose zip is already published', async () => {
    const event = await createEvent();
    const first = await service.generateZip(event.id);
    expect(first.success).toBe(true);
    expect((await zipRow(event)).download_zip_path).not.toBeNull();

    await service.invalidateAll();
    await flush();

    expect((await zipRow(event)).download_zip_path).toBeNull();
    expect(fs.existsSync(path.join(mockStorageRoot, service.getCacheKey(event.slug)))).toBe(false);
    expect(service.debounceTimers.has(event.id)).toBe(true);
  });
});
