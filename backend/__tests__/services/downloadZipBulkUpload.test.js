/**
 * A bulk upload must not rebuild the "Download All" zip once per batch.
 *
 * Every upload batch ends with downloadZipService.invalidate(), which used to
 * re-arm a 5s debounce. The admin uploader sends up to 95 MB per batch, so the
 * next batch was always still in transit when the 5s ran out: a full rebuild
 * started during every batch. On a live server a 4.2 GB upload (415 photos,
 * ~17 min) completed 12 builds growing from 97 MB to 4.38 GB, cancelled
 * dozens more, and wrote each completed zip twice (a tmp file in the container
 * layer, then a copy into storage) — ~74 GB written for 4.2 GB of photos.
 *
 * These drive the service on fake timers through the upload's timeline. A
 * build that starts runs on real I/O to completion before simulated time moves
 * on, which is the old code's worst case (every build finishes and is
 * published), and every byte the builds write to disk is counted.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { EventEmitter } = require('events');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-zipbulk-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'zipbulk-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-zipbulk-storage-'));

const PHOTO_BYTES = 64 * 1024;
const INITIAL_PHOTOS = 10;
const PHOTOS_PER_BATCH = 5;
// Time to send one batch, and between one batch's response and the next
// request. 20s is what a 95 MB batch takes at the ~4 MB/s of the live upload.
const TRANSFER_MS = 20 * 1000;
const BETWEEN_BATCHES_MS = 500;

const LocalFsStorage = require('../../src/services/storage/LocalFsStorage');

const mockStorageRoot = process.env.STORAGE_PATH;
const mockLocal = new LocalFsStorage({ root: mockStorageRoot });

// The S3 backend as the builder sees it: no local paths, and putFromFile
// sends the file over the network instead of writing it to this disk.
const mockRemoteObjects = new Map();
const uploadToRemote = async (key, localPath) => {
  mockRemoteObjects.set(key, fs.statSync(localPath).size);
};
const mockS3 = {
  kind: () => 's3',
  resolveLocalPath: () => null,
  get: (key) => mockLocal.get(key),
  putFromFile: jest.fn(uploadToRemote),
  stat: async (key) => (mockRemoteObjects.has(key)
    ? { size: mockRemoteObjects.get(key), mtime: new Date() }
    : mockLocal.stat(key)),
  delete: async (key) => { mockRemoteObjects.delete(key); },
};
const mockBackend = { current: mockLocal };

jest.mock('../../src/services/storage', () => ({
  getStorage: () => mockBackend.current,
  initStorage: async () => mockBackend.current,
}));

const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');
const service = require('../../src/services/downloadZipService');

const realBuild = Object.getPrototypeOf(service)._build;

function zipEntryCount(file) {
  const buf = fs.readFileSync(file);
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  return buf.readUInt16LE(eocd + 10);
}

// Spin the real event loop (fake timers leave setImmediate alone) until the
// predicate holds — for fire-and-forget work such as invalidate()'s cleanup.
async function waitForIo(predicate) {
  for (let turn = 0; turn < 20000; turn += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await predicate()) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('waitForIo: condition never held');
}

// Let every build the timers started run to completion before simulated time
// moves on.
async function settleBuilds() {
  for (let idleTurns = 0; idleTurns < 5;) {
    const builds = [...service.activeBuilds.values()];
    if (builds.length) {
      idleTurns = 0;
      // eslint-disable-next-line no-await-in-loop
      await Promise.all(builds.map((build) => build.promise.catch(() => {})));
    } else {
      idleTurns += 1;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
}

async function advance(ms, { settle = true } = {}) {
  for (let left = ms; left > 0; left -= 500) {
    // eslint-disable-next-line no-await-in-loop
    await jest.advanceTimersByTimeAsync(Math.min(500, left));
    // eslint-disable-next-line no-await-in-loop
    if (settle) await settleBuilds();
  }
}

describe('pre-zip rebuilds during a bulk upload', () => {
  let db; let cleanup;
  let slugCounter = 0;
  let photoCounter = 0;
  // What the builds started and wrote, reset per test.
  let buildStarts; let zipWrites; let zipCopies;

  async function addPhotos(event, count) {
    const dir = path.join(mockStorageRoot, 'events/active', event.slug);
    fs.mkdirSync(dir, { recursive: true });
    const ids = [];
    for (let i = 0; i < count; i += 1) {
      photoCounter += 1;
      const filename = `photo-${photoCounter}.jpg`;
      fs.writeFileSync(path.join(dir, filename), Buffer.alloc(PHOTO_BYTES, photoCounter % 251));
      // eslint-disable-next-line no-await-in-loop
      const inserted = await db('photos').insert({
        event_id: event.id,
        filename,
        path: `${event.slug}/${filename}`,
        type: 'individual',
        source_origin: 'managed',
        mime_type: 'image/jpeg',
        visibility: 'visible',
        uploaded_at: new Date(Date.now() + photoCounter).toISOString(),
      }).returning('id');
      ids.push(inserted[0]?.id ?? inserted[0]);
    }
    return ids;
  }

  // An event whose gallery already has photos and a published zip.
  async function createEvent() {
    slugCounter += 1;
    const slug = `zipbulk-${slugCounter}`;
    const ev = await db('events').insert({
      slug,
      event_type: 'wedding',
      event_name: `Zip Bulk ${slugCounter}`,
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
    await addPhotos(event, INITIAL_PHOTOS);
    const first = await service.generateZip(event.id);
    expect(first.success).toBe(true);
    return event;
  }

  const finalZipPath = (event) => path.join(mockStorageRoot, service.getCacheKey(event.slug));
  const bytesWritten = () => zipWrites.reduce((sum, stream) => sum + stream.bytesWritten, 0)
    + zipCopies.reduce((sum, size) => sum + size, 0);

  // The admin uploader: one request per batch, sent as soon as the previous
  // one returns. The route holds the rebuild while the batch is arriving and
  // invalidates once its photos are stored.
  async function uploadInBatches(event, batches) {
    for (let n = 0; n < batches; n += 1) {
      const release = service.holdRebuild(event.id);
      // eslint-disable-next-line no-await-in-loop
      await advance(TRANSFER_MS);
      // eslint-disable-next-line no-await-in-loop
      await addPhotos(event, PHOTOS_PER_BATCH);
      service.invalidate(event.id);
      release();
      // eslint-disable-next-line no-await-in-loop
      await advance(BETWEEN_BATCHES_MS);
    }
  }

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  beforeEach(() => {
    mockBackend.current = mockLocal;
    mockRemoteObjects.clear();
    mockS3.putFromFile.mockReset();
    mockS3.putFromFile.mockImplementation(uploadToRemote);
    buildStarts = [];
    zipWrites = [];
    zipCopies = [];
  });

  // Fake timers go on only after the event and its first zip exist.
  function startClock() {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    mockS3.putFromFile.mockClear();

    jest.spyOn(service, '_build').mockImplementation((...args) => {
      buildStarts.push(Date.now());
      return realBuild.apply(service, args);
    });
    const realCreateWriteStream = fs.createWriteStream;
    jest.spyOn(fs, 'createWriteStream').mockImplementation((file, ...rest) => {
      const stream = realCreateWriteStream.call(fs, file, ...rest);
      if (/picpeak-zipbuild-|\.download-cache/.test(String(file))) zipWrites.push(stream);
      return stream;
    });
    const realCopyFile = fs.promises.copyFile;
    jest.spyOn(fs.promises, 'copyFile').mockImplementation(async (src, dest, ...rest) => {
      if (String(dest).includes('.download-cache')) zipCopies.push(fs.statSync(src).size);
      return realCopyFile.call(fs.promises, src, dest, ...rest);
    });
  }

  afterEach(() => {
    for (const timer of service.debounceTimers.values()) clearTimeout(timer);
    service.debounceTimers.clear();
    service.pendingSince.clear();
    service.uploadHolds.clear();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('builds once, after the upload settles, and writes the zip to disk once', async () => {
    const event = await createEvent();
    startClock();

    await uploadInBatches(event, 20);
    const uploadEndedAt = Date.now();
    await advance(2 * 60 * 1000);

    const totalPhotos = INITIAL_PHOTOS + 20 * PHOTOS_PER_BATCH;
    expect(buildStarts).toHaveLength(1);
    // Ready within the quiet period of the last batch.
    expect(buildStarts[0] - uploadEndedAt).toBeLessThanOrEqual(35 * 1000);

    const info = await service.getZipInfo(event.id);
    expect(info).not.toBeNull();
    expect(zipEntryCount(finalZipPath(event))).toBe(totalPhotos);

    // Written once, in place, then renamed: no tmp file in the container
    // layer and no second copy into storage.
    expect(zipCopies).toHaveLength(0);
    expect(bytesWritten()).toBeLessThanOrEqual(info.size * 1.05);
    expect(fs.readdirSync(path.dirname(finalZipPath(event)))).toEqual(['all.zip']);
  });

  it('builds once on S3 too, writing only the tmp zip it uploads', async () => {
    mockBackend.current = mockS3;
    const event = await createEvent();
    startClock();

    await uploadInBatches(event, 8);
    await advance(2 * 60 * 1000);

    expect(buildStarts).toHaveLength(1);
    expect(mockS3.putFromFile).toHaveBeenCalledTimes(1);
    const info = await service.getZipInfo(event.id);
    expect(info).not.toBeNull();
    expect(bytesWritten()).toBeLessThanOrEqual(info.size * 1.05);
    for (const stream of zipWrites) expect(fs.existsSync(path.dirname(stream.path))).toBe(false);
  });

  it('coalesces changes that arrive without a hold, 20s apart, into one build', async () => {
    // The file watcher and the gallery visibility toggles invalidate without
    // holding: only the quiet period keeps them from rebuilding in between.
    const event = await createEvent();
    startClock();

    for (let n = 0; n < 12; n += 1) {
      // eslint-disable-next-line no-await-in-loop
      await addPhotos(event, 1);
      service.invalidate(event.id);
      // eslint-disable-next-line no-await-in-loop
      await advance(20 * 1000);
    }
    await advance(2 * 60 * 1000);

    expect(buildStarts).toHaveLength(1);
    expect(zipEntryCount(finalZipPath(event))).toBe(INITIAL_PHOTOS + 12);
  });

  it('still rebuilds during a long trickle of changes, at most once per 10 minutes', async () => {
    const event = await createEvent();
    startClock();

    const changes = [];
    for (let n = 0; n < 75; n += 1) { // 25 minutes, one change every 20s
      // eslint-disable-next-line no-await-in-loop
      await addPhotos(event, 1);
      changes.push(Date.now());
      service.invalidate(event.id);
      // eslint-disable-next-line no-await-in-loop
      await advance(20 * 1000);
    }
    await advance(2 * 60 * 1000);

    // Two overdue builds inside the trickle, then the one after it.
    expect(buildStarts.length).toBeGreaterThanOrEqual(2);
    expect(buildStarts.length).toBeLessThanOrEqual(3);
    // Never sooner than 5s after a change.
    for (const startedAt of buildStarts) {
      const lastChange = Math.max(...changes.filter((t) => t <= startedAt));
      expect(startedAt - lastChange).toBeGreaterThanOrEqual(5 * 1000);
    }
    expect(zipEntryCount(finalZipPath(event))).toBe(INITIAL_PHOTOS + 75);
  });

  it('drops the cached zip at once, so a deleted photo is never served while the rebuild waits', async () => {
    const event = await createEvent();
    startClock();
    const [doomed] = await addPhotos(event, 1);
    service.invalidate(event.id);
    await advance(60 * 1000);
    expect(zipEntryCount(finalZipPath(event))).toBe(INITIAL_PHOTOS + 1);

    await db('photos').where({ id: doomed }).delete();
    service.invalidate(event.id);

    await waitForIo(async () => (await service.getZipInfo(event.id)) === null);
    expect(fs.existsSync(finalZipPath(event))).toBe(false);

    await advance(60 * 1000);
    expect(zipEntryCount(finalZipPath(event))).toBe(INITIAL_PHOTOS);
  });

  it('rebuilds after a held request that added nothing, once the hold is released', async () => {
    const event = await createEvent();
    startClock();
    await addPhotos(event, 1);
    service.invalidate(event.id);

    // A batch that takes longer than the quiet period and is then rejected
    // (no photos stored, so no invalidate of its own).
    const release = service.holdRebuild(event.id);
    await advance(2 * 60 * 1000);
    expect(buildStarts).toHaveLength(0);
    release();
    await advance(60 * 1000);

    expect(buildStarts).toHaveLength(1);
    expect(zipEntryCount(finalZipPath(event))).toBe(INITIAL_PHOTOS + 1);
  });

  it('does not rebuild again after a guest download rebuilt it during the quiet period', async () => {
    const event = await createEvent();
    startClock();
    await addPhotos(event, 1);
    service.invalidate(event.id);
    await advance(10 * 1000);

    // download-all with no cached zip streams the archive and starts a build
    // for the next guest straight away (routes/gallery/downloads.js).
    const result = await service.generateZip(event.id);
    expect(result.success).toBe(true);
    await advance(2 * 60 * 1000);

    expect(buildStarts).toHaveLength(1);
    expect(zipEntryCount(finalZipPath(event))).toBe(INITIAL_PHOTOS + 1);
  });

  it('waits for an invalidated build that is still uploading, then rebuilds', async () => {
    mockBackend.current = mockS3;
    const event = await createEvent();
    startClock();

    // The first upload stalls until released. An invalidated build cannot
    // abort it, so it is still running when the next rebuild comes due.
    let releaseUpload;
    const uploadGate = new Promise((resolve) => { releaseUpload = resolve; });
    mockS3.putFromFile.mockImplementationOnce(async (key, localPath) => {
      const size = fs.statSync(localPath).size;
      await uploadGate;
      mockRemoteObjects.set(key, size);
    });

    await addPhotos(event, 1);
    service.invalidate(event.id);
    await advance(60 * 1000, { settle: false });
    await waitForIo(() => mockS3.putFromFile.mock.calls.length === 1);

    await addPhotos(event, 1);
    service.invalidate(event.id);
    await advance(60 * 1000, { settle: false });

    releaseUpload();
    await settleBuilds();

    expect(buildStarts).toHaveLength(2);
    const info = await service.getZipInfo(event.id);
    expect(info).not.toBeNull();
    expect(mockS3.putFromFile).toHaveBeenCalledTimes(2);
  });
});

describe('holdRebuildUntilDone', () => {
  afterEach(() => {
    service.uploadHolds.clear();
    service.pendingSince.clear();
  });

  it('holds until the response finishes, and releases once', () => {
    const res = new EventEmitter();
    service.holdRebuildUntilDone(4242, res);
    expect(service.uploadHolds.get(4242)).toBe(1);

    res.emit('finish');
    res.emit('close');
    expect(service.uploadHolds.has(4242)).toBe(false);
  });

  it('releases when the client goes away mid-request', () => {
    const res = new EventEmitter();
    service.holdRebuildUntilDone(4243, res);
    service.holdRebuildUntilDone(4243, new EventEmitter());
    expect(service.uploadHolds.get(4243)).toBe(2);

    res.emit('close');
    expect(service.uploadHolds.get(4243)).toBe(1);
  });
});

describe('sweepStaleBuildDirs on local storage', () => {
  let tmpRoot;

  beforeEach(() => {
    mockBackend.current = mockLocal;
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-zipbulk-sweep-'));
    jest.spyOn(os, 'tmpdir').mockReturnValue(tmpRoot);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    service.liveStagingZips.clear();
  });

  it('removes staging zips an interrupted build left in the download cache', async () => {
    const cacheDir = path.join(mockStorageRoot, 'events/active/sweep-me/.download-cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    const make = (name, ageMs) => {
      const file = path.join(cacheDir, name);
      fs.writeFileSync(file, 'partial');
      const when = new Date(Date.now() - ageMs);
      fs.utimesSync(file, when, when);
      return file;
    };
    const stale = make('all.zip.tmp.17.0badc0de', 60 * 60 * 1000);
    const fresh = make('all.zip.tmp.17.0000beef', 1000);
    const live = make('all.zip.tmp.17.0000aaaa', 60 * 60 * 1000);
    const published = make('all.zip', 60 * 60 * 1000);
    const jobZip = make('job-12.zip.tmp.17.0badc0de', 60 * 60 * 1000);
    service.liveStagingZips.add(live);

    const removed = await service.sweepStaleBuildDirs({ minAgeMs: 10 * 60 * 1000 });

    expect(removed).toBe(1);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(live)).toBe(true);
    expect(fs.existsSync(published)).toBe(true);
    expect(fs.existsSync(jobZip)).toBe(true);
  });
});
