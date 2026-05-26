# Gallery Password Symmetric Encryption

**Date:** 2026-05-26  
**Status:** Approved  
**Scope:** Backend (Node.js/Express) + Frontend (React/TypeScript)

## Problem

Gallery passwords are stored exclusively as bcrypt hashes (one-way). When an admin resends
the creation email, the plaintext password is unavailable — the email processor falls back to
the sentinel `{{password_security_message}}`, which renders as "Não exibido por motivos de
segurança" in the email. This breaks the primary use case for resending the creation email.

## Goal

Enable automatic inclusion of the gallery password in resent creation emails without requiring
the admin to manually type it. The admin's resend email modal password field should disappear
for events that have the encrypted password available.

## Non-Goals

- Replacing bcrypt for authentication (bcrypt stays for access verification)
- Exposing decrypted passwords via any public or gallery-facing API route
- Admin UI to view/copy the current gallery password (out of scope)
- External key management (Vault, KMS) — self-hosted instance, .env is sufficient

## Approach

**AES-256-GCM symmetric encryption** using a master key stored in the server environment
(`.env`). The encrypted password and IV are stored alongside the existing bcrypt hash.
Key versioning is included to support future key rotation without breaking existing encrypted
passwords.

Node.js built-in `crypto` module — no new dependencies.

---

## Architecture

### Database Changes

Three new nullable columns added to the `events` table:

| Column | Type | Nullable | Description |
|---|---|---|---|
| `password_encrypted` | TEXT | yes | AES-256-GCM ciphertext + auth tag, base64-encoded |
| `password_iv` | TEXT | yes | 12-byte random nonce, base64-encoded |
| `password_key_version` | INTEGER | yes, default 1 | Key version used to encrypt |

Existing `password_hash` (bcrypt) column is **unchanged** — it continues to be used for
gallery access authentication. The new columns are complementary.

Events created before this migration have `NULL` in all three columns → existing behavior
preserved (sentinel fallback on resend).

### Environment Variables

```bash
# Required for encryption. Generate with: node -e "require('crypto').randomBytes(32).toString('hex')|console.log"
GALLERY_ENCRYPTION_KEY_V1=<64-char hex string>

# Future key rotation: add _V2, _V3, etc. System uses highest-numbered key present.
# GALLERY_ENCRYPTION_KEY_V2=<new 64-char hex string>
```

If no `GALLERY_ENCRYPTION_KEY_V*` variable is set, encryption is disabled gracefully:
- `isEncryptionAvailable()` returns `false`
- Resend email falls back to sentinel (current behavior)
- A warning is logged at startup

### New Utility: `backend/src/utils/passwordEncryption.js`

**Public API:**

```js
/**
 * Encrypt a plaintext password.
 * @throws if GALLERY_ENCRYPTION_KEY is not configured
 * @returns { encrypted: string, iv: string, keyVersion: number }
 */
function encrypt(plaintext)

/**
 * Decrypt a previously encrypted password.
 * @param {string} encrypted - base64 ciphertext (includes 16-byte auth tag)
 * @param {string} iv - base64 nonce
 * @param {number} [keyVersion=1] - which key version to use for decryption
 * @returns {string} plaintext
 * @throws on wrong key or tampered data (GCM auth tag mismatch)
 */
function decrypt(encrypted, iv, keyVersion)

/**
 * Returns true if at least one GALLERY_ENCRYPTION_KEY_V* env var is set.
 */
function isEncryptionAvailable()

/**
 * Utility: generate a new random 32-byte key as a 64-char hex string.
 * Used for documentation / initial setup.
 */
function generateKey()
```

**Internal details:**
- Algorithm: `aes-256-gcm`
- IV: `crypto.randomBytes(12)` generated fresh per `encrypt()` call (guarantees uniqueness)
- Auth tag: 16 bytes, appended to ciphertext buffer before base64 encoding
- Key derivation: raw hex string from env → `Buffer.from(hex, 'hex')` — no KDF needed since
  key is already 32 random bytes
- Key resolution: scan env for `GALLERY_ENCRYPTION_KEY_V1`, `_V2`, etc.; current version =
  highest-numbered present; `decrypt()` selects key by `keyVersion` parameter

### Backend Integration Points

Three locations in `backend/src/routes/adminEvents.js` where passwords are set:

1. **Create event** (`POST /admin/events`) — encrypt after generating/receiving plaintext,
   include encrypted fields in the `db('events').insert()` call
2. **Update event password** (`PUT /admin/events/:id`) — re-encrypt new plaintext when
   `password` is present in request body
3. **Reset password** (`POST /admin/events/:id/reset-password`) — re-encrypt newly generated
   or provided password

Pattern at each point:
```js
let encryptedFields = {};
if (isEncryptionAvailable()) {
  const { encrypted, iv, keyVersion } = encrypt(plaintextPassword);
  encryptedFields = {
    password_encrypted: encrypted,
    password_iv: iv,
    password_key_version: keyVersion,
  };
}
// include encryptedFields in the DB insert/update
```

**Resend email** (`POST /admin/events/:id/resend-email`) — decrypt automatically:
```js
let galleryPassword = '{{password_security_message}}'; // default fallback

if (event.password_encrypted && event.password_iv && isEncryptionAvailable()) {
  // New path: decrypt stored ciphertext
  galleryPassword = decrypt(event.password_encrypted, event.password_iv, event.password_key_version ?? 1);
} else if (req.body?.password) {
  // Legacy fallback: admin manually typed password for an old event
  galleryPassword = req.body.password;
}
```

### Security: Protecting Encrypted Fields

`adminEvents.js` already strips sensitive fields from event objects returned to the frontend
via destructuring (lines ~220–227). The three new columns must be added to that exclusion:

```js
const {
  host_name, host_email,
  customer_name, customer_email, customer_phone,
  password_hash: _ph,
  client_password_hash: _cph,
  password_encrypted: _pe,   // NEW — never sent to frontend
  password_iv: _piv,         // NEW
  password_key_version: _pkv, // NEW
  ...rest
} = event;
```

**Additional security invariants:**
- `password_encrypted` and `password_iv` are never included in any public gallery API response
- The `GET /admin/events/:id` response must include a boolean `has_encrypted_password` derived
  server-side from `!!event.password_encrypted` — this is what the frontend uses to
  conditionally hide the manual password field in the resend modal

### Frontend Changes

**`EventDetailsPage.tsx` — resend email modal:**

The modal currently shows a password input field when `event.require_password` is true. After
this change:
- If `event.has_encrypted_password === true`: field is hidden, no password input shown,
  submit proceeds automatically with no password in the request body (backend decrypts)
- If `event.has_encrypted_password === false` (old event): field remains visible with the
  existing hint text explaining it's for inclusion in the email only

**`events.service.ts`** — no changes needed; the service already sends `password` in the body
optionally.

**`types/index.ts`** — add `has_encrypted_password?: boolean` to the `Event` type.

---

## Migration

File: `backend/migrations/core/095_add_password_encryption.js` (verify actual next number
before creating)

```js
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

Also add the three columns to `initializeDatabase()` in `backend/src/database/db.js`
(`createTable('events')` block) so fresh PostgreSQL installs include them from day one.

---

## Tests

**Unit tests** — `backend/src/utils/__tests__/passwordEncryption.test.js`:
- `encrypt()` → `decrypt()` roundtrip returns original plaintext
- `decrypt()` with wrong key version throws
- `decrypt()` with tampered ciphertext throws (GCM auth tag fails)
- `isEncryptionAvailable()` returns `false` when no env var set
- `isEncryptionAvailable()` returns `true` when `GALLERY_ENCRYPTION_KEY_V1` set

**Manual integration test:**
1. Set `GALLERY_ENCRYPTION_KEY_V1` in `.env`
2. Create new event with password
3. Resend creation email → verify mailhog shows actual password (not sentinel)
4. Verify gallery access still works with that same password (bcrypt auth unchanged)

---

## CLAUDE.md Addition

Add to the `.env` section:
```
# Gallery password encryption (AES-256-GCM)
# Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
GALLERY_ENCRYPTION_KEY_V1=<64-char hex>
```

---

## Files Touched

| File | Change |
|---|---|
| `backend/migrations/core/095_add_password_encryption.js` | New migration |
| `backend/src/database/db.js` | Add 3 columns to `createTable('events')` |
| `backend/src/utils/passwordEncryption.js` | New utility |
| `backend/src/utils/__tests__/passwordEncryption.test.js` | New unit tests |
| `backend/src/routes/adminEvents.js` | Encrypt at 3 points, decrypt at resend |
| `frontend/src/types/index.ts` | Add `has_encrypted_password?: boolean` to `Event` |
| `frontend/src/pages/admin/EventDetailsPage.tsx` | Hide password field when `has_encrypted_password` |
| `CLAUDE.md` | Document `GALLERY_ENCRYPTION_KEY_V*` env var |
