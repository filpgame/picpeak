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
