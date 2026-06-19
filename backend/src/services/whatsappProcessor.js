'use strict';

/**
 * WhatsApp queue processor (#640 part D).
 *
 * Polls `whatsapp_queue` every 30s. For each pending row whose retry_count <
 * 3, builds the Meta template components from the stored message_data,
 * resolves the language code, and sends via whatsappService. Transient
 * failures bump retry_count; permanent failures mark the row 'failed'.
 *
 * Ported from filpgame/picpeak with the following changes:
 *   - Default language sourced from `app_settings.general_default_language`
 *     (matches our email-language resolution pattern) instead of a hardcoded
 *     `pt_BR`. Falls back to `en` then `en_US` if nothing is configured.
 *   - Cycle size + interval pulled from env vars so low-volume installs can
 *     dial back the poll frequency.
 *   - Exits gracefully when the `whatsapp` feature flag is off (no config
 *     polling, no queue queries).
 */

const { db } = require('../database/db');
const logger = require('../utils/logger');
const { sendWhatsAppMessage } = require('./whatsappService');

// IETF language tag (with hyphen or underscore) → Meta template language code.
// Meta template languages: https://developers.facebook.com/docs/whatsapp/business-management-api/message-templates/supported-languages
const LANGUAGE_MAP = {
  en:    'en_US', 'en-us': 'en_US', 'en_us': 'en_US',
  de:    'de_DE', 'de-de': 'de_DE', 'de_de': 'de_DE',
  pt:    'pt_BR', ptbr: 'pt_BR', 'pt-br': 'pt_BR', 'pt_br': 'pt_BR',
  ru:    'ru_RU', 'ru-ru': 'ru_RU', 'ru_ru': 'ru_RU',
  nl:    'nl_NL', 'nl-nl': 'nl_NL', 'nl_nl': 'nl_NL',
  fr:    'fr_FR', 'fr-fr': 'fr_FR', 'fr_fr': 'fr_FR',
  es:    'es_ES', 'es-es': 'es_ES', 'es_es': 'es_ES',
  it:    'it_IT', 'it-it': 'it_IT', 'it_it': 'it_IT',
};

// Per-locale label embedded in the {{4}} password line. Meta templates only
// accept positional parameters in the body, so the "Password:" prefix has to
// be baked into the parameter itself rather than living in the template body.
const PASSWORD_LABELS = {
  pt_BR: '🔒 Senha',
  en_US: '🔒 Password',
  de_DE: '🔒 Passwort',
  ru_RU: '🔒 Пароль',
  nl_NL: '🔒 Wachtwoord',
  fr_FR: '🔒 Mot de passe',
  es_ES: '🔒 Contraseña',
  it_IT: '🔒 Password',
};

const INTL_LOCALE_MAP = {
  pt_BR: 'pt-BR', en_US: 'en-US', de_DE: 'de-DE',
  ru_RU: 'ru-RU', nl_NL: 'nl-NL', fr_FR: 'fr-FR',
  es_ES: 'es-ES', it_IT: 'it-IT',
};

const POLL_INTERVAL_MS = parseInt(process.env.WHATSAPP_QUEUE_POLL_MS || '30000', 10);
const CYCLE_BATCH_SIZE = parseInt(process.env.WHATSAPP_QUEUE_BATCH || '10', 10);
const MAX_RETRIES = 3;

let pollHandle = null;

/**
 * Resolve a Meta template language code from whatever's in the message_data
 * (admin-set per-event language) or the system default.
 */
function resolveLanguageCode(lang) {
  if (!lang) return null; // signal: caller should fall through to default
  const normalised = String(lang).toLowerCase().replace(/-/g, '_');
  return LANGUAGE_MAP[normalised] || null;
}

async function getSystemDefaultLanguageCode() {
  try {
    const row = await db('app_settings')
      .where('setting_key', 'general_default_language')
      .first();
    if (row && row.setting_value) {
      let lang = row.setting_value;
      try { lang = JSON.parse(lang); } catch (_) { /* not JSON, use raw */ }
      const resolved = resolveLanguageCode(typeof lang === 'string' ? lang.trim() : '');
      if (resolved) return resolved;
    }
  } catch (error) {
    logger.debug('whatsappProcessor: general_default_language read failed', { error: error.message });
  }
  return 'en_US';
}

function formatDate(raw, metaLangCode) {
  if (!raw) return '';
  try {
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return '';
    const intlLocale = INTL_LOCALE_MAP[metaLangCode] || 'en-US';
    return d.toLocaleDateString(intlLocale, { day: '2-digit', month: '2-digit', year: 'numeric' });
  } catch {
    return '';
  }
}

/**
 * Build the positional body components for the configured template. The
 * default `gallery_ready` template (operator-registered) expects:
 *   {{1}} customer_name
 *   {{2}} event_name
 *   {{3}} gallery_link
 *   {{4}} password line (with localised "🔒 Password:" prefix, or empty)
 *   {{5}} expiry date (or empty)
 */
function buildComponents(data, metaLang) {
  const label = PASSWORD_LABELS[metaLang] || PASSWORD_LABELS.en_US;
  const hasRealPassword = data.gallery_password
    && data.gallery_password !== 'No password required'
    && data.gallery_password !== '(set at creation)';
  const passwordLine = hasRealPassword ? `${label}: ${data.gallery_password}` : '';
  const expiryLine = formatDate(data.expiry_date, metaLang);

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
    return await db('whatsapp_configs').first();
  } catch (error) {
    logger.debug('whatsappProcessor: failed to read whatsapp_configs', { error: error.message });
    return null;
  }
}

/**
 * Enqueue a WhatsApp message. Safe to call without checking the feature flag
 * upstream — the processor's poll loop is the gate, so a queued message just
 * sits idle if the flag is off. Routes still SHOULD check the flag before
 * calling so the customer-facing error path (silent feature disabled vs. real
 * queue failure) stays distinguishable.
 */
async function queueWhatsapp(eventId, recipientPhone, messageType, messageData) {
  try {
    await db('whatsapp_queue').insert({
      event_id: eventId,
      recipient_phone: recipientPhone,
      message_type: messageType,
      message_data: JSON.stringify(messageData || {}),
      status: 'pending',
      retry_count: 0,
      created_at: new Date(),
    });
    logger.info(`WhatsApp queued: ${messageType} → ${recipientPhone}`);
  } catch (error) {
    logger.error('Error queueing WhatsApp message:', error);
    throw error;
  }
}

/**
 * One poll cycle. Reads up to CYCLE_BATCH_SIZE pending rows, sends each, and
 * updates retry/error/status fields. Wraps everything in defensive try/catch
 * so a single bad row can't stall the rest of the batch.
 */
async function processWhatsAppQueue() {
  let config;
  try {
    config = await getWhatsAppConfig();
  } catch (e) {
    // Tables not migrated yet — just bail.
    return;
  }
  if (!config || !config.enabled || !config.phone_number_id || !config.access_token) return;

  const defaultLanguage = await getSystemDefaultLanguageCode();

  let pending;
  try {
    pending = await db('whatsapp_queue')
      .where('status', 'pending')
      .andWhere('retry_count', '<', MAX_RETRIES)
      .orderBy('created_at', 'asc')
      .limit(CYCLE_BATCH_SIZE);
  } catch (error) {
    logger.error('WhatsApp queue: failed to query pending rows', { error: error.message });
    return;
  }

  if (pending.length === 0) return;

  logger.info(`WhatsApp queue: processing ${pending.length} message(s)`);

  for (const item of pending) {
    try {
      const data = typeof item.message_data === 'string'
        ? JSON.parse(item.message_data || '{}')
        : item.message_data || {};

      const requestedLang = resolveLanguageCode(data.language);
      const metaLang = requestedLang || defaultLanguage;
      const components = buildComponents(data, metaLang);

      await sendWhatsAppMessage(item.recipient_phone, config, metaLang, components);

      await db('whatsapp_queue')
        .where('id', item.id)
        .update({ status: 'sent', sent_at: new Date(), error_message: null });
    } catch (error) {
      const newRetryCount = (item.retry_count || 0) + 1;
      const exhausted = newRetryCount >= MAX_RETRIES;
      await db('whatsapp_queue')
        .where('id', item.id)
        .update({
          retry_count: newRetryCount,
          error_message: String(error.message).slice(0, 2000),
          ...(exhausted ? { status: 'failed' } : {}),
        });
      logger.error(
        `WhatsApp message ${item.id} ${exhausted ? 'failed (permanent)' : `retry ${newRetryCount}/${MAX_RETRIES}`}:`,
        error.message,
      );
    }
  }
}

function startWhatsAppQueueProcessor() {
  if (pollHandle) {
    logger.info('WhatsApp queue processor already running — skipping start');
    return;
  }
  // Fire once shortly after boot so the first message in a fresh install
  // doesn't wait the full poll interval.
  setTimeout(() => {
    processWhatsAppQueue().catch((e) => logger.error('WhatsApp queue initial run failed', e));
  }, 5000);
  pollHandle = setInterval(() => {
    processWhatsAppQueue().catch((e) => logger.error('WhatsApp queue cycle failed', e));
  }, POLL_INTERVAL_MS);
  logger.info(`WhatsApp queue processor started (poll every ${POLL_INTERVAL_MS}ms)`);
}

function stopWhatsAppQueueProcessor() {
  if (pollHandle) {
    clearInterval(pollHandle);
    pollHandle = null;
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
