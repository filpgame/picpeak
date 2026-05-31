# Gallery Password AES-256-GCM Encryption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store gallery passwords as AES-256-GCM ciphertext alongside the existing bcrypt hash, enabling automatic password inclusion in resent creation emails without admin manual input.

**Architecture:** A new utility (`passwordEncryption.js`) wraps Node's built-in `crypto` with `encrypt`/`decrypt`/`isEncryptionAvailable`. A DB migration adds `password_encrypted`, `password_iv`, and `password_key_version` columns. Three write-paths in `adminEvents.js` encrypt on create/update/reset; the resend-email route decrypts automatically. The frontend hides the manual password field when `has_encrypted_password` is true.

**Tech Stack:** Node.js `crypto` (built-in, AES-256-GCM), Knex migrations, React/TypeScript frontend, bash setup scripts.

---

## File Map

| File | Action | Purpose |
|---|---|---|
| `backend/migrations/core/109_add_password_encryption.js` | Create | DB migration: 3 new nullable columns on `events` |
| `backend/src/database/db.js` | Modify (lines 60–101) | Add columns to `createTable('events')` for fresh installs |
| `backend/src/utils/passwordEncryption.js` | Create | `encrypt`, `decrypt`, `isEncryptionAvailable`, `generateKey` |
| `backend/src/utils/__tests__/passwordEncryption.test.js` | Create | Unit tests for the encryption utility |
| `backend/src/routes/adminEvents.js` | Modify (4 locations) | Encrypt at create/update/reset; decrypt at resend; strip fields from responses |
| `frontend/src/types/index.ts` | Modify (line 21) | Add `has_encrypted_password?: boolean` to `Event` interface |
| `frontend/src/pages/admin/EventDetailsPage.tsx` | Modify (lines 2511–2526) | Hide password field when `has_encrypted_password` is true |
| `scripts/install.sh` | Modify (lines 56–65) | Generate `GALLERY_ENCRYPTION_KEY_V1` on fresh Docker install |
| `scripts/picpeak-setup.sh` | Modify (4 locations) | Add helper fn + inject key in fresh+update paths |

---

## Task 1: DB Migration + `initializeDatabase` Update

**Files:**
- Create: `backend/migrations/core/109_add_password_encryption.js`
- Modify: `backend/src/database/db.js` (lines 98–101)

- [ ] **Step 1.1: Create the migration file**

```js
// backend/migrations/core/109_add_password_encryption.js
exports.up = async (knex) => {
  await knex.schema.alterTable('events', (table) => {
    table.text('password_encrypted').nullable();
    table.text('password_iv').nullable();
    table.integer('password_key_version').nullable().defaultTo(1);
  });
};

exports.down = async (knex) => {
  await knex.schema.alterTable('events', (table) => {
    table.dropColumn('password_encrypted');
    table.dropColumn('password_iv');
    table.dropColumn('password_key_version');
  });
};
```

- [ ] **Step 1.2: Add columns to `initializeDatabase()` in `db.js`**

In `backend/src/database/db.js`, locate the `createTable('events', ...)` block. After line 100 (`table.string('language', 5).defaultTo(null);`), add:

```js
      table.string('language', 5).defaultTo(null);
      table.text('password_encrypted').nullable();
      table.text('password_iv').nullable();
      table.integer('password_key_version').nullable().defaultTo(1);
    });
```

The three new lines go before the closing `});` that ends the `createTable('events')` callback.

- [ ] **Step 1.3: Run migration locally to verify**

```bash
cd backend
npm run migrate
```

Expected output: migration `109_add_password_encryption` listed as run, no errors.

- [ ] **Step 1.4: Verify columns exist**

```bash
cd backend
node -e "const { db } = require('./src/database/db'); db('events').columnInfo().then(c => { console.log('password_encrypted' in c, 'password_iv' in c, 'password_key_version' in c); process.exit(); });"
```

Expected: `true true true`

- [ ] **Step 1.5: Commit**

```bash
git add backend/migrations/core/109_add_password_encryption.js backend/src/database/db.js
git commit -m "feat(encryption): add password_encrypted/iv/key_version columns to events"
```

---

## Task 2: `passwordEncryption.js` Utility + Unit Tests (TDD)

**Files:**
- Create: `backend/src/utils/passwordEncryption.js`
- Create: `backend/src/utils/__tests__/passwordEncryption.test.js`

- [ ] **Step 2.1: Write the failing tests first**

```js
// backend/src/utils/__tests__/passwordEncryption.test.js
const {
  encrypt,
  decrypt,
  isEncryptionAvailable,
  generateKey,
} = require('../passwordEncryption');

describe('passwordEncryption', () => {
  const testKey = require('crypto').randomBytes(32).toString('hex');

  beforeEach(() => {
    delete process.env.GALLERY_ENCRYPTION_KEY_V1;
    delete process.env.GALLERY_ENCRYPTION_KEY_V2;
  });

  describe('isEncryptionAvailable', () => {
    it('returns false when no key env vars are set', () => {
      expect(isEncryptionAvailable()).toBe(false);
    });

    it('returns true when GALLERY_ENCRYPTION_KEY_V1 is set', () => {
      process.env.GALLERY_ENCRYPTION_KEY_V1 = testKey;
      expect(isEncryptionAvailable()).toBe(true);
    });
  });

  describe('encrypt / decrypt roundtrip', () => {
    beforeEach(() => {
      process.env.GALLERY_ENCRYPTION_KEY_V1 = testKey;
    });

    it('returns an object with encrypted, iv, and keyVersion', () => {
      const result = encrypt('mypassword');
      expect(result).toHaveProperty('encrypted');
      expect(result).toHaveProperty('iv');
      expect(result).toHaveProperty('keyVersion', 1);
    });

    it('decrypts back to original plaintext', () => {
      const { encrypted, iv, keyVersion } = encrypt('hunter2');
      expect(decrypt(encrypted, iv, keyVersion)).toBe('hunter2');
    });

    it('produces different ciphertext for identical plaintexts (unique IV)', () => {
      const a = encrypt('same');
      const b = encrypt('same');
      expect(a.encrypted).not.toBe(b.encrypted);
      expect(a.iv).not.toBe(b.iv);
    });

    it('uses highest-numbered key version present', () => {
      process.env.GALLERY_ENCRYPTION_KEY_V2 = require('crypto').randomBytes(32).toString('hex');
      const { keyVersion } = encrypt('test');
      expect(keyVersion).toBe(2);
      delete process.env.GALLERY_ENCRYPTION_KEY_V2;
    });
  });

  describe('decrypt error cases', () => {
    beforeEach(() => {
      process.env.GALLERY_ENCRYPTION_KEY_V1 = testKey;
    });

    it('throws when key version is not configured', () => {
      const { encrypted, iv } = encrypt('hello');
      delete process.env.GALLERY_ENCRYPTION_KEY_V1;
      expect(() => decrypt(encrypted, iv, 1)).toThrow();
    });

    it('throws on tampered ciphertext (auth tag mismatch)', () => {
      const { encrypted, iv, keyVersion } = encrypt('hello');
      // flip last character of base64 to corrupt auth tag
      const tampered = encrypted.slice(0, -1) + (encrypted.slice(-1) === 'A' ? 'B' : 'A');
      expect(() => decrypt(tampered, iv, keyVersion)).toThrow();
    });
  });

  describe('generateKey', () => {
    it('returns a 64-character hex string', () => {
      const key = generateKey();
      expect(key).toMatch(/^[0-9a-f]{64}$/);
    });

    it('returns different values on each call', () => {
      expect(generateKey()).not.toBe(generateKey());
    });
  });

  describe('encrypt throws when no key configured', () => {
    it('throws if GALLERY_ENCRYPTION_KEY_V* not set', () => {
      expect(() => encrypt('test')).toThrow('GALLERY_ENCRYPTION_KEY');
    });
  });
});
```

- [ ] **Step 2.2: Run tests to confirm they all fail**

```bash
cd backend
npx jest src/utils/__tests__/passwordEncryption.test.js --no-coverage 2>&1 | tail -20
```

Expected: `Cannot find module '../passwordEncryption'`

- [ ] **Step 2.3: Implement `passwordEncryption.js`**

```js
// backend/src/utils/passwordEncryption.js
'use strict';

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

function _resolveCurrentVersion() {
  let max = 0;
  for (const [key, val] of Object.entries(process.env)) {
    const m = key.match(/^GALLERY_ENCRYPTION_KEY_V(\d+)$/);
    if (m && val) {
      const v = parseInt(m[1], 10);
      if (v > max) max = v;
    }
  }
  return max;
}

function _getKey(version) {
  const hex = process.env[`GALLERY_ENCRYPTION_KEY_V${version}`];
  if (!hex) {
    throw new Error(`GALLERY_ENCRYPTION_KEY_V${version} is not set`);
  }
  if (hex.length !== 64) {
    throw new Error(`GALLERY_ENCRYPTION_KEY_V${version} must be 64 hex characters (32 bytes)`);
  }
  return Buffer.from(hex, 'hex');
}

function isEncryptionAvailable() {
  return _resolveCurrentVersion() > 0;
}

function encrypt(plaintext) {
  const keyVersion = _resolveCurrentVersion();
  if (keyVersion === 0) {
    throw new Error('GALLERY_ENCRYPTION_KEY_V* env var not configured');
  }
  const key = _getKey(keyVersion);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Store ciphertext + authTag together so decrypt can verify integrity
  const payload = Buffer.concat([ciphertext, authTag]);
  return {
    encrypted: payload.toString('base64'),
    iv: iv.toString('base64'),
    keyVersion,
  };
}

function decrypt(encrypted, iv, keyVersion = 1) {
  const key = _getKey(keyVersion);
  const payload = Buffer.from(encrypted, 'base64');
  const ivBuf = Buffer.from(iv, 'base64');
  // Last 16 bytes are the auth tag
  const authTag = payload.slice(payload.length - AUTH_TAG_BYTES);
  const ciphertext = payload.slice(0, payload.length - AUTH_TAG_BYTES);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, ivBuf);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

function generateKey() {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = { encrypt, decrypt, isEncryptionAvailable, generateKey };
```

- [ ] **Step 2.4: Run tests to confirm they all pass**

```bash
cd backend
npx jest src/utils/__tests__/passwordEncryption.test.js --no-coverage
```

Expected: all tests pass, no failures.

- [ ] **Step 2.5: Commit**

```bash
git add backend/src/utils/passwordEncryption.js backend/src/utils/__tests__/passwordEncryption.test.js
git commit -m "feat(encryption): add AES-256-GCM passwordEncryption utility with tests"
```

---

## Task 3: Strip Encrypted Fields from API Response + Add `has_encrypted_password`

This task tightens the security boundary before any encrypted data is written to the DB.

**Files:**
- Modify: `backend/src/routes/adminEvents.js` (lines 218–234)

- [ ] **Step 3.1: Update the `sanitizeEvent` destructuring**

Find the block starting at line 218:

```js
  const {
    host_name,
    host_email,
    customer_name,
    customer_email,
    customer_phone,
    password_hash: _ph,
    client_password_hash: _cph,
    ...rest
  } = event;

  return {
    ...rest,
    customer_name: customer_name ?? host_name ?? null,
    customer_email: customer_email ?? host_email ?? null,
    customer_phone: customer_phone ?? null
  };
```

Replace it with:

```js
  const {
    host_name,
    host_email,
    customer_name,
    customer_email,
    customer_phone,
    password_hash: _ph,
    client_password_hash: _cph,
    password_encrypted: _pe,
    password_iv: _piv,
    password_key_version: _pkv,
    ...rest
  } = event;

  return {
    ...rest,
    customer_name: customer_name ?? host_name ?? null,
    customer_email: customer_email ?? host_email ?? null,
    customer_phone: customer_phone ?? null,
    has_encrypted_password: !!event.password_encrypted,
  };
```

- [ ] **Step 3.2: Verify the change with a quick manual check**

Start the backend (`npm run dev` in `backend/`) and in another terminal:

```bash
curl -s -X POST http://localhost:3001/api/admin/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@local.dev","password":"Admin123!"}' | grep -o '"token":"[^"]*"'
```

Then fetch any existing event and confirm `password_encrypted`, `password_iv`, `password_key_version` are absent from the response, and `has_encrypted_password` is present (should be `false` for existing events).

- [ ] **Step 3.3: Commit**

```bash
git add backend/src/routes/adminEvents.js
git commit -m "feat(encryption): strip encrypted fields from API responses, expose has_encrypted_password"
```

---

## Task 4: Encrypt Password at Event Creation

**Files:**
- Modify: `backend/src/routes/adminEvents.js` (lines 574–577, 639–649)

- [ ] **Step 4.1: Add the import at the top of `adminEvents.js`**

Find the existing `require` block at the top of the file. After the `bcrypt` and `crypto` requires (around lines 9–10), add:

```js
const { encrypt: encryptPassword, isEncryptionAvailable } = require('../utils/passwordEncryption');
```

- [ ] **Step 4.2: Encrypt after hashing in the create route**

Find the block (around line 574):

```js
    // Hash password with configurable rounds (random placeholder when not required)
    const password_hash = requirePassword
      ? await bcrypt.hash(password, getBcryptRounds())
      : await bcrypt.hash(crypto.randomBytes(32).toString('hex'), getBcryptRounds());
```

Replace with:

```js
    // Hash password with configurable rounds (random placeholder when not required)
    const plaintextForEncryption = requirePassword ? password : null;
    const password_hash = requirePassword
      ? await bcrypt.hash(password, getBcryptRounds())
      : await bcrypt.hash(crypto.randomBytes(32).toString('hex'), getBcryptRounds());

    let encryptedPasswordFields = {};
    if (requirePassword && plaintextForEncryption && isEncryptionAvailable()) {
      const { encrypted, iv, keyVersion } = encryptPassword(plaintextForEncryption);
      encryptedPasswordFields = {
        password_encrypted: encrypted,
        password_iv: iv,
        password_key_version: keyVersion,
      };
    }
```

- [ ] **Step 4.3: Include encrypted fields in the DB insert**

Find the `db('events').insert({...})` block (around line 639). The insert object ends with several spread fields. Add the encrypted fields spread at the end, just before the closing `}`/`)`,:

```js
    const insertResult = await db('events').insert({
      // ... all existing fields ...
      password_hash,
      // ... more existing fields ...
      ...encryptedPasswordFields,
    });
```

Specifically, find the line `password_hash,` in the insert object (around line 649), and after it add `...encryptedPasswordFields,`. The exact diff is one line added after `password_hash,`:

Before:
```js
      password_hash,
      welcome_message,
```

After:
```js
      password_hash,
      ...encryptedPasswordFields,
      welcome_message,
```

- [ ] **Step 4.4: Set `GALLERY_ENCRYPTION_KEY_V1` in local `.env` and test**

Open `backend/.env` (or `.env` at project root if Docker). Add:

```bash
GALLERY_ENCRYPTION_KEY_V1=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
```

Or manually run `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` and paste the result.

Restart backend, create a test event with a password, then verify the DB row:

```bash
cd backend
node -e "
const { db } = require('./src/database/db');
db('events').orderBy('id','desc').first(['id','password_encrypted','password_iv','password_key_version'])
  .then(r => { console.log(r); process.exit(); });
"
```

Expected: `password_encrypted` and `password_iv` are non-null strings.

- [ ] **Step 4.5: Commit**

```bash
git add backend/src/routes/adminEvents.js
git commit -m "feat(encryption): encrypt gallery password at event creation"
```

---

## Task 5: Encrypt Password at Update + Reset

**Files:**
- Modify: `backend/src/routes/adminEvents.js` (lines 1363–1367, 1582–1589)

- [ ] **Step 5.1: Encrypt at password update (edit event route)**

Find the block around line 1363:

```js
    if (newPasswordPlain) {
      updates.password_hash = await bcrypt.hash(newPasswordPlain, getBcryptRounds());
    } else if (hasRequirePasswordUpdate && requirePasswordUpdate === false && currentRequirePassword) {
      updates.password_hash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), getBcryptRounds());
    }
```

Replace with:

```js
    if (newPasswordPlain) {
      updates.password_hash = await bcrypt.hash(newPasswordPlain, getBcryptRounds());
      if (isEncryptionAvailable()) {
        const { encrypted, iv, keyVersion } = encryptPassword(newPasswordPlain);
        updates.password_encrypted = encrypted;
        updates.password_iv = iv;
        updates.password_key_version = keyVersion;
      }
    } else if (hasRequirePasswordUpdate && requirePasswordUpdate === false && currentRequirePassword) {
      updates.password_hash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), getBcryptRounds());
      updates.password_encrypted = null;
      updates.password_iv = null;
      updates.password_key_version = null;
    }
```

- [ ] **Step 5.2: Encrypt at password reset route**

Find the block around line 1582:

```js
    const passwordHash = await bcrypt.hash(newPassword, getBcryptRounds());

    // Update event with new password
    await db('events')
      .where('id', id)
      .update({
        password_hash: passwordHash
      });
```

Replace with:

```js
    const passwordHash = await bcrypt.hash(newPassword, getBcryptRounds());

    const resetEncryptedFields = {};
    if (isEncryptionAvailable()) {
      const { encrypted, iv, keyVersion } = encryptPassword(newPassword);
      resetEncryptedFields.password_encrypted = encrypted;
      resetEncryptedFields.password_iv = iv;
      resetEncryptedFields.password_key_version = keyVersion;
    }

    // Update event with new password
    await db('events')
      .where('id', id)
      .update({
        password_hash: passwordHash,
        ...resetEncryptedFields,
      });
```

- [ ] **Step 5.3: Manual smoke test — update and reset**

With the dev server running:
1. Edit an existing event, change its password → verify DB row shows updated `password_encrypted`
2. Use the password reset button → verify DB row shows new `password_encrypted`

- [ ] **Step 5.4: Commit**

```bash
git add backend/src/routes/adminEvents.js
git commit -m "feat(encryption): encrypt gallery password at update and reset"
```

---

## Task 6: Decrypt at Resend Email Route

**Files:**
- Modify: `backend/src/routes/adminEvents.js` (lines 1653–1663)

- [ ] **Step 6.1: Add decrypt import**

The file already has `const { encrypt: encryptPassword, isEncryptionAvailable } = require('../utils/passwordEncryption');` from Task 4. Update that import line to also destructure `decrypt`:

```js
const { encrypt: encryptPassword, decrypt: decryptPassword, isEncryptionAvailable } = require('../utils/passwordEncryption');
```

- [ ] **Step 6.2: Replace the sentinel logic in the resend route**

Find the block around line 1653:

```js
    // For resending creation email, we need the actual password
    // First, try to get it from the request body if provided
    // Use optional chaining to handle cases where req.body might be undefined
    let galleryPassword = req.body?.password;
    
    // If no password provided, we can't decrypt the existing one
    // So we'll show a security message
    if (!galleryPassword) {
      // We'll let the email processor determine the language for the security message
      galleryPassword = '{{password_security_message}}';
    }
```

Replace with:

```js
    // Determine gallery password for the email:
    // 1. Auto-decrypt if the event has AES-GCM ciphertext stored
    // 2. Fall back to manually-provided password from request body (legacy events)
    // 3. Fall back to sentinel (pre-encryption events with no password in body)
    let galleryPassword = '{{password_security_message}}';

    if (event.password_encrypted && event.password_iv && isEncryptionAvailable()) {
      galleryPassword = decryptPassword(
        event.password_encrypted,
        event.password_iv,
        event.password_key_version ?? 1
      );
    } else if (req.body?.password) {
      galleryPassword = req.body.password;
    }
```

- [ ] **Step 6.3: Test resend email end-to-end**

With Docker Compose running (mailhog available at `http://localhost:8025`):
1. Create a new event with a known password (e.g., `Test1234`)
2. Click "Resend creation email" in the admin UI — no password field should appear (Task 8 handles this, but the API should work correctly from this task already)
3. Check mailhog: email should show the actual password `Test1234`, not the sentinel

Test via curl if the UI isn't wired yet:

```bash
TOKEN="<your-admin-token>"
EVENT_ID=<id of event created in step 1>
curl -s -X POST http://localhost:3001/api/admin/events/${EVENT_ID}/resend-email \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'
```

Check mailhog for the email. Expected: password shown as `Test1234`.

- [ ] **Step 6.4: Commit**

```bash
git add backend/src/routes/adminEvents.js
git commit -m "feat(encryption): auto-decrypt password in resend creation email route"
```

---

## Task 7: Frontend — Hide Password Field When Encrypted

**Files:**
- Modify: `frontend/src/types/index.ts` (after line 21)
- Modify: `frontend/src/pages/admin/EventDetailsPage.tsx` (line 2511 area)

- [ ] **Step 7.1: Add `has_encrypted_password` to the `Event` type**

In `frontend/src/types/index.ts`, find line 21:

```ts
  require_password?: boolean;
```

Add the new field directly after it:

```ts
  require_password?: boolean;
  has_encrypted_password?: boolean;
```

- [ ] **Step 7.2: Update the resend modal condition**

In `frontend/src/pages/admin/EventDetailsPage.tsx`, find the block around line 2511:

```tsx
            {event.require_password && (
              <div className="mb-4">
                <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                  {t('events.resendEmailPasswordLabel', 'Gallery password (optional)')}
                </label>
                <input
                  type="text"
                  value={resendEmailPassword}
                  onChange={(e) => setResendEmailPassword(e.target.value)}
                  placeholder={t('events.resendEmailPasswordPlaceholder', 'Enter password to include in email')}
                  className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
                <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                  {t('events.resendEmailPasswordHint', 'If left blank, the email will say the password is not shown for security reasons.')}
                </p>
              </div>
            )}
```

Replace with:

```tsx
            {event.require_password && !event.has_encrypted_password && (
              <div className="mb-4">
                <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                  {t('events.resendEmailPasswordLabel', 'Gallery password (optional)')}
                </label>
                <input
                  type="text"
                  value={resendEmailPassword}
                  onChange={(e) => setResendEmailPassword(e.target.value)}
                  placeholder={t('events.resendEmailPasswordPlaceholder', 'Enter password to include in email')}
                  className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
                <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                  {t('events.resendEmailPasswordHint', 'If left blank, the email will say the password is not shown for security reasons.')}
                </p>
              </div>
            )}
```

The only change is `event.require_password && !event.has_encrypted_password`.

- [ ] **Step 7.3: Visual check in browser**

With dev server running (`npm run dev` in `frontend/`):
1. Open the detail page for an event created *after* Task 4 — the resend email modal should show **no** password field.
2. Open the detail page for an event created *before* Task 4 (old event, no `password_encrypted`) — the modal should still show the password field.

- [ ] **Step 7.4: Commit**

```bash
git add frontend/src/types/index.ts frontend/src/pages/admin/EventDetailsPage.tsx
git commit -m "feat(encryption): hide manual password field in resend modal when encrypted"
```

---

## Task 8: Setup Scripts — Auto-Generate Encryption Key

**Files:**
- Modify: `scripts/install.sh` (lines 56–65)
- Modify: `scripts/picpeak-setup.sh` (4 locations)

- [ ] **Step 8.1: Add helper function to `picpeak-setup.sh`**

Find the `generate_jwt_secret()` function (around line 182):

```bash
generate_jwt_secret() {
    openssl rand -base64 64 | tr -d "\n"
}
```

Add immediately after it:

```bash
generate_gallery_encryption_key() {
    openssl rand -hex 32
}
```

- [ ] **Step 8.2: Inject key in fresh Docker install**

In `setup_docker_installation()`, find the secrets generation block (around line 452):

```bash
    # Generate secrets
    local jwt_secret=$(generate_jwt_secret)
    local db_password=$(generate_password)
    local redis_password=$(generate_password)
```

Replace with:

```bash
    # Generate secrets
    local jwt_secret=$(generate_jwt_secret)
    local db_password=$(generate_password)
    local redis_password=$(generate_password)
    local gallery_key=$(generate_gallery_encryption_key)
```

Then find the `.env` heredoc (the `cat > "$app_dir/.env" <<EOF` block). After the `JWT_SECRET=$jwt_secret` line, add:

```bash
# Gallery password encryption (AES-256-GCM)
# Rotate: add GALLERY_ENCRYPTION_KEY_V2 with a new key; system uses highest version.
GALLERY_ENCRYPTION_KEY_V1=$gallery_key
```

- [ ] **Step 8.3: Inject key in fresh Native install**

In `setup_native_installation()`, find the secrets generation block (around line 817):

```bash
    # Generate secrets
    local jwt_secret=$(generate_jwt_secret)
```

Replace with:

```bash
    # Generate secrets
    local jwt_secret=$(generate_jwt_secret)
    local gallery_key=$(generate_gallery_encryption_key)
```

Then in the native `.env` heredoc, after `JWT_SECRET=$jwt_secret`, add:

```bash
# Gallery password encryption (AES-256-GCM)
GALLERY_ENCRYPTION_KEY_V1=$gallery_key
```

- [ ] **Step 8.4: Inject key in Docker update**

In `update_docker_installation()`, after `cp .env .env.backup-$(date +%Y%m%d-%H%M%S)` and before `git pull`, add:

```bash
    # Inject gallery encryption key if this .env predates the feature
    if ! grep -q '^GALLERY_ENCRYPTION_KEY_V1=' .env; then
        local gallery_key
        gallery_key=$(generate_gallery_encryption_key)
        echo "" >> .env
        echo "# Gallery password encryption (AES-256-GCM)" >> .env
        echo "GALLERY_ENCRYPTION_KEY_V1=$gallery_key" >> .env
        log_success "Generated GALLERY_ENCRYPTION_KEY_V1 (existing events use sentinel fallback)"
    fi
```

- [ ] **Step 8.5: Inject key in Native update**

In `update_native_installation()`, find the append-if-missing block for `SERVE_FRONTEND` (around line 1300). Add after the `FRONTEND_DIR` block:

```bash
    if ! grep -q '^GALLERY_ENCRYPTION_KEY_V1=' "$NATIVE_APP_DIR/app/backend/.env"; then
        local gallery_key
        gallery_key=$(generate_gallery_encryption_key)
        echo "" >> "$NATIVE_APP_DIR/app/backend/.env"
        echo "# Gallery password encryption (AES-256-GCM)" >> "$NATIVE_APP_DIR/app/backend/.env"
        echo "GALLERY_ENCRYPTION_KEY_V1=$gallery_key" >> "$NATIVE_APP_DIR/app/backend/.env"
        log_success "Generated GALLERY_ENCRYPTION_KEY_V1 (existing events use sentinel fallback)"
    fi
```

- [ ] **Step 8.6: Update `scripts/install.sh`**

In `scripts/install.sh`, find the secrets block (lines 57–65):

```bash
# Generate secure passwords
echo "Generating secure passwords..."
JWT_SECRET=$(openssl rand -base64 32)
DB_PASSWORD=$(openssl rand -base64 32)
UMAMI_HASH_SALT=$(openssl rand -base64 32)

# Update .env file with generated values
sed -i "s/JWT_SECRET=.*/JWT_SECRET=$JWT_SECRET/" .env
sed -i "s/DB_PASSWORD=.*/DB_PASSWORD=$DB_PASSWORD/" .env
sed -i "s/UMAMI_HASH_SALT=.*/UMAMI_HASH_SALT=$UMAMI_HASH_SALT/" .env
```

Replace with:

```bash
# Generate secure passwords
echo "Generating secure passwords..."
JWT_SECRET=$(openssl rand -base64 32)
DB_PASSWORD=$(openssl rand -base64 32)
UMAMI_HASH_SALT=$(openssl rand -base64 32)
GALLERY_ENCRYPTION_KEY_V1=$(openssl rand -hex 32)

# Update .env file with generated values
sed -i "s/JWT_SECRET=.*/JWT_SECRET=$JWT_SECRET/" .env
sed -i "s/DB_PASSWORD=.*/DB_PASSWORD=$DB_PASSWORD/" .env
sed -i "s/UMAMI_HASH_SALT=.*/UMAMI_HASH_SALT=$UMAMI_HASH_SALT/" .env
if grep -q 'GALLERY_ENCRYPTION_KEY_V1' .env; then
    sed -i "s/GALLERY_ENCRYPTION_KEY_V1=.*/GALLERY_ENCRYPTION_KEY_V1=$GALLERY_ENCRYPTION_KEY_V1/" .env
else
    echo "GALLERY_ENCRYPTION_KEY_V1=$GALLERY_ENCRYPTION_KEY_V1" >> .env
fi
```

- [ ] **Step 8.7: Verify scripts have no bash syntax errors**

```bash
bash -n scripts/picpeak-setup.sh && echo "OK"
bash -n scripts/install.sh && echo "OK"
```

Expected: both print `OK` with no errors.

- [ ] **Step 8.8: Commit**

```bash
git add scripts/install.sh scripts/picpeak-setup.sh
git commit -m "feat(encryption): auto-generate GALLERY_ENCRYPTION_KEY_V1 in setup scripts"
```

---

## Task 9: CLAUDE.md Documentation Update

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 9.1: Add env var documentation**

Find the `.env` or environment section in `CLAUDE.md`. Add:

```markdown
### Gallery Password Encryption

```bash
# Gallery password encryption (AES-256-GCM). Auto-generated by setup scripts.
# To rotate: add GALLERY_ENCRYPTION_KEY_V2=<new key> — system encrypts new passwords
# with V2 while still decrypting V1 data.
# Generate manually: openssl rand -hex 32
GALLERY_ENCRYPTION_KEY_V1=<64-char hex>
```

If absent, encryption is disabled (resend emails fall back to the "not shown" sentinel).
```

- [ ] **Step 9.2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document GALLERY_ENCRYPTION_KEY_V1 env var"
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Task |
|---|---|
| 3 new columns on `events` | Task 1 |
| `initializeDatabase()` update for fresh PG installs | Task 1 |
| `passwordEncryption.js` utility (encrypt/decrypt/isEncryptionAvailable/generateKey) | Task 2 |
| Unit tests (roundtrip, wrong key, tampered ciphertext, isAvailable, generateKey) | Task 2 |
| Strip encrypted fields from API responses | Task 3 |
| `has_encrypted_password` in `GET /admin/events/:id` | Task 3 |
| Encrypt at create event | Task 4 |
| Encrypt at update event password | Task 5 |
| Encrypt at reset password | Task 5 |
| Decrypt at resend email (auto) | Task 6 |
| Legacy fallback: req.body.password for old events | Task 6 |
| Sentinel fallback when no encrypted data | Task 6 |
| `has_encrypted_password?: boolean` in `Event` TS type | Task 7 |
| Frontend: hide password field when `has_encrypted_password` | Task 7 |
| `generate_gallery_encryption_key()` helper in setup script | Task 8 |
| Fresh Docker install generates key | Task 8 |
| Fresh native install generates key | Task 8 |
| Update Docker install appends key if absent | Task 8 |
| Update native install appends key if absent | Task 8 |
| `install.sh` generates key | Task 8 |
| CLAUDE.md env var documentation | Task 9 |

All spec requirements covered. ✅
