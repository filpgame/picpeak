/**
 * Incoming-mail intake (migration 128). Polls the configured IMAP mailbox
 * every minute, parses each unseen message, and drops PDF/image attachments
 * into the incoming-invoices inbox (inbound_documents, source='email').
 *
 * Gated by the `incomingMail` feature flag. Idempotent: each message is logged
 * in received_emails keyed by message-id (skip if seen); duplicate attachments
 * are caught downstream by the inbound_documents SHA-256 dedup. Handles
 * forwarded messages because mailparser flattens nested attachments.
 */
const fsp = require('fs').promises;
const path = require('path');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { db } = require('../database/db');
const logger = require('../utils/logger');
const { getStoragePath } = require('../config/storage');
const expenseService = require('./expenseService');

const ALLOWED_MIME = ['application/pdf', 'image/jpeg', 'image/png'];
let polling = false;

async function isEnabled() {
  const flag = await db('feature_flags').where({ key: 'incomingMail' }).first();
  return !!(flag && (flag.value === true || flag.value === 1 || flag.value === '1'));
}

async function getImapConfig() {
  const c = await db('email_configs').first();
  if (!c || !c.imap_host || !c.imap_user) return null;
  return {
    host: c.imap_host,
    port: c.imap_port || 993,
    secure: c.imap_secure !== false && c.imap_secure !== 0,
    auth: { user: c.imap_user, pass: c.imap_pass || '' },
    folder: c.imap_folder || 'INBOX',
  };
}

async function saveAttachment(att) {
  const year = new Date().getFullYear();
  const dir = path.join(getStoragePath(), 'business-docs', 'inbound', String(year));
  await fsp.mkdir(dir, { recursive: true });
  const ext = path.extname(att.filename || '')
    || (att.contentType === 'application/pdf' ? '.pdf' : att.contentType === 'image/png' ? '.png' : '.jpg');
  const filePath = path.join(dir, `email-${Date.now()}-${Math.floor(Math.random() * 1e6)}${ext}`);
  await fsp.writeFile(filePath, att.content);
  return filePath;
}

/**
 * List the mailbox folders on the IMAP server so the UI can offer a
 * dropdown instead of a free-text path. Uses the saved config; an
 * `override` ({ host, port, secure, user, pass }) lets the admin detect
 * folders BEFORE saving. A masked/blank override password falls back to
 * the stored one. Returns [{ path, name, specialUse }] (specialUse like
 * '\\Inbox' lets the caller auto-select the inbox).
 */
async function listFolders(override) {
  let cfg;
  if (override && override.host && override.user) {
    cfg = {
      host: override.host,
      port: override.port || 993,
      secure: override.secure !== false && override.secure !== 0,
      auth: { user: override.user, pass: override.pass || '' },
    };
    if (!cfg.auth.pass || cfg.auth.pass === '********') {
      const stored = await getImapConfig();
      cfg.auth.pass = stored?.auth?.pass || '';
    }
  } else {
    cfg = await getImapConfig();
  }
  if (!cfg) return [];
  const client = new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.auth, logger: false });
  await client.connect();
  try {
    const list = await client.list();
    return (list || []).map((m) => ({ path: m.path, name: m.name, specialUse: m.specialUse || null }));
  } finally {
    await client.logout().catch(() => {});
  }
}

/** Poll the mailbox once. Safe to call repeatedly; self-skips when busy/off. */
async function pollOnce() {
  if (polling) return { skipped: 'busy' };
  if (!(await isEnabled())) return { skipped: 'disabled' };
  const cfg = await getImapConfig();
  if (!cfg) return { skipped: 'unconfigured' };

  polling = true;
  const client = new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.auth, logger: false });
  let processed = 0;
  try {
    await client.connect();
    const lock = await client.getMailboxLock(cfg.folder);
    try {
      // eslint-disable-next-line no-restricted-syntax
      for await (const msg of client.fetch({ seen: false }, { source: true, uid: true })) {
        try {
          const parsed = await simpleParser(msg.source);
          const messageId = parsed.messageId || `uid-${cfg.folder}-${msg.uid}`;
          const seen = await db('received_emails').where({ message_id: messageId }).first();
          if (seen) { await client.messageFlagsAdd(msg.uid, ['\\Seen'], { uid: true }); continue; }

          const atts = (parsed.attachments || []).filter((a) => ALLOWED_MIME.includes(a.contentType));
          let inboundId = null;
          let count = 0;
          for (const att of atts) {
            // eslint-disable-next-line no-await-in-loop
            const filePath = await saveAttachment(att);
            // eslint-disable-next-line no-await-in-loop
            const doc = await expenseService.recordInboundDocument({ source: 'email', filePath, originalFilename: att.filename || 'attachment', mimeType: att.contentType }, null);
            inboundId = doc.id; count += 1;
          }
          await db('received_emails').insert({
            message_id: messageId,
            from_address: (parsed.from && parsed.from.text) || null,
            subject: parsed.subject || null,
            received_at: parsed.date || new Date(),
            attachment_count: count,
            status: count > 0 ? 'ingested' : 'no_attachment',
            inbound_document_id: inboundId,
            created_at: new Date(),
          });
          await client.messageFlagsAdd(msg.uid, ['\\Seen'], { uid: true });
          processed += 1;
        } catch (e) {
          logger.error?.(`emailIntake: message uid ${msg.uid} failed: ${e.message}`);
          try {
            await db('received_emails').insert({ message_id: `err-${msg.uid}-${Date.now()}`, status: 'error', error: e.message, attachment_count: 0, received_at: new Date(), created_at: new Date() });
          } catch (_e) { /* ignore */ }
        }
      }
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (e) {
    logger.error?.(`emailIntake: poll failed: ${e.message}`);
    try { await client.close(); } catch (_e) { /* ignore */ }
  } finally {
    polling = false;
  }
  return { processed };
}

/** Start the 1-minute poll loop (mirrors the outgoing queue cadence). */
function startIncomingMailPoller() {
  const run = () => pollOnce().catch((e) => logger.error?.(`emailIntake: ${e.message}`));
  setTimeout(run, 15000); // first run shortly after boot
  setInterval(run, 60 * 1000);
  logger.info?.('Incoming-mail poller started (every 60s when enabled)');
}

module.exports = { pollOnce, startIncomingMailPoller, listFolders, _internal: { getImapConfig, isEnabled, saveAttachment } };
