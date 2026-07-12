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

// Fake ChildProcess that records error/exit handlers so tests can fire them.
function makeFakeChild() {
  const handlers = {};
  return {
    unref: jest.fn(),
    on: jest.fn((event, cb) => { handlers[event] = cb; }),
    emit: (event, arg) => handlers[event] && handlers[event](arg),
  };
}

const mockSpawn = jest.fn(() => makeFakeChild());
jest.mock('child_process', () => ({ spawn: mockSpawn }));

// Control systemd detection: spawnUpdateProcess branches on
// fsSync.existsSync('/run/systemd/system').
const mockExistsSync = jest.fn();
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return { ...actual, existsSync: mockExistsSync };
});

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
    mockSpawn.mockReset();
    mockSpawn.mockImplementation(() => makeFakeChild());
    // Default: no systemd → plain bash fallback
    mockExistsSync.mockReturnValue(false);
  });

  it('returns 202 and spawns setup script via bash when systemd absent', async () => {
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

  it('launches via systemd-run in its own unit when systemd present', async () => {
    mockExistsSync.mockReturnValue(true);
    const app = buildApp();
    const res = await request(app).post('/system/updates/apply');
    expect(res.status).toBe(202);
    expect(mockSpawn).toHaveBeenCalledWith(
      'systemd-run',
      expect.arrayContaining([
        '--collect',
        '--unit',
        expect.stringMatching(/^picpeak-update-\d+$/),
        'bash',
        expect.stringContaining('picpeak-setup.sh'),
        '--update',
      ]),
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
    mockSpawn.mockImplementation(() => makeFakeChild());
    const res2 = await request(app).post('/system/updates/apply');
    expect(res2.status).toBe(202);
  });

  it('resets flag when launcher emits error (binary not spawnable)', async () => {
    let child;
    mockSpawn.mockImplementation(() => { child = makeFakeChild(); return child; });
    const app = buildApp();

    const res = await request(app).post('/system/updates/apply');
    expect(res.status).toBe(202);

    // systemd-run/bash couldn't be spawned → ENOENT error event
    child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));

    // Flag cleared — retry is allowed instead of being stuck on 409
    const res2 = await request(app).post('/system/updates/apply');
    expect(res2.status).toBe(202);
  });

  it('resets flag when launcher exits non-zero (unit failed to start)', async () => {
    mockExistsSync.mockReturnValue(true);
    let child;
    mockSpawn.mockImplementation(() => { child = makeFakeChild(); return child; });
    const app = buildApp();

    const res = await request(app).post('/system/updates/apply');
    expect(res.status).toBe(202);

    // systemd-run returned non-zero → transient unit never launched
    child.emit('exit', 1);

    const res2 = await request(app).post('/system/updates/apply');
    expect(res2.status).toBe(202);
  });

  it('keeps flag set when launcher exits zero (update running detached)', async () => {
    mockExistsSync.mockReturnValue(true);
    let child;
    mockSpawn.mockImplementation(() => { child = makeFakeChild(); return child; });
    const app = buildApp();

    await request(app).post('/system/updates/apply');
    // systemd-run launched the unit successfully and exited 0
    child.emit('exit', 0);

    // Update is in progress in its own unit → further applies are blocked
    const res2 = await request(app).post('/system/updates/apply');
    expect(res2.status).toBe(409);
  });
});
