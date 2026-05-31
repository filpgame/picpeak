jest.mock('../../middleware/auth', () => ({
  adminAuth: (_req, _res, next) => { _req.admin = { id: 1 }; next(); },
}));
jest.mock('../../middleware/permissions', () => ({
  requirePermission: () => (_req, _res, next) => next(),
}));
jest.mock('../../services/updateNotificationService', () => ({
  checkAndNotifyUpdates: jest.fn(),
  sendTestUpdateNotification: jest.fn(),
  getUpdateNotificationSettings: jest.fn().mockResolvedValue({}),
}));
jest.mock('../../services/environmentService', () => ({
  detectEnvironment: jest.fn(),
  generateUpdateInstructions: jest.fn(),
}));
jest.mock('../../database/db', () => ({ db: jest.fn(), withRetry: jest.fn() }));

const mockSpawn = jest.fn(() => ({ unref: jest.fn() }));
jest.mock('child_process', () => ({ spawn: mockSpawn }));

jest.mock('../../services/updateCheckService', () => ({
  checkForUpdates: jest.fn().mockResolvedValue({
    current: '4.1.2-beta.0',
    channel: 'beta',
    updateAvailable: true,
    latest: { stable: '4.1.2', beta: '4.1.3-beta.0', forChannel: '4.1.3-beta.0' },
    lastChecked: new Date().toISOString(),
  }),
  getCurrentChannel: jest.fn().mockReturnValue('beta'),
}));

const request = require('supertest');
const express = require('express');

function buildApp() {
  // Use isolateModules so updateInProgress flag resets between tests
  let router;
  jest.isolateModules(() => {
    router = require('../adminSystem');
  });
  const app = express();
  app.use(express.json());
  app.use('/system', router);
  return app;
}

describe('POST /system/updates/apply', () => {
  beforeEach(() => {
    mockSpawn.mockClear();
    mockSpawn.mockReturnValue({ unref: jest.fn() });
  });

  it('returns 202 and spawns setup script', async () => {
    const app = buildApp();
    const res = await request(app).post('/system/updates/apply');
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('started');
    expect(res.body.targetVersion).toBe('4.1.3-beta.0');
    expect(mockSpawn).toHaveBeenCalledWith(
      'bash',
      [expect.stringContaining('picpeak-setup.sh'), '--update'],
      expect.objectContaining({ detached: true, stdio: 'ignore' })
    );
  });

  it('returns 409 if spawn already in progress', async () => {
    const app = buildApp();
    // First request starts it
    await request(app).post('/system/updates/apply');
    // Second request hits the guard
    const res = await request(app).post('/system/updates/apply');
    expect(res.status).toBe(409);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('returns 500 and resets flag if spawn throws', async () => {
    mockSpawn.mockImplementation(() => { throw new Error('spawn failed'); });
    const app = buildApp();
    const res = await request(app).post('/system/updates/apply');
    expect(res.status).toBe(500);

    // Flag reset — second request can proceed
    mockSpawn.mockReturnValue({ unref: jest.fn() });
    const res2 = await request(app).post('/system/updates/apply');
    expect(res2.status).toBe(202);
  });
});
