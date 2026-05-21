'use strict';

jest.mock('axios');
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));

const axios = require('axios');
const { normalizePhone, sendWhatsAppMessage } = require('../../src/services/whatsappService');

describe('normalizePhone', () => {
  it('passes through a valid E.164 number', () => {
    expect(normalizePhone('+5511999999999')).toBe('+5511999999999');
  });

  it('adds + prefix when number starts with country code digits', () => {
    expect(normalizePhone('5511999999999')).toBe('+5511999999999');
  });

  it('strips spaces and dashes', () => {
    expect(normalizePhone('+55 (11) 9 9999-9999')).toBe('+5511999999999');
  });

  it('throws for null or empty input', () => {
    expect(() => normalizePhone(null)).toThrow('Invalid phone number');
    expect(() => normalizePhone('')).toThrow('Invalid phone number');
  });

  it('throws when result has fewer than 10 digits', () => {
    expect(() => normalizePhone('+123')).toThrow('Invalid phone number');
  });
});

describe('sendWhatsAppMessage', () => {
  const config = {
    phone_number_id: 'PHONE_ID',
    access_token: 'TOKEN',
    template_name: 'gallery_ready',
  };
  const components = ['João', 'Casamento Silva', 'https://example.com/gallery/abc', '', '31/12/2026'];

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('POSTs to Meta API with correct payload', async () => {
    axios.post.mockResolvedValueOnce({ data: { messages: [{ id: 'wamid.abc' }] } });

    await sendWhatsAppMessage('+5511999999999', config, 'pt_BR', components);

    expect(axios.post).toHaveBeenCalledWith(
      'https://graph.facebook.com/v19.0/PHONE_ID/messages',
      {
        messaging_product: 'whatsapp',
        to: '+5511999999999',
        type: 'template',
        template: {
          name: 'gallery_ready',
          language: { code: 'pt_BR' },
          components: [
            {
              type: 'body',
              parameters: [
                { type: 'text', text: 'João' },
                { type: 'text', text: 'Casamento Silva' },
                { type: 'text', text: 'https://example.com/gallery/abc' },
                { type: 'text', text: '' },
                { type: 'text', text: '31/12/2026' },
              ],
            },
          ],
        },
      },
      {
        headers: {
          Authorization: 'Bearer TOKEN',
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      }
    );
  });

  it('throws when axios returns a non-2xx response', async () => {
    const err = new Error('Request failed with status code 401');
    err.response = { status: 401, data: { error: { message: 'Invalid token' } } };
    axios.post.mockRejectedValueOnce(err);

    await expect(
      sendWhatsAppMessage('+5511999999999', config, 'pt_BR', components)
    ).rejects.toThrow('Invalid token');
  });
});
