'use strict';

const { db } = require('../database/db');
const logger = require('../utils/logger');
const { sendWhatsAppMessage } = require('./whatsappService');

const LANGUAGE_MAP = {
  pt: 'pt_BR',
  ptBr: 'pt_BR',
  en: 'en_US',
  de: 'de_DE',
  ru: 'ru_RU',
  nl: 'nl_NL',
  fr: 'fr_FR',
  es: 'es_ES',
};

function resolveLanguageCode(lang) {
  return LANGUAGE_MAP[lang] || 'pt_BR';
}

function formatDate(raw) {
  if (!raw) return '';
  try {
    const d = new Date(raw);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  } catch {
    return '';
  }
}

function buildComponents(data) {
  const passwordLine = data.gallery_password && data.gallery_password !== 'No password required'
    ? '🔒 Senha: ' + data.gallery_password
    : '';
  const expiryLine = formatDate(data.expiry_date);

  return [
    data.customer_name || '',
    data.event_name || '',
    data.gallery_link || '',
    passwordLine,
    expiryLine,
  ];
}

async function getWhatsAppConfig() {
  try {
    return await db('whatsapp_configs').where('id', 1).first();
  } catch (error) {
    logger.debug('whatsappProcessor: failed to read whatsapp_configs', { error: error.message });
    return null;
  }
}

async function queueWhatsapp(eventId, recipientPhone, messageType, messageData) {
  try {
    await db('whatsapp_queue').insert({
      event_id: eventId,
      recipient_phone: recipientPhone,
      message_type: messageType,
      message_data: JSON.stringify(messageData),
      status: 'pending',
      retry_count: 0,
      created_at: new Date(),
    });
    logger.info('WhatsApp queued: ' + messageType + ' → ' + recipientPhone);
  } catch (error) {
    logger.error('Error queueing WhatsApp message:', error);
    throw error;
  }
}

async function processWhatsAppQueue() {
  logger.info('WhatsApp queue processor: checking for pending messages...');

  try {
    const config = await getWhatsAppConfig();
    if (!config || !config.enabled) {
      logger.info('WhatsApp queue processor: disabled or not configured, skipping');
      return;
    }

    let pending = [];
    try {
      pending = await db('whatsapp_queue')
        .where('status', 'pending')
        .andWhere('retry_count', '<', 3)
        .orderBy('created_at', 'asc')
        .limit(10);
    } catch (dbError) {
      logger.error('WhatsApp queue: failed to query queue', dbError);
      return;
    }

    if (pending.length === 0) {
      logger.info('WhatsApp queue processor: no pending messages');
      return;
    }

    logger.info('WhatsApp queue: processing ' + pending.length + ' messages');

    for (const item of pending) {
      try {
        const data = typeof item.message_data === 'string'
          ? JSON.parse(item.message_data || '{}')
          : item.message_data || {};

        const components = buildComponents(data);
        const languageCode = resolveLanguageCode(data.language || 'pt');

        await sendWhatsAppMessage(item.recipient_phone, config, languageCode, components);

        await db('whatsapp_queue')
          .where('id', item.id)
          .update({ status: 'sent', sent_at: new Date() });

        logger.info('WhatsApp message ' + item.id + ' sent');
      } catch (error) {
        await db('whatsapp_queue')
          .where('id', item.id)
          .update({ retry_count: item.retry_count + 1, error_message: error.message, ...(item.retry_count + 1 >= 3 ? { status: "failed" } : {}) });

        logger.error('WhatsApp message ' + item.id + ' failed:', error);
      }
    }
  } catch (error) {
    logger.error('WhatsApp queue processor error:', error);
  }
}

let whatsAppQueueInterval = null;

function startWhatsAppQueueProcessor() {
  if (whatsAppQueueInterval) {
    logger.info('WhatsApp queue processor: already running');
    return;
  }
  processWhatsAppQueue().catch((err) => {
    logger.error('WhatsApp queue processor: initial run failed:', err);
  });
  whatsAppQueueInterval = setInterval(() => {
    processWhatsAppQueue().catch((err) => {
      logger.error('WhatsApp queue processor: interval run failed:', err);
    });
  }, 30000);
  logger.info('WhatsApp queue processor started');
}

function stopWhatsAppQueueProcessor() {
  if (whatsAppQueueInterval) {
    clearInterval(whatsAppQueueInterval);
    whatsAppQueueInterval = null;
    logger.info('WhatsApp queue processor stopped');
  }
}

module.exports = {
  queueWhatsapp,
  processWhatsAppQueue,
  startWhatsAppQueueProcessor,
  stopWhatsAppQueueProcessor,
  getWhatsAppConfig,
};
