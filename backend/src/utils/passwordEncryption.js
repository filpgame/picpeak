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
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`GALLERY_ENCRYPTION_KEY_V${version} must be exactly 64 hex characters (32 bytes)`);
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
