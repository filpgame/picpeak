'use strict';

jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));

jest.mock('../../src/middleware/auth', () => ({
  adminAuth: (req, _res, next) => { req.admin = { id: 1, username: 'admin', roleName: 'super_admin' }; next(); },
}));
jest.mock('../../src/middleware/permissions', () => ({
  requirePermission: () => (_req, _res, next) => next(),
}));

const mockFirstConfig = jest.fn();
const mockDbUpdate = jest.fn().mockResolvedValue(1);
const mockDbInsert = jest.fn().mockResolvedValue([1]);
const mockDbWhere = jest.fn().mockReturnThis();
const mockDbChain = { first: mockFirstConfig, where: mockDbWhere, update: mockDbUpdate, insert: mockDbInsert };
const mockDbFn = jest.fn(() => mockDbChain);
jest.mock('../../src/database/db', () => ({
  db: mockDbFn,
  logActivity: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/services/whatsappService', () => ({
  sendWhatsAppMessage: jest.fn().mockResolvedValue({ messageId: 'wamid.test' }),
}));

const request = require('supertest');
const express = require('express');
const adminWhatsappRoute = require('../../src/routes/adminWhatsapp');

const app = express();
app.use(express.json());
app.use('/', adminWhatsappRoute);

beforeEach(() => {
  jest.clearAllMocks();
  mockDbFn.mockReturnValue(mockDbChain);
  mockDbWhere.mockReturnThis();
});

describe('GET /config', () => {
  it('returns masked access_token when config exists', async () => {
    mockFirstConfig.mockResolvedValueOnce({
      id: 1, phone_number_id: 'PID', waba_id: 'WABA',
      access_token: 'realtoken', template_name: 'gallery_ready', enabled: true,
    });

    const res = await request(app).get('/config');
    expect(res.status).toBe(200);
    expect(res.body.access_token).toBe('********');
    expect(res.body.phone_number_id).toBe('PID');
    expect(res.body.enabled).toBe(true);
  });

  it('returns empty defaults when no config exists', async () => {
    mockFirstConfig.mockResolvedValueOnce(null);
    const res = await request(app).get('/config');
    expect(res.status).toBe(200);
    expect(res.body.phone_number_id).toBe('');
    expect(res.body.enabled).toBe(false);
  });
});

describe('PUT /config', () => {
  it('upserts config and returns success', async () => {
    mockFirstConfig.mockResolvedValueOnce(null);
    const res = await request(app).put('/config').send({
      phone_number_id: 'PID', waba_id: 'WABA',
      access_token: 'newtoken', template_name: 'gallery_ready', enabled: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockDbInsert).toHaveBeenCalled();
  });

  it('does not update access_token when value is ********', async () => {
    mockFirstConfig.mockResolvedValueOnce({ id: 1 });
    const res = await request(app).put('/config').send({
      phone_number_id: 'PID', waba_id: 'WABA',
      access_token: '********', template_name: 'gallery_ready', enabled: false,
    });
    expect(res.status).toBe(200);
    const updateCall = mockDbUpdate.mock.calls[0][0];
    expect(updateCall).not.toHaveProperty('access_token');
  });
});

describe('POST /test', () => {
  it('returns 400 when phone is missing', async () => {
    const res = await request(app).post('/test').send({});
    expect(res.status).toBe(400);
  });

  it('returns 400 when config is not set up', async () => {
    mockFirstConfig.mockResolvedValueOnce(null);
    const res = await request(app).post('/test').send({ phone: '+5511999999999' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not configured/i);
  });

  it('returns success on valid test send', async () => {
    mockFirstConfig.mockResolvedValueOnce({
      id: 1, phone_number_id: 'PID', waba_id: 'WABA',
      access_token: 'TOKEN', template_name: 'gallery_ready', enabled: true,
    });
    const res = await request(app).post('/test').send({ phone: '+5511999999999' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
