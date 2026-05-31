const { PassThrough } = require('stream');

jest.mock('../../middleware/auth', () => ({
  adminAuth: (_req, _res, next) => { _req.admin = { id: 1 }; next(); },
}));
jest.mock('../../middleware/permissions', () => ({
  requirePermission: () => (_req, _res, next) => next(),
}));
jest.mock('../../services/updateCheckService', () => ({
  checkForUpdates: jest.fn(),
  getCurrentChannel: jest.fn().mockReturnValue('beta'),
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

const mockAccess = jest.fn();
const mockCreateReadStream = jest.fn();

jest.mock('fs', () => {
  const original = jest.requireActual('fs');
  return {
    ...original,
    promises: {
      ...original.promises,
      access: mockAccess,
    },
    createReadStream: mockCreateReadStream,
  };
});

const request = require('supertest');
const express = require('express');

let app;
beforeAll(() => {
  const router = require('../adminSystem');
  app = express();
  app.use(express.json());
  app.use('/system', router);
});

describe('GET /system/logs/download', () => {
  beforeEach(() => {
    mockAccess.mockReset();
    mockCreateReadStream.mockReset();
  });

  it('streams combined.log with correct headers', async () => {
    mockAccess.mockResolvedValue(undefined);
    const stream = new PassThrough();
    stream.end('log line 1\nlog line 2\n');
    mockCreateReadStream.mockReturnValue(stream);

    const res = await request(app).get('/system/logs/download?type=combined');

    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toBe('attachment; filename=picpeak-combined.log');
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.text).toContain('log line 1');
    expect(mockCreateReadStream).toHaveBeenCalledWith(expect.stringContaining('combined.log'));
  });

  it('streams error.log when type=error', async () => {
    mockAccess.mockResolvedValue(undefined);
    const stream = new PassThrough();
    stream.end('error entry\n');
    mockCreateReadStream.mockReturnValue(stream);

    const res = await request(app).get('/system/logs/download?type=error');

    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toBe('attachment; filename=picpeak-error.log');
    expect(mockCreateReadStream).toHaveBeenCalledWith(expect.stringContaining('error.log'));
  });

  it('defaults to combined.log when type param is missing', async () => {
    mockAccess.mockResolvedValue(undefined);
    const stream = new PassThrough();
    stream.end('data');
    mockCreateReadStream.mockReturnValue(stream);

    const res = await request(app).get('/system/logs/download');
    expect(res.status).toBe(200);
    expect(mockCreateReadStream).toHaveBeenCalledWith(expect.stringContaining('combined.log'));
  });

  it('returns 404 when log file does not exist', async () => {
    mockAccess.mockRejectedValue(new Error('ENOENT'));

    const res = await request(app).get('/system/logs/download?type=combined');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });
});
