const crypto = require('crypto');
const {
  encrypt,
  decrypt,
  isEncryptionAvailable,
  generateKey,
} = require('../passwordEncryption');

describe('passwordEncryption', () => {
  const keyV1 = crypto.randomBytes(32).toString('hex');
  const keyV2 = crypto.randomBytes(32).toString('hex');

  beforeEach(() => {
    delete process.env.GALLERY_ENCRYPTION_KEY_V1;
    delete process.env.GALLERY_ENCRYPTION_KEY_V2;
  });

  afterAll(() => {
    delete process.env.GALLERY_ENCRYPTION_KEY_V1;
    delete process.env.GALLERY_ENCRYPTION_KEY_V2;
  });

  it('reports whether any versioned key is configured', () => {
    expect(isEncryptionAvailable()).toBe(false);
    process.env.GALLERY_ENCRYPTION_KEY_V2 = keyV2;
    expect(isEncryptionAvailable()).toBe(true);
  });

  it('round-trips plaintext with the highest configured key version', () => {
    process.env.GALLERY_ENCRYPTION_KEY_V1 = keyV1;
    process.env.GALLERY_ENCRYPTION_KEY_V2 = keyV2;

    const value = encrypt('Secret123!');

    expect(value.keyVersion).toBe(2);
    expect(decrypt(value.encrypted, value.iv, value.keyVersion)).toBe('Secret123!');
  });

  it('uses a unique IV for repeated plaintext', () => {
    process.env.GALLERY_ENCRYPTION_KEY_V1 = keyV1;

    const first = encrypt('same');
    const second = encrypt('same');

    expect(first.iv).not.toBe(second.iv);
    expect(first.encrypted).not.toBe(second.encrypted);
  });

  it('rejects missing and malformed keys deterministically', () => {
    expect(() => encrypt('secret')).toThrow('GALLERY_ENCRYPTION_KEY');
    process.env.GALLERY_ENCRYPTION_KEY_V1 = 'x'.repeat(64);
    expect(() => encrypt('secret')).toThrow('64 hex characters');
  });

  it('rejects tampered ciphertext', () => {
    process.env.GALLERY_ENCRYPTION_KEY_V1 = keyV1;
    const value = encrypt('secret');
    const bytes = Buffer.from(value.encrypted, 'base64');
    bytes[0] ^= 1;

    expect(() => decrypt(bytes.toString('base64'), value.iv, value.keyVersion)).toThrow();
  });

  it('requires the stored key version for decryption', () => {
    process.env.GALLERY_ENCRYPTION_KEY_V1 = keyV1;
    const value = encrypt('secret');
    delete process.env.GALLERY_ENCRYPTION_KEY_V1;

    expect(() => decrypt(value.encrypted, value.iv, value.keyVersion)).toThrow(
      'GALLERY_ENCRYPTION_KEY_V1 is not set',
    );
  });

  it('generates independent 64-character hex keys', () => {
    const first = generateKey();
    const second = generateKey();

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toBe(second);
  });
});