// Env vars must be set at module load (not inside beforeAll) because some
// test files evaluate `const skipS3 = process.env.SKIP_S3_TESTS === 'true'`
// at import time. setupFilesAfterEnv runs after those module-level const
// evaluations.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
if (!process.env.SKIP_S3_TESTS) {
  process.env.SKIP_S3_TESTS = 'true';
}
if (!process.env.STORAGE_PATH) {
  process.env.STORAGE_PATH = '/storage';
}
