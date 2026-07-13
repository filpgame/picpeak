'use strict';

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

function resolveCurrentVersion() {
  let current = 0;
  for (const [name, value] of Object.entries(process.env)) {
    const match = name.match(/^GALLERY_ENCRYPTION_KEY_V(\d+)$/);
    if (match && value) current = Math.max(current, Number.parseInt(match[1], 10));
  }
  return current;
}

function getKey(version) {
  const value = process.env[`GALLERY_ENCRYPTION_KEY_V${version}`];
  if (!value) throw new Error(`GALLERY_ENCRYPTION_KEY_V${version} is not set`);
  if (!/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`GALLERY_ENCRYPTION_KEY_V${version} must be exactly 64 hex characters (32 bytes)`);
  }
  return Buffer.from(value, 'hex');
}

function isEncryptionAvailable() {
  return resolveCurrentVersion() > 0;
}

function encrypt(plaintext) {
  const keyVersion = resolveCurrentVersion();
  if (keyVersion === 0) {
    throw new Error('GALLERY_ENCRYPTION_KEY_V* env var not configured');
  }
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(keyVersion), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const payload = Buffer.concat([ciphertext, cipher.getAuthTag()]);
  return {
    encrypted: payload.toString('base64'),
    iv: iv.toString('base64'),
    keyVersion,
  };
}

function decrypt(encrypted, iv, keyVersion = 1) {
  const payload = Buffer.from(encrypted, 'base64');
  const ciphertext = payload.slice(0, payload.length - AUTH_TAG_BYTES);
  const authTag = payload.slice(payload.length - AUTH_TAG_BYTES);
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    getKey(keyVersion),
    Buffer.from(iv, 'base64'),
  );
  decipher.setAuthTag(authTag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString('utf8');
}

function generateKey() {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = { encrypt, decrypt, isEncryptionAvailable, generateKey };