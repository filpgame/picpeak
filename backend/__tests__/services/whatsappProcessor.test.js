'use strict';

jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));

const mockDbInner = {
  insert: jest.fn().mockResolvedValue([1]),
  where: jest.fn().mockReturnThis(),
  andWhere: jest.fn().mockReturnThis(),
  orderBy: jest.fn().mockReturnThis(),
  limit: jest.fn().mockResolvedValue([]),
  update: jest.fn().mockResolvedValue(1),
  first: jest.fn().mockResolvedValue(null),
};
const mockDbFn = jest.fn(() => mockDbInner);
jest.mock('../../src/database/db', () => ({ db: mockDbFn }));

jest.mock('../../src/services/whatsappService', () => ({
  sendWhatsAppMessage: jest.fn(),
}));

const { db } = require('../../src/database/db');
const { sendWhatsAppMessage } = require('../../src/services/whatsappService');
const { queueWhatsapp, processWhatsAppQueue } = require('../../src/services/whatsappProcessor');

beforeEach(() => {
  jest.clearAllMocks();
  mockDbFn.mockReturnValue(mockDbInner);
  mockDbInner.insert.mockResolvedValue([1]);
  mockDbInner.limit.mockResolvedValue([]);
  mockDbInner.update.mockResolvedValue(1);
  mockDbInner.first.mockResolvedValue(null);
});

describe('queueWhatsapp', () => {
  it('inserts a pending row into whatsapp_queue', async () => {
    await queueWhatsapp(42, '+5511999999999', 'gallery_created', { customer_name: 'Ana' });

    expect(mockDbFn).toHaveBeenCalledWith('whatsapp_queue');
    expect(mockDbInner.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        event_id: 42,
        recipient_phone: '+5511999999999',
        message_type: 'gallery_created',
        status: 'pending',
        retry_count: 0,
      })
    );
  });

  it('stringifies message_data', async () => {
    await queueWhatsapp(1, '+5511999999999', 'gallery_created', { foo: 'bar' });
    const call = mockDbInner.insert.mock.calls[0][0];
    expect(typeof call.message_data).toBe('string');
    expect(JSON.parse(call.message_data)).toEqual({ foo: 'bar' });
  });
});

describe('processWhatsAppQueue', () => {
  const makeItem = (overrides = {}) => ({
    id: 1,
    event_id: 10,
    recipient_phone: '+5511999999999',
    message_type: 'gallery_created',
    message_data: JSON.stringify({
      customer_name: 'Ana',
      event_name: 'Casamento',
      gallery_link: 'https://example.com/g/abc',
      gallery_password: 'secret',
      expiry_date: '2026-12-31T00:00:00.000Z',
    }),
    status: 'pending',
    retry_count: 0,
    ...overrides,
  });

  it('does nothing when no pending items', async () => {
    mockDbFn
      .mockReturnValueOnce({ where: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue({ enabled: true, phone_number_id: 'PID', access_token: 'TOKEN', template_name: 'gallery_ready' }) })
      .mockReturnValue(mockDbInner);

    await processWhatsAppQueue();
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it('marks item as sent on success', async () => {
    const item = makeItem();
    const configMock = { enabled: true, phone_number_id: 'PID', waba_id: 'WABA', access_token: 'TOKEN', template_name: 'gallery_ready' };
    mockDbFn
      .mockReturnValueOnce({ where: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue(configMock) })
      .mockReturnValueOnce({ ...mockDbInner, where: jest.fn().mockReturnThis(), andWhere: jest.fn().mockReturnThis(), orderBy: jest.fn().mockReturnThis(), limit: jest.fn().mockResolvedValue([item]) })
      .mockReturnValue(mockDbInner);

    sendWhatsAppMessage.mockResolvedValueOnce({ messageId: 'wamid.abc' });

    await processWhatsAppQueue();

    expect(mockDbInner.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'sent' }));
  });

  it('increments retry_count on failure and keeps status pending', async () => {
    const item = makeItem({ retry_count: 1 });
    const configMock = { enabled: true, phone_number_id: 'PID', waba_id: 'WABA', access_token: 'TOKEN', template_name: 'gallery_ready' };
    mockDbFn
      .mockReturnValueOnce({ where: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue(configMock) })
      .mockReturnValueOnce({ ...mockDbInner, where: jest.fn().mockReturnThis(), andWhere: jest.fn().mockReturnThis(), orderBy: jest.fn().mockReturnThis(), limit: jest.fn().mockResolvedValue([item]) })
      .mockReturnValue(mockDbInner);

    sendWhatsAppMessage.mockRejectedValueOnce(new Error('API down'));

    await processWhatsAppQueue();

    expect(mockDbInner.update).toHaveBeenCalledWith(
      expect.objectContaining({ retry_count: 2, error_message: 'API down' })
    );
  });
});
