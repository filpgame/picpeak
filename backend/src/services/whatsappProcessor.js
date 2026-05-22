'use strict';

const { db } = require('../database/db');
const logger = require('../utils/logger');
const { sendWhatsAppMessage } = require('./whatsappService');

// Map app language codes → WhatsApp template language codes.
// Handles both IETF hyphen style (pt-BR) and underscore style (pt_BR).
const LANGUAGE_MAP = {
  pt:       'pt_BR', ptbr:    'pt_BR', 'pt-br': 'pt_BR', 'pt_br': 'pt_BR',
  en:       'en_US', 'en-us': 'en_US', 'en_us': 'en_US',
  de:       'de_DE', 'de-de': 'de_DE', 'de_de': 'de_DE',
  ru:       'ru_RU', 'ru-ru': 'ru_RU', 'ru_ru': 'ru_RU',
  nl:       'nl_NL', 'nl-nl': 'nl_NL', 'nl_nl': 'nl_NL',
  fr:       'fr_FR', 'fr-fr': 'fr_FR', 'fr_fr': 'fr_FR',
  es:       'es_ES', 'es-es': 'es_ES', 'es_es': 'es_ES',
};

// Normalise and resolve a language code to the Meta template language code.
// Normalises IETF hyphen tags (pt-BR) and case differences before lookup.
// Falls back to pt_BR when the language is unknown or null.
function resolveLanguageCode(lang) {
  if (!lang) return 'pt_BR';
  const normalised = String(lang).toLowerCase().replace(/-/g, '_');
  return LANGUAGE_MAP[normalised] || 'pt_BR';
}

// Per-locale label for the password line embedded in the template parameter.
// The label lives here because {{4}} is a free-text slot; the template body
// only contains the placeholder, not the "Password:" text itself.
const PASSWORD_LABELS = {
  pt_BR: '🔒 Senha',
  en_US: '🔒 Password',
  de_DE: '🔒 Passwort',
  ru_RU: '🔒 Пароль',
  nl_NL: '🔒 Wachtwoord',
  fr_FR: '🔒 Mot de passe',
  es_ES: '🔒 Contraseña',
};

// Map Meta language codes to Intl locale strings for date formatting.
const INTL_LOCALE_MAP = {
  pt_BR: 'pt-BR', en_US: 'en-US', de_DE: 'de-DE',
  ru_RU: 'ru-RU', nl_NL: 'nl-NL', fr_FR: 'fr-FR', es_ES: 'es-ES',
};

function formatDate(raw, metaLangCode) {
  if (!raw) return '';
  try {
    const d = new Date(raw);
    if (isNaN(d.getTime())) return '';
    const intlLocale = INTL_LOCALE_MAP[metaLangCode] || 'pt-BR';
    return d.toLocaleDateString(intlLocale, { day: '2-digit', month: '2-digit', year: 'numeric' });
  } catch {
    return '';
  }
}

function buildComponents(data) {
  const metaLang = resolveLanguageCode(data.language);
  const label = PASSWORD_LABELS[metaLang] || PASSWORD_LABELS['pt_BR'];
  const passwordLine = data.gallery_password
    && data.gallery_password !== 'No password required'
    && data.gallery_password !== '(set at creation)'
    ? `${label}: ${data.gallery_password}`
    : '';
  const expiryLine = formatDate(data.expiry_date, metaLang);

  return [
    data.customer_name || '',
    data.event_name || '',
    data.gallery_link || '',
    passwordLine,
    expiryLine,
  ];
}

// Always read via .first() so the lookup is consistent with the admin
// config routes (which also use .first()) regardless of the row id value.
async function getWhatsAppConfig() {
  try {
    return await db('whatsapp_configs').first();
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
        const languageCode = resolveLanguageCode(data.language);

        await sendWhatsAppMessage(item.recipient_phone, config, languageCode, components);

        await db('whatsapp_queue')
          .where('id', item.id)
          .update({ status: 'sent', sent_at: new Date() });

        logger.info('WhatsApp message ' + item.id + ' sent');
      } catch (error) {
        const newRetryCount = item.retry_count + 1;
        await db('whatsapp_queue')
          .where('id', item.id)
          .update({
            retry_count: newRetryCount,
            error_message: error.message,
            ...(newRetryCount >= 3 ? { status: 'failed' } : {}),
          });

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
