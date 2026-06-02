# File Watcher Concurrency Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent Node.js OOM crashes caused by unlimited concurrent sharp/libvips calls when the file watcher fires for many photos simultaneously.

**Architecture:** Add `p-limit(2)` to `fileWatcher.js` so at most 2 `processNewPhoto` calls run at once; cap libvips memory in `server.js`; document processor concurrency in server `.env`.

**Tech Stack:** Node.js (CommonJS), `p-limit@3` (last CJS-compatible version), `sharp@0.34.3`, Jest

---

## File Map

| File | Change |
|---|---|
| `backend/package.json` | add `p-limit@3` dependency |
| `backend/src/services/fileWatcher.js` | add p-limit, export `processNewPhoto` for testability |
| `backend/src/services/__tests__/fileWatcher.test.js` | new — unit tests for `processNewPhoto` |
| `backend/server.js` | add `sharp.concurrency(1)` + `sharp.cache({memory:100})` |
| `/opt/picpeak/app/backend/.env` (server) | add `UPLOAD_PROCESSOR_CONCURRENCY=2` |

---

## Task 1: Install p-limit

**Files:**
- Modify: `backend/package.json`

- [ ] **Step 1: Install the dependency**

```bash
cd backend
npm install p-limit@3
```

Expected output ends with: `added 1 package` (or similar, no errors).

- [ ] **Step 2: Verify it's CJS-compatible**

```bash
node -e "const pLimit = require('p-limit'); console.log(typeof pLimit);"
```

Expected: `function`

- [ ] **Step 3: Commit**

```bash
git add backend/package.json backend/package-lock.json
git commit -m "chore(deps): add p-limit@3 for file watcher concurrency control"
```

---

## Task 2: Add sharp global config to server.js

**Files:**
- Modify: `backend/server.js` (after line 13, after logger init)

- [ ] **Step 1: Add sharp config block**

In `backend/server.js`, add after the logger startup block (after line 13, before `const fs = require('fs')`):

```js
// Cap libvips concurrency and cache so large photo batches don't OOM.
// concurrency(1): one libvips thread per sharp operation (operations still
// run in parallel at the rate controlled by backgroundProcessor + p-limit).
// cache({memory:100}): libvips internal tile/decode cache capped at 100 MB.
const sharp = require('sharp');
sharp.concurrency(1);
sharp.cache({ memory: 100 });
```

- [ ] **Step 2: Verify server still starts**

```bash
cd backend
node -e "require('./server.js')" 2>&1 | head -5
```

Expected: no crash, sees startup log lines. Kill with Ctrl+C.

- [ ] **Step 3: Commit**

```bash
git add backend/server.js
git commit -m "fix(sharp): cap libvips concurrency and cache at startup"
```

---

## Task 3: Add p-limit to fileWatcher and export processNewPhoto

**Files:**
- Modify: `backend/src/services/fileWatcher.js`

- [ ] **Step 1: Write the failing test first**

Create `backend/src/services/__tests__/fileWatcher.test.js`:

```js
jest.mock('chokidar');
jest.mock('../../database/db');
jest.mock('../../utils/logger');
jest.mock('../imageProcessor');
jest.mock('../videoProcessor', () => ({
  isVideoMimeType: jest.fn().mockReturnValue(false),
}));
jest.mock('../downloadZipService', () => ({ invalidate: jest.fn() }));
jest.mock('../webhookService', () => ({ fire: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../utils/dbCompat', () => ({ formatBoolean: jest.fn((v) => v) }));
jest.mock('mime-types');

// Point STORAGE_PATH so path.relative(WATCH_PATH(), filePath) works deterministically
process.env.STORAGE_PATH = '/test-storage';

const chokidar = require('chokidar');
const { db } = require('../../database/db');
const { generateThumbnail } = require('../imageProcessor');
const mime = require('mime-types');

const mockWatcher = { on: jest.fn().mockReturnThis() };
chokidar.watch = jest.fn().mockReturnValue(mockWatcher);

const { processNewPhoto } = require('../fileWatcher');

// Helper — path inside WATCH_PATH (/test-storage/events/active)
const watchedPath = (slug, filename) =>
  `/test-storage/events/active/${slug}/${filename}`;

describe('processNewPhoto', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mime.lookup = jest.fn().mockReturnValue('image/jpeg');
  });

  it('skips files with temp_ prefix', async () => {
    await processNewPhoto(watchedPath('my-event', 'temp_123_456.jpg'));
    expect(db).not.toHaveBeenCalled();
  });

  it('skips non-image/video extensions', async () => {
    mime.lookup = jest.fn().mockReturnValue('text/plain');
    await processNewPhoto(watchedPath('my-event', 'readme.txt'));
    expect(db).not.toHaveBeenCalled();
  });

  it('skips when event not found in DB', async () => {
    const mockQuery = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue(null),
    };
    db.mockReturnValue(mockQuery);
    await processNewPhoto(watchedPath('missing-event', 'photo.jpg'));
    expect(generateThumbnail).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd backend
npx jest src/services/__tests__/fileWatcher.test.js -t "processNewPhoto" --no-coverage
```

Expected: FAIL — `processNewPhoto` is not exported from `fileWatcher.js`.

- [ ] **Step 3: Modify fileWatcher.js**

Replace the top of `backend/src/services/fileWatcher.js` (lines 1–15) with:

```js
const chokidar = require('chokidar');
const path = require('path');
const fs = require('fs').promises;
const sharp = require('sharp');
const pLimit = require('p-limit');
const { db } = require('../database/db');
const { formatBoolean } = require('../utils/dbCompat');
const { generateThumbnail, generateVideoPlaceholder } = require('./imageProcessor');
const logger = require('../utils/logger');
const { isVideoMimeType } = require('./videoProcessor');
const mime = require('mime-types');
const downloadZipService = require('./downloadZipService');

const getStoragePath = () => process.env.STORAGE_PATH || path.join(__dirname, '../../../storage');
const WATCH_PATH = () => path.join(getStoragePath(), 'events/active');

const processLimit = pLimit(2);
```

- [ ] **Step 4: Update startFileWatcher to use the limiter**

Replace the `watcher.on('add', ...)` block in `startFileWatcher` (currently lines 37–43):

```js
  watcher
    .on('add', (filePath) => {
      processLimit(() => processNewPhoto(filePath)).catch((error) => {
        logger.error('Error processing new photo:', error);
      });
    })
    .on('unlink', async (filePath) => {
      try {
        await removePhoto(filePath);
      } catch (error) {
        logger.error('Error removing photo:', error);
      }
    });
```

- [ ] **Step 5: Export processNewPhoto at the bottom of fileWatcher.js**

Replace the existing module.exports line:

```js
module.exports = { startFileWatcher, processNewPhoto };
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
cd backend
npx jest src/services/__tests__/fileWatcher.test.js --no-coverage
```

Expected: PASS (3 tests).

- [ ] **Step 7: Run full test suite to check for regressions**

```bash
cd backend
npm test -- --no-coverage 2>&1 | tail -20
```

Expected: no new failures.

- [ ] **Step 8: Commit**

```bash
git add backend/src/services/fileWatcher.js backend/src/services/__tests__/fileWatcher.test.js
git commit -m "fix(fileWatcher): limit concurrent processNewPhoto calls to 2 via p-limit"
```

---

## Task 4: Set UPLOAD_PROCESSOR_CONCURRENCY on the server

**Files:**
- Modify: `/opt/picpeak/app/backend/.env` (on production server via SSH)

- [ ] **Step 1: Add the env var**

```bash
ssh root@192.168.0.210 "grep -q UPLOAD_PROCESSOR_CONCURRENCY /opt/picpeak/app/backend/.env || echo 'UPLOAD_PROCESSOR_CONCURRENCY=2' >> /opt/picpeak/app/backend/.env"
```

Expected: no output (added) or no-op if already present.

- [ ] **Step 2: Verify**

```bash
ssh root@192.168.0.210 "grep UPLOAD_PROCESSOR_CONCURRENCY /opt/picpeak/app/backend/.env"
```

Expected: `UPLOAD_PROCESSOR_CONCURRENCY=2`

---

## Task 5: Deploy and verify

- [ ] **Step 1: Push branch and deploy**

```bash
git push origin fix/upload-processing-queue
ssh root@192.168.0.210 "cd /opt/picpeak/app && git fetch origin && git checkout fix/upload-processing-queue && cd backend && npm install && systemctl restart picpeak-backend"
```

- [ ] **Step 2: Verify service starts cleanly**

```bash
ssh root@192.168.0.210 "sleep 5 && systemctl status picpeak-backend --no-pager | grep -E 'Active|Memory'"
```

Expected: `Active: active (running)`, memory well below 1 GB at startup.

- [ ] **Step 3: Verify sharp config is active**

```bash
ssh root@192.168.0.210 "node -e \"const s=require('sharp'); console.log('concurrency:', s.concurrency(), 'cache:', JSON.stringify(s.cache()));\""
```

Expected: `concurrency: 1  cache: {"memory":100,...}`

- [ ] **Step 4: Verify background processor concurrency**

```bash
ssh root@192.168.0.210 "grep UPLOAD_PROCESSOR_CONCURRENCY /opt/picpeak/app/backend/.env && journalctl -u picpeak-backend --since '1 min ago' --no-pager | grep backgroundProcessor"
```

Expected: log line `backgroundProcessor: started 2 worker(s)`.

- [ ] **Step 5: Upload a test batch of 30+ photos via the admin UI**

Verify:
- HTTP response returns quickly (< 5s for 30 files)
- Service memory stays below 3 GB during processing
- Thumbnails appear in gallery within ~60s
- No crashes in `journalctl -u picpeak-backend -f`

- [ ] **Step 6: Commit final state**

```bash
git add -A
git status  # confirm nothing unexpected
git commit -m "fix(deploy): set UPLOAD_PROCESSOR_CONCURRENCY=2 on server"
```
