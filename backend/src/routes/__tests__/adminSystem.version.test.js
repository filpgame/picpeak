jest.mock('../../middleware/auth', () => ({
  adminAuth: (_req, _res, next) => { _req.admin = { id: 1 }; next(); },
}));
jest.mock('../../middleware/permissions', () => ({
  requirePermission: () => (_req, _res, next) => next(),
}));
jest.mock('../../services/updateCheckService', () => ({
  checkForUpdates: jest.fn().mockResolvedValue({
    current: '4.1.2-beta.0',
    channel: 'beta',
    updateAvailable: false,
    latest: { stable: '4.1.2', beta: '4.1.2-beta.0', forChannel: '4.1.2-beta.0' },
    lastChecked: new Date().toISOString(),
  }),
  getCurrentChannel: jest.fn().mockReturnValue('beta'),
}));
jest.mock('../../services/environmentService', () => ({
  detectEnvironment: jest.fn(),
  generateUpdateInstructions: jest.fn(),
}));
jest.mock('../../services/updateNotificationService', () => ({
  checkAndNotifyUpdates: jest.fn(),
  sendTestUpdateNotification: jest.fn(),
  getUpdateNotificationSettings: jest.fn().mockResolvedValue({}),
}));
jest.mock('../../database/db', () => ({ db: jest.fn(), withRetry: jest.fn() }));

const request = require('supertest');
const express = require('express');

describe('GET /system/updates — repo env var', () => {
  it('calls checkForUpdates (which should use GITHUB_RELEASES_REPO env var)', async () => {
    const { checkForUpdates } = require('../../services/updateCheckService');
    const router = require('../adminSystem');
    const app = express();
    app.use(express.json());
    app.use('/system', router);

    const res = await request(app).get('/system/updates');
    expect(res.status).toBe(200);
    expect(checkForUpdates).toHaveBeenCalled();
  });
});
