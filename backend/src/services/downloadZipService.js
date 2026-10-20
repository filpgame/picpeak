/**
 * DownloadZipService
 *
 * Pre-generates ZIP archives for "Download All" so guests get instant
 * downloads with Content-Length instead of on-the-fly streaming that
 * crashes mobile browsers.
 *
 * Pattern follows watermarkGeneratorService.js — singleton with
 * in-memory locking and debounced background regeneration.
 *
 * Storage: on local fs the zip is written next to its final key and renamed
 * into place. On S3 it is written to a local tmp file then uploaded via
 * storage.putFromFile. The cached zip is served via the storage backend on
 * download.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const archiver = require('archiver');
const { db } = require('../database/db');
const watermarkService = require('./watermarkService');
const { resolvePhotoStorageKey, resolvePhotoFilePath } = require('./photoResolver');
const { getStorage } = require('./storage');
const { getUseOriginalFilenames, getZipEntryNames } = require('./downloadFilenameService');
const { renderPhotoForDownload } = require('./downloadRendition');
const { resolveEventDownloadPolicy } = require('../utils/downloadResolutions');
const logger = require('../utils/logger');

// A background rebuild starts only once the event has been quiet this long: no
// invalidate() and no upload still receiving photos for it (holdRebuild).
//
// Every rebuild rewrites the WHOLE archive. This used to be a 5s debounce, and
// the admin uploader takes longer than that to send its next batch (up to
// 95 MB), so every batch started a full rebuild: a 4.2 GB upload in ~45
// batches completed 12 builds (97 MB up to 4.38 GB), cancelled dozens more and
// wrote ~74 GB. Holds cover a batch however slowly it arrives; this covers the
// gaps between requests and the callers that don't hold (the file watcher,
// gallery visibility toggles), and still has the zip ready about half a minute
// after an upload ends.
const QUIET_MS = 30 * 1000;
// A rebuild pending for this long falls back to the old 5s debounce, so a
// steady trickle of changes (an auto-import folder fed through a live event)
// still gets a zip, at most one build per 10 minutes. Holds still apply.
const OVERDUE_AFTER_MS = 10 * 60 * 1000;
const OVERDUE_QUIET_MS = 5 * 1000;

// Prefix of the per-build tmp directory, and how old an unowned one must be
// before the startup sweep treats it as the remains of an interrupted build.
const BUILD_DIR_PREFIX = 'picpeak-zipbuild-';
const STALE_BUILD_DIR_AGE_MS = 10 * 60 * 1000;
// A local-fs build writes its zip beside the cached one under this name — the
// staging name LocalFsStorage uses, so storage listings skip it.
const STAGING_ZIP_RE = /^all\.zip\.tmp\.\d+\.[0-9a-f]+$/;

// How many storage reads may be open at once while the archive is built.
// archiver drains its queue one entry at a time, so a stream appended ahead of
// its turn just parks an S3 socket with a full receive buffer. The SDK agent
// pool is 50 sockets wide and shared with uploads, thumbnails and gallery
// reads, so an unbounded loop over a large event starves the whole process.
// Two keeps the next photo's round trip overlapped with the current write
// without ever leaving more than one socket idle.
const MAX_INFLIGHT_READS = 2;
// How many cached zips may be REBUILT at once in the background (#1399).
//
// invalidateAll() invalidates every event that has a cached zip, and each
// invalidate() arms its own debounce timer in the same tick — so they all fire
// together and, before this, every one of them started building at once. Each
// build opens its own storage reads, so 25 events was enough to exhaust the S3
// agent pool and stall uploads, thumbnails and gallery reads until the burst
// finished.
//
// This caps the BACKGROUND path only. A foreground generateZip() — a guest
// actually waiting for a download — is never queued behind a rebuild.
const MAX_CONCURRENT_REGENS = 2;

class DownloadZipService {
  constructor() {
    this.activeBuilds = new Map();   // eventId -> { promise, version }
    this.debounceTimers = new Map();  // eventId -> setTimeout handle
    this.pendingSince = new Map();    // eventId -> when its pending rebuild was first asked for
    this.uploadHolds = new Map();     // eventId -> requests still receiving photos
    this.versions = new Map();        // eventId -> generation counter
    this.publishedVersions = new Map(); // eventId -> version of the zip last published
    this.buildCancellers = new Map(); // eventId -> abort the in-flight build
    this.regenActive = 0;             // background rebuilds running right now
    this.regenWaiters = [];           // resolvers parked waiting for a slot
    this.liveTmpDirs = new Set();     // tmp build dirs owned by a running build
    this.liveStagingZips = new Set(); // local-fs staging zips owned by a running build
    this.stopped = false;
  }

  /**
   * Remove tmp build directories that no running build owns.
   *
   * A build the process died in the middle of (container restart, VM reboot,
   * OOM kill) never reaches its `finally`, so its partial zip stays in the tmp
   * dir for good — on Docker that is the container's writable layer, which
   * nothing else cleans. On local storage the build writes beside the cached
   * zip instead, so the same goes for staging zips in each event's
   * `.download-cache`. Meant to run once at startup. Anything a build in this
   * process owns is skipped, as is anything modified within `minAgeMs`.
   * Returns how many directories and staging zips were removed.
   */
  async sweepStaleBuildDirs({ minAgeMs = STALE_BUILD_DIR_AGE_MS } = {}) {
    return (await this._sweepTmpBuildDirs(minAgeMs)) + (await this._sweepStagingZips(minAgeMs));
  }

  async _sweepTmpBuildDirs(minAgeMs) {
    const root = os.tmpdir();
    let entries;
    try {
      entries = await fsp.readdir(root, { withFileTypes: true });
    } catch (err) {
      logger.warn('downloadZipService.sweepStaleBuildDirs: cannot read tmp dir', { dir: root, error: err.message });
      return 0;
    }

    let removed = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(BUILD_DIR_PREFIX)) continue;
      const dir = path.join(root, entry.name);
      if (this.liveTmpDirs.has(dir)) continue;
      try {
        const { mtimeMs } = await fsp.stat(dir);
        if (Date.now() - mtimeMs < minAgeMs) continue;
        await fsp.rm(dir, { recursive: true, force: true });
        removed += 1;
        logger.info('Removed stale pre-zip build directory', { dir });
      } catch (err) {
        logger.warn('downloadZipService.sweepStaleBuildDirs: could not remove directory', { dir, error: err.message });
      }
    }
    return removed;
  }

  async _sweepStagingZips(minAgeMs) {
    let activeRoot;
    try {
      const storage = getStorage();
      activeRoot = storage.kind() === 'local' ? storage.resolveLocalPath('events/active') : null;
    } catch (_) {
      activeRoot = null;
    }
    if (!activeRoot) return 0;

    let events;
    try {
      events = await fsp.readdir(activeRoot, { withFileTypes: true });
    } catch (err) {
      if (err.code !== 'ENOENT') {
        logger.warn('downloadZipService.sweepStaleBuildDirs: cannot read events dir', { dir: activeRoot, error: err.message });
      }
      return 0;
    }

    let removed = 0;
    for (const event of events) {
      if (!event.isDirectory()) continue;
      const cacheDir = path.join(activeRoot, event.name, '.download-cache');
      let names;
      try {
        names = await fsp.readdir(cacheDir);
      } catch (_) {
        continue; // no download cache for this event
      }
      for (const name of names) {
        if (!STAGING_ZIP_RE.test(name)) continue;
        const file = path.join(cacheDir, name);
        if (this.liveStagingZips.has(file)) continue;
        try {
          const { mtimeMs } = await fsp.stat(file);
          if (Date.now() - mtimeMs < minAgeMs) continue;
          await fsp.unlink(file);
          removed += 1;
          logger.info('Removed stale pre-zip staging file', { file });
        } catch (err) {
          if (err.code !== 'ENOENT') {
            logger.warn('downloadZipService.sweepStaleBuildDirs: could not remove staging zip', { file, error: err.message });
          }
        }
      }
    }
    return removed;
  }

  /**
   * Run a BACKGROUND rebuild under the concurrency cap (#1399). Foreground
   * callers deliberately do not go through here: someone is waiting on that
   * response, and making them queue behind a settings-change burst would trade
   * one stall for another.
   */
  async _withRegenSlot(fn) {
    if (this.stopped) return undefined;
    if (this.regenActive >= MAX_CONCURRENT_REGENS) {
      await new Promise((resolve) => this.regenWaiters.push(resolve));
      // Shutdown can drain the queue while we were parked.
      if (this.stopped) return undefined;
    }
    this.regenActive += 1;
    try {
      return await fn();
    } finally {
      this.regenActive -= 1;
      const next = this.regenWaiters.shift();
      if (next) next();
    }
  }

  async stop() {
    this.stopped = true;
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();
    this.pendingSince.clear();
    this.uploadHolds.clear();
    this.publishedVersions.clear();
    // Release anything parked for a slot so shutdown can't hang on a queue
    // that will never drain — they check `stopped` and return without building.
    const waiters = this.regenWaiters.splice(0);
    for (const resume of waiters) resume();
    await Promise.allSettled([...this.activeBuilds.values()].map(build => build.promise));
    this.versions.clear();
    this.buildCancellers.clear();
  }

  /**
   * Relative storage key for the cached zip.
   */
  getCacheKey(slug) {
    return path.posix.join('events/active', slug, '.download-cache', 'all.zip');
  }

  /**
   * Check if a valid cached zip exists.
   * Returns { key, size, generatedAt } or null. The key is a relative storage
   * key — callers stream it via storage.get() rather than reading directly.
   */
  async getZipInfo(eventId) {
    try {
      const event = await db('events')
        .where({ id: eventId })
        .select('download_zip_path', 'download_zip_generated_at', 'slug')
        .first();

      if (!event || !event.download_zip_path) return null;

      const storage = getStorage();
      const key = this.getCacheKey(event.slug);
      const stat = await storage.stat(key);
      if (!stat) {
        // File gone — clear stale DB record
        await db('events').where({ id: eventId }).update({
          download_zip_path: null,
          download_zip_generated_at: null,
        });
        return null;
      }
      return {
        key,
        size: stat.size,
        generatedAt: event.download_zip_generated_at,
      };
    } catch (err) {
      logger.warn('downloadZipService.getZipInfo error', { eventId, error: err.message });
      return null;
    }
  }

  /**
   * Generate the pre-zip for an event. Returns { success, key, size } or { success: false }.
   * Concurrent calls for the same eventId share one in-flight build.
   */
  async generateZip(eventId) {
    // Share a build that is still current. One that an invalidate() overtook
    // can still be running (an S3 upload it cannot abort) and it publishes to
    // the same key, so wait for it to finish rather than overlap it. Handing
    // back its promise instead reported 'Build invalidated' to the rebuild
    // the invalidate() asked for, and no zip was built at all.
    let existing = this.activeBuilds.get(eventId);
    while (existing) {
      if (existing.version === this.versions.get(eventId)) return existing.promise;
      await existing.promise.catch(() => {});
      existing = this.activeBuilds.get(eventId);
    }

    const version = (this.versions.get(eventId) || 0) + 1;
    this.versions.set(eventId, version);

    const promise = this._build(eventId, version);
    this.activeBuilds.set(eventId, { promise, version });

    try {
      return await promise;
    } finally {
      // Only clear if this is still the active build
      const current = this.activeBuilds.get(eventId);
      if (current && current.version === version) {
        this.activeBuilds.delete(eventId);
      }
    }
  }

  async _build(eventId, version) {
    const storage = getStorage();
    let tmpDir;
    // Local fs only: the zip is written beside the cached one and renamed
    // over it.
    let stagingPath = null;
    // The tmp zip being written. Kept out here so `finally` can close it: an
    // archive that was aborted never does (see the comment there).
    let output = null;

    // Storage reads appended to the archive but not yet drained. A failed or
    // invalidated build must destroy them: archiver's own abort() leaves the
    // source streams alone, and an unread S3 response body holds its socket
    // open for the life of the process (the SDK arms its socketTimeout on a
    // 3s delay and clears it as soon as the response headers land, so
    // nothing ever reclaims the socket).
    const openReads = new Set();
    let cancelled = false;
    let slotWaiter = null;

    const wakeSlotWaiter = () => {
      if (!slotWaiter) return;
      const resume = slotWaiter;
      slotWaiter = null;
      resume();
    };
    const releaseRead = (stream) => {
      openReads.delete(stream);
      wakeSlotWaiter();
    };
    // Assigned once the archive exists. Bumping the generation counter only
    // stops the build the next time the loop looks at it, and the loop can be
    // parked waiting for a read slot that a stalled archive will never free,
    // so invalidation cancels the build directly instead of leaving a note.
    let failBuild = null;

    const trackRead = (stream) => {
      openReads.add(stream);
      stream.once('end', () => releaseRead(stream));
      stream.once('close', () => releaseRead(stream));
      stream.once('error', () => releaseRead(stream));
      return stream;
    };

    try {
      const event = await db('events').where({ id: eventId }).first();
      if (!event) return { success: false, error: 'Event not found' };

      // The prebuilt zip is served to ordinary gallery guests (the
      // download-all fast path), so it must exclude hidden/client-only
      // photos — NULL visibility counts as visible (pre-migration rows).
      // PIN-clients bypass this cache and stream a full archive instead.
      const photos = await db('photos')
        .where({ event_id: eventId })
        .where(function () {
          this.where('visibility', 'visible').orWhereNull('visibility');
        })
        .select('*')
        .orderBy('type', 'asc')
        .orderBy('uploaded_at', 'desc');

      if (photos.length === 0) return { success: false, error: 'No photos' };

      // Watermark logic (same as gallery.js download-all)
      const watermarkSettings = await watermarkService.getWatermarkSettings();
      const eventWatermarkEnabled = event.watermark_downloads === true || event.watermark_downloads === 1;
      const shouldApplyWatermark = (watermarkSettings && watermarkSettings.enabled) || eventWatermarkEnabled;
      const effectiveSettings = shouldApplyWatermark ? {
        ...watermarkSettings,
        enabled: true,
        text: event.watermark_text || watermarkSettings?.text || 'Protected',
      } : null;

      // The cached archive is built AT the gallery's standard resolution
      // (#858) — 'original' keeps the historical behaviour. Any change to the
      // standard invalidates this zip via the settings write paths, so a
      // cached archive always matches the currently configured size.
      const { standardBox } = await resolveEventDownloadPolicy(event);

      const finalKey = this.getCacheKey(event.slug);

      // On local fs, write the zip where it will be served from and rename it
      // into place. Building in os.tmpdir() and handing it to putFromFile
      // wrote every zip twice — on Docker the tmp dir is the container layer,
      // on the same disk as storage — and the copy alone took as long as the
      // build. S3 has no local path and still uploads from a tmp file.
      const localFinalPath = storage.kind() === 'local' ? storage.resolveLocalPath(finalKey) : null;
      let tmpPath;
      if (localFinalPath) {
        await fsp.mkdir(path.dirname(localFinalPath), { recursive: true });
        stagingPath = `${localFinalPath}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
        this.liveStagingZips.add(stagingPath);
        tmpPath = stagingPath;
      } else {
        tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), BUILD_DIR_PREFIX));
        this.liveTmpDirs.add(tmpDir);
        tmpPath = path.join(tmpDir, `${crypto.randomBytes(4).toString('hex')}-all.zip`);
      }

      // #493: resolve display filenames (with collision suffix) before the
      // streaming starts so the loop just indexes the precomputed array.
      const useOriginal = await getUseOriginalFilenames();
      const entryNames = getZipEntryNames(photos, useOriginal);

      this.buildCancellers.set(eventId, () => {
        if (failBuild) failBuild(new Error('Build invalidated'));
      });

      // Build zip — level 0 (store only) since photos are already compressed
      await new Promise((resolve, reject) => {
        output = fs.createWriteStream(tmpPath);
        const archive = archiver('zip', { zlib: { level: 0 } });

        failBuild = (err) => {
          if (cancelled) return;
          cancelled = true;
          wakeSlotWaiter();
          // abort() throws if archiver already tore itself down.
          try { archive.abort(); } catch (_) { /* already aborted */ }
          reject(err);
        };

        output.on('close', resolve);
        // A write error (ENOSPC on the tmp file) is also followed by 'close';
        // failing first keeps that from reading as a finished zip.
        output.on('error', failBuild);
        archive.on('error', failBuild);
        archive.pipe(output);

        // Block until archiver has drained enough of its queue for another
        // read. Also returns when the build is cancelled, so a stalled
        // archive cannot park the loop here forever.
        const waitForReadSlot = async () => {
          while (!cancelled && openReads.size >= MAX_INFLIGHT_READS) {
            await new Promise((resume) => { slotWaiter = resume; });
          }
        };

        const uniqueTypes = new Set(photos.map(p => p.type)).size;
        const hasMultipleTypes = uniqueTypes > 1;

        const addPhotos = async () => {
          for (let i = 0; i < photos.length; i += 1) {
            const photo = photos[i];
            // Check if build was invalidated
            if (cancelled) return;
            if (this.versions.get(eventId) !== version) {
              return failBuild(new Error('Build invalidated'));
            }

            const entryName = entryNames[i];
            let archiveName;
            if (hasMultipleTypes) {
              const folderName = photo.type === 'individual' ? 'Individual Photos' : 'Collages';
              archiveName = path.join(folderName, entryName);
            } else {
              archiveName = entryName;
            }

            // External-mode photos still live on local disk; managed photos go
            // through the storage backend. resolvePhotoStorageKey returns null
            // for external, in which case fall back to resolvePhotoFilePath.
            const storageKey = resolvePhotoStorageKey(event, photo);

            // Resize to the gallery's standard resolution (#858) and/or
            // watermark. Returns null when neither applies, so an
            // original-size unwatermarked gallery still streams straight
            // from storage with nothing buffered.
            let rendered = null;
            try {
              rendered = await renderPhotoForDownload(event, photo, standardBox, effectiveSettings);
            } catch (err) {
              logger.warn('Skipping photo in pre-zip', { photoId: photo.id, error: err.message });
              continue;
            }

            if (rendered) {
              archive.append(rendered, { name: archiveName });
            } else if (storageKey) {
              await waitForReadSlot();
              if (cancelled) return;
              const stream = await storage.get(storageKey);
              // The build can be cancelled while the read is in flight, and a
              // stream nobody appends is a stream nobody closes.
              if (cancelled || this.versions.get(eventId) !== version) {
                stream.destroy();
                if (cancelled) return;
                return failBuild(new Error('Build invalidated'));
              }
              archive.append(trackRead(stream), { name: archiveName });
            } else {
              const filePath = resolvePhotoFilePath(event, photo);
              archive.file(filePath, { name: archiveName });
            }
          }

          archive.finalize();
        };

        addPhotos().catch(failBuild);
      });

      // Check version again — another invalidation may have arrived
      if (this.versions.get(eventId) !== version) {
        return { success: false, error: 'Build invalidated' };
      }

      // Publish. Both are atomic for a reader: rename() swaps the file in one
      // step (a download already streaming keeps the old inode), and an S3
      // key only exists once its multipart upload completes.
      if (stagingPath) {
        await fsp.rename(stagingPath, localFinalPath);
      } else {
        await storage.putFromFile(finalKey, tmpPath, { contentType: 'application/zip' });
      }

      // An invalidate() that arrived during the upload has already run its
      // cleanup; publishing now would put a zip built under the old settings
      // back into the row. Drop the object instead.
      if (this.versions.get(eventId) !== version) {
        await storage.delete(finalKey).catch(() => {});
        return { success: false, error: 'Build invalidated' };
      }

      const stat = await storage.stat(finalKey);
      // Gone again before it could be read back — a cleanup took it. There is
      // nothing to publish, and stat.size below would throw on null.
      if (!stat) {
        return { success: false, error: 'Build invalidated' };
      }

      await db('events').where({ id: eventId }).update({
        download_zip_path: finalKey,
        download_zip_generated_at: new Date(),
      });
      this.publishedVersions.set(eventId, version);

      logger.info('Pre-zip generated', { eventId, slug: event.slug, size: stat.size, photos: photos.length });
      return { success: true, key: finalKey, size: stat.size };
    } catch (err) {
      if (err.message === 'Build invalidated') {
        return { success: false, error: 'Build invalidated' };
      }
      logger.error('downloadZipService._build error', { eventId, error: err.message });
      return { success: false, error: err.message };
    } finally {
      this.buildCancellers.delete(eventId);
      for (const stream of openReads) {
        stream.destroy();
      }
      openReads.clear();
      // archiver only closes `output` once its active queue entry finishes,
      // and an entry whose source was destroyed above never does. A cancelled
      // or failed build would then unlink the partial zip but keep it open, and
      // its disk blocks stay allocated until the process exits — a bulk upload
      // cancels one build per batch, so that adds up to tens of GB. After a
      // successful build the stream has already closed and this does nothing.
      if (output && !output.destroyed) output.destroy();
      if (stagingPath) {
        // Already renamed away after a successful build.
        await fsp.unlink(stagingPath).catch(() => {});
        this.liveStagingZips.delete(stagingPath);
      }
      if (tmpDir) {
        await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
        this.liveTmpDirs.delete(tmpDir);
      }
    }
  }

  /**
   * Invalidate the cached zip for an event.
   * Deletes the file and clears DB now; the rebuild waits for the event to go
   * quiet (QUIET_MS).
   */
  invalidate(eventId) {
    // Bump version to signal any in-flight build is stale
    this.versions.set(eventId, (this.versions.get(eventId) || 0) + 1);

    // Stop the in-flight build now so it releases its storage reads, rather
    // than when it next reaches the top of its loop.
    const cancelBuild = this.buildCancellers.get(eventId);
    if (cancelBuild) cancelBuild();

    // Fire-and-forget cleanup. The old zip goes now rather than when its
    // replacement is ready: after a delete, hide or settings change it holds
    // photos guests may no longer get, and until the rebuild the download
    // route streams the archive instead.
    this._cleanup(eventId).catch(err =>
      logger.warn('downloadZipService.invalidate cleanup error', { eventId, error: err.message })
    );

    this._scheduleRegen(eventId);
  }

  /**
   * Keep background rebuilds of this event's zip from starting until the
   * returned release() is called. For a request still receiving photos for
   * the event: anything built meanwhile would be thrown away by the
   * invalidate() it ends with. A rebuild that came due during the hold is
   * re-armed on release. Foreground generateZip() calls are not held.
   */
  holdRebuild(eventId) {
    this.uploadHolds.set(eventId, (this.uploadHolds.get(eventId) || 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.uploadHolds.get(eventId) || 1) - 1;
      if (left > 0) {
        this.uploadHolds.set(eventId, left);
        return;
      }
      this.uploadHolds.delete(eventId);
      if (!this.stopped && this.pendingSince.has(eventId) && !this.debounceTimers.has(eventId)) {
        this._scheduleRegen(eventId);
      }
    };
  }

  /**
   * holdRebuild() for the life of an HTTP response: released when it
   * finishes, or when the client goes away first.
   */
  holdRebuildUntilDone(eventId, res) {
    const release = this.holdRebuild(eventId);
    res.once('finish', release);
    res.once('close', release);
  }

  // (Re)arm the event's rebuild timer: a trailing debounce of QUIET_MS, or of
  // OVERDUE_QUIET_MS once the rebuild has waited OVERDUE_AFTER_MS.
  _scheduleRegen(eventId) {
    const timer = this.debounceTimers.get(eventId);
    if (timer) clearTimeout(timer);

    const now = Date.now();
    if (!this.pendingSince.has(eventId)) this.pendingSince.set(eventId, now);
    const overdue = now - this.pendingSince.get(eventId) >= OVERDUE_AFTER_MS;

    this.debounceTimers.set(eventId, setTimeout(() => {
      this.debounceTimers.delete(eventId);
      // An upload is still arriving; releasing its hold re-arms this.
      if (this.uploadHolds.has(eventId)) return;
      // Through the cap (#1399): invalidateAll arms every one of these in the
      // same tick, so without it they all start building together.
      this._withRegenSlot(() => {
        // Re-armed or held again while this waited for a slot: whichever
        // fires next builds instead.
        if (this.debounceTimers.has(eventId) || this.uploadHolds.has(eventId)) return undefined;
        this.pendingSince.delete(eventId);
        // A guest's download already rebuilt it after the last change (or is
        // rebuilding it now, and generateZip shares that build).
        if (this.publishedVersions.has(eventId)
          && this.publishedVersions.get(eventId) === this.versions.get(eventId)) return undefined;
        return this.generateZip(eventId);
      }).catch(err =>
        logger.warn('downloadZipService debounced regen error', { eventId, error: err.message })
      );
    }, overdue ? OVERDUE_QUIET_MS : QUIET_MS));
  }

  /**
   * Invalidate all events (e.g., global watermark settings changed).
   */
  async invalidateAll() {
    // A build already running read the settings before they changed, and its
    // event has no download_zip_path yet (invalidate() clears it and only a
    // finished build sets it), so the query below misses it and it publishes
    // under the old settings. Listed before the query: a build that publishes
    // while the query runs has left activeBuilds by the time it returns.
    const eventIds = new Set(this.activeBuilds.keys());
    try {
      const events = await db('events')
        .whereNotNull('download_zip_path')
        .select('id');
      for (const event of events) eventIds.add(event.id);
    } catch (err) {
      logger.error('downloadZipService.invalidateAll error', { error: err.message });
    }
    for (const eventId of eventIds) {
      this.invalidate(eventId);
    }
  }

  /**
   * Full cleanup — delete file and clear DB. Used on event deletion/archival.
   */
  async cleanup(eventId) {
    this.versions.set(eventId, (this.versions.get(eventId) || 0) + 1);
    const timer = this.debounceTimers.get(eventId);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(eventId);
    }
    this.pendingSince.delete(eventId);
    this.publishedVersions.delete(eventId);
    await this._cleanup(eventId);
  }

  async _cleanup(eventId) {
    try {
      const storage = getStorage();
      const event = await db('events')
        .where({ id: eventId })
        .select('slug', 'download_zip_path')
        .first();

      if (event && event.download_zip_path) {
        await storage.delete(this.getCacheKey(event.slug)).catch(() => {});
      }

      await db('events').where({ id: eventId }).update({
        download_zip_path: null,
        download_zip_generated_at: null,
      });
    } catch (err) {
      logger.warn('downloadZipService._cleanup error', { eventId, error: err.message });
    }
  }
}

module.exports = new DownloadZipService();
