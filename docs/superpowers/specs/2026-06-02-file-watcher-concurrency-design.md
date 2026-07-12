# File Watcher Concurrency Fix

**Date:** 2026-06-02
**Branch:** `fix/upload-processing-queue`
**Scope:** Personal fork only (`filpgame/picpeak`)

## Problem

The backend crashed (exit code 1, 3.7 GB memory peak on a 4 GB machine) during large photo uploads. Root cause: `fileWatcher.js` calls `processNewPhoto` concurrently with no limit.

On restart, chokidar emits `add` for every existing file in `events/active/`. Files that landed during a prior session that crashed with SQLITE_IOERR errors exist on disk but have no DB record. The watcher tries to generate thumbnails for all of them simultaneously — each 24 MP JPEG decodes to ~72 MB in libvips — exhausting available RAM.

The admin upload route was already migrated to the async queue pattern (`processing_status='pending'` + background processor). `processUploadedPhotos` is only called for chunked uploads (one file at a time, not a concern). The background processor correctly caps concurrency via `UPLOAD_PROCESSOR_CONCURRENCY` (default 2). The file watcher was the only uncapped path.

## Architecture

Three surgical changes, no new services or data model changes:

```
fileWatcher.js  ──  pLimit(2) wrapping processNewPhoto callbacks
server.js       ──  sharp.concurrency(1) + sharp.cache({memory:100}) at startup
.env (server)   ──  UPLOAD_PROCESSOR_CONCURRENCY=2 (explicit, was implicit default)
```

## Components

### 1. `backend/src/services/fileWatcher.js`

Add `p-limit` import (install `p-limit@3` — last CommonJS-compatible version). Wrap the `on('add')` callback:

```js
const pLimit = require('p-limit');
const limit = pLimit(2);  // module-level, shared across all add events

watcher.on('add', (filePath) => {
  limit(() => processNewPhoto(filePath)).catch((error) => {
    logger.error('Error processing new photo:', error);
  });
});
```

`p-limit(2)` queues excess calls internally; they drain in FIFO order. The error handling moves to `.catch()` on the promise since the callback is no longer `async`.

### 2. `backend/server.js`

Add sharp configuration near the top, after `require('sharp')`:

```js
const sharp = require('sharp');
sharp.concurrency(1);
sharp.cache({ memory: 100 });
```

`sharp.concurrency(1)` limits libvips to 1 thread per sharp operation (still parallelised across operations by p-limit / background processor). `sharp.cache({ memory: 100 })` caps libvips internal tile/decode cache at 100 MB instead of the default unlimited.

### 3. Server `.env`

```
UPLOAD_PROCESSOR_CONCURRENCY=2
```

Documents the chosen value explicitly so future updates don't silently change it.

## Data Flow

**Startup (many existing files):**
```
chokidar emits N add events
→ pLimit queues them
→ processNewPhoto runs 2 at a time
→ most find existing DB record → skip (no sharp call)
→ orphaned files (no DB record) → generateThumbnail via sharp
→ sharp respects concurrency(1) and cache(100MB)
```

**Normal upload (admin UI):**
```
Upload handler: putFromFile → DB insert (processing_status=pending) → return 200
backgroundProcessor: 2 workers claim pending rows → processPhoto → thumbnail
fileWatcher: sees file, finds existing DB record → skips
```

## Error Handling

- `pLimit` propagates rejections from `processNewPhoto` to the `.catch()` handler — same behavior as before, just serialised.
- If `processNewPhoto` fails for a file, the limit slot is released and the next queued call proceeds.
- Sharp config failures at startup are fatal by design (if sharp can't configure, something is wrong with the environment).

## Testing

- Upload 150+ photos in a single batch; verify service memory stays below 2 GB.
- Restart service with many photos on disk; verify it starts without OOM.
- Verify thumbnails are generated (check DB `thumbnail_path` not null after ~30s).
- Verify `UPLOAD_PROCESSOR_CONCURRENCY` env var is present in server `.env`.
