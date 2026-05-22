'use strict';

const axios = require('axios');
const logger = require('../utils/logger');

const META_API_VERSION = 'v19.0';
const META_API_BASE = `https://graph.facebook.com/${META_API_VERSION}`;

function normalizePhone(phone) {
  if (!phone) throw new Error('Invalid phone number: null or empty');
  const digits = phone.replace(/[^\d]/g, '');
  if (digits.length < 10) throw new Error(`Invalid phone number: too short after normalisation (${phone})`);
  return `+${digits}`;
}

async function sendWhatsAppMessage(recipientPhone, config, languageCode, components) {
  const normalised = normalizePhone(recipientPhone);

  const payload = {
    messaging_product: 'whatsapp',
    to: normalised,
    type: 'template',
    template: {
      name: config.template_name,
      language: { code: languageCode },
      components: [
        {
          type: 'body',
          parameters: components.map((text) => ({ type: 'text', text: String(text) })),
        },
      ],
    },
  };

  try {
    const response = await axios.post(
      `${META_API_BASE}/${config.phone_number_id}/messages`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${config.access_token}`,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      }
    );
    const messageId = response.data?.messages?.[0]?.id ?? 'unknown';
    logger.info(`WhatsApp message sent: ${messageId} → ${normalised}`);
    return { messageId };
  } catch (error) {
    const metaMessage = error.response?.data?.error?.message;
    const msg = metaMessage || error.message;
    logger.error('WhatsApp API error', { error: msg, phone: normalised });
    throw new Error(msg);
  }
}

module.exports = { normalizePhone, sendWhatsAppMessage };
