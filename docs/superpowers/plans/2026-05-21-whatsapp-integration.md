# WhatsApp Business API Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a WhatsApp notification channel that fires when a gallery is created/published, mirroring the existing email flow, with a resend button in EventDetailsPage and configuration under Settings → Communication → Configurações de Mensagens.

**Architecture:** New `whatsapp_queue` table and `whatsappProcessor.js` service mirror the email queue pattern exactly. `whatsappService.js` wraps the Meta Cloud API (axios POST to `graph.facebook.com`). Frontend adds a new Settings tab (`MessagingConfigPage`) and a resend button alongside the existing email resend.

**Tech Stack:** Node.js (CommonJS) + axios + Knex (SQLite) / React 18 + TypeScript + React Query + react-i18next

---

## File Map

### New — Backend
| File | Responsibility |
|------|---------------|
| `backend/src/services/whatsappService.js` | Phone E.164 normalisation + Meta Cloud API call |
| `backend/src/services/whatsappProcessor.js` | Queue polling (30s), retry logic, `queueWhatsapp()` helper |
| `backend/src/routes/adminWhatsapp.js` | GET/PUT `/api/admin/whatsapp-config`, POST `/api/admin/whatsapp-config/test` |
| `backend/migrations/core/107_create_whatsapp_tables.js` | `whatsapp_configs` + `whatsapp_queue` tables |
| `backend/__tests__/services/whatsappService.test.js` | Unit tests for normalisation + API wrapper |
| `backend/__tests__/services/whatsappProcessor.test.js` | Unit tests for queue logic |
| `backend/__tests__/routes/adminWhatsapp.test.js` | Route tests for config endpoints |

### New — Frontend
| File | Responsibility |
|------|---------------|
| `frontend/src/services/whatsappConfig.service.ts` | API calls for config (get/update/test) |
| `frontend/src/pages/admin/MessagingConfigPage.tsx` | Settings tab UI |

### Modified — Backend
| File | Change |
|------|--------|
| `backend/server.js` | Register `adminWhatsapp` route + `startWhatsAppQueueProcessor` |
| `backend/src/routes/adminEvents.js` | Add `POST /:id/resend-whatsapp` + `queueWhatsapp()` in creation/publish flow |

### Modified — Frontend
| File | Change |
|------|--------|
| `frontend/src/pages/admin/SettingsPage.tsx` | Add `messaging` tab to Communication group |
| `frontend/src/pages/admin/EventDetailsPage.tsx` | Add resend WhatsApp button |
| `frontend/src/i18n/locales/en.json` | New i18n keys |
| `frontend/src/i18n/locales/de.json` | New i18n keys |
| `frontend/src/i18n/locales/pt.json` | New i18n keys |
| `frontend/src/i18n/locales/ru.json` | New i18n keys |
| `frontend/src/i18n/locales/nl.json` | New i18n keys |
| `frontend/src/i18n/locales/fr.json` | New i18n keys |
| `frontend/src/i18n/locales/es.json` | New i18n keys |

---

## Task 1: Database Migration

**Files:**
- Create: `backend/migrations/core/107_create_whatsapp_tables.js`

- [ ] **Step 1: Write the migration**

```js
// backend/migrations/core/107_create_whatsapp_tables.js
'use strict';

exports.up = async function(knex) {
  // whatsapp_configs — credentials and template name
  if (!(await knex.schema.hasTable('whatsapp_configs'))) {
    await knex.schema.createTable('whatsapp_configs', (table) => {
      table.increments('id').primary();
      table.string('phone_number_id', 255).notNullable().defaultTo('');
      table.string('waba_id', 255).notNullable().defaultTo('');
      table.string('access_token', 1000).notNullable().defaultTo('');
      table.string('template_name', 255).notNullable().defaultTo('gallery_ready');
      table.boolean('enabled').defaultTo(false);
      table.datetime('updated_at').defaultTo(knex.fn.now());
    });
  }

  // whatsapp_queue — outbound message queue
  if (!(await knex.schema.hasTable('whatsapp_queue'))) {
    await knex.schema.createTable('whatsapp_queue', (table) => {
      table.increments('id').primary();
      table.integer('event_id').references('id').inTable('events');
      table.string('recipient_phone', 50).notNullable();
      table.string('message_type', 50).notNullable();
      table.json('message_data');
      table.string('status', 20).defaultTo('pending');
      table.integer('retry_count').defaultTo(0);
      table.datetime('created_at').defaultTo(knex.fn.now());
      table.datetime('scheduled_at').defaultTo(knex.fn.now());
      table.datetime('sent_at');
      table.text('error_message');
    });
  }
};

exports.down = async function(knex) {
  await knex.schema.dropTableIfExists('whatsapp_queue');
  await knex.schema.dropTableIfExists('whatsapp_configs');
};
```

- [ ] **Step 2: Run the migration on the server**

```bash
ssh root@192.168.0.210 "cd /opt/picpeak/app/backend && npm run migrate"
```

Expected output: `Batch N run: 1 migrations`

- [ ] **Step 3: Verify tables exist**

```bash
ssh root@192.168.0.210 "sqlite3 /opt/picpeak/app/backend/data/photo_sharing.db '.schema whatsapp_configs' && sqlite3 /opt/picpeak/app/backend/data/photo_sharing.db '.schema whatsapp_queue'"
```

Expected: both `CREATE TABLE` statements printed.

- [ ] **Step 4: Commit**

```bash
git add backend/migrations/core/107_create_whatsapp_tables.js
git commit -m "feat(whatsapp): add whatsapp_configs and whatsapp_queue migrations"
```

---

## Task 2: `whatsappService.js` — Meta API Wrapper

**Files:**
- Create: `backend/src/services/whatsappService.js`
- Create: `backend/__tests__/services/whatsappService.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// backend/__tests__/services/whatsappService.test.js
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
    expect(normalizePhone('+55 11 9999-9999')).toBe('+55119999999 9');
    // More precisely: strips all non-digits then prepends +
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
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
ssh root@192.168.0.210 "cd /opt/picpeak/app/backend && npx jest __tests__/services/whatsappService.test.js --no-coverage 2>&1 | tail -20"
```

Expected: `Cannot find module '../../src/services/whatsappService'`

- [ ] **Step 3: Write the implementation**

```js
// backend/src/services/whatsappService.js
'use strict';

const axios = require('axios');
const logger = require('../utils/logger');

const META_API_VERSION = 'v19.0';
const META_API_BASE = `https://graph.facebook.com/${META_API_VERSION}`;

/**
 * Normalise a phone string to E.164 (+[digits]).
 * Strips spaces, dashes, parentheses. Adds leading + if missing.
 * Throws 'Invalid phone number' for null/empty/too-short results.
 */
function normalizePhone(phone) {
  if (!phone) throw new Error('Invalid phone number: null or empty');
  // Strip everything except digits and a leading +
  const digits = phone.replace(/[^\d]/g, '');
  if (digits.length < 10) throw new Error(`Invalid phone number: too short after normalisation (${phone})`);
  return `+${digits}`;
}

/**
 * Send a WhatsApp template message via Meta Cloud API.
 *
 * @param {string} recipientPhone  - phone in any format; normalised to E.164
 * @param {{ phone_number_id, access_token, template_name }} config - from whatsapp_configs row
 * @param {string} languageCode    - WhatsApp language code e.g. 'pt_BR', 'en_US'
 * @param {string[]} components    - ordered template body parameters ({{1}}, {{2}}, …)
 * @returns {Promise<{ messageId: string }>}
 */
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
    // Surface Meta's error message when available
    const metaMessage = error.response?.data?.error?.message;
    const msg = metaMessage || error.message;
    logger.error('WhatsApp API error', { error: msg, phone: normalised });
    throw new Error(msg);
  }
}

module.exports = { normalizePhone, sendWhatsAppMessage };
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
ssh root@192.168.0.210 "cd /opt/picpeak/app/backend && npx jest __tests__/services/whatsappService.test.js --no-coverage 2>&1 | tail -15"
```

Expected: `Tests: 7 passed, 7 total`

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/whatsappService.js backend/__tests__/services/whatsappService.test.js
git commit -m "feat(whatsapp): add whatsappService Meta Cloud API wrapper"
```

---

## Task 3: `whatsappProcessor.js` — Queue Processor

**Files:**
- Create: `backend/src/services/whatsappProcessor.js`
- Create: `backend/__tests__/services/whatsappProcessor.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// backend/__tests__/services/whatsappProcessor.test.js
'use strict';

jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));

// Mock the database
const mockDb = {
  insert: jest.fn().mockResolvedValue([1]),
  where: jest.fn().mockReturnThis(),
  andWhere: jest.fn().mockReturnThis(),
  orderBy: jest.fn().mockReturnThis(),
  limit: jest.fn().mockResolvedValue([]),
  update: jest.fn().mockResolvedValue(1),
};
const dbFn = jest.fn(() => mockDb);
jest.mock('../../src/database/db', () => ({ db: dbFn }));

// Mock whatsappService
jest.mock('../../src/services/whatsappService', () => ({
  sendWhatsAppMessage: jest.fn(),
}));

const { db } = require('../../src/database/db');
const { sendWhatsAppMessage } = require('../../src/services/whatsappService');
const { queueWhatsapp, processWhatsAppQueue } = require('../../src/services/whatsappProcessor');

beforeEach(() => {
  jest.clearAllMocks();
  dbFn.mockReturnValue(mockDb);
  mockDb.insert.mockResolvedValue([1]);
  mockDb.limit.mockResolvedValue([]);
  mockDb.update.mockResolvedValue(1);
});

describe('queueWhatsapp', () => {
  it('inserts a pending row into whatsapp_queue', async () => {
    await queueWhatsapp(42, '+5511999999999', 'gallery_created', { customer_name: 'Ana' });

    expect(dbFn).toHaveBeenCalledWith('whatsapp_queue');
    expect(mockDb.insert).toHaveBeenCalledWith(
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
    const call = mockDb.insert.mock.calls[0][0];
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
    mockDb.limit.mockResolvedValue([]);
    // Mock whatsapp_configs too
    dbFn
      .mockReturnValueOnce({ where: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue({ enabled: true, phone_number_id: 'PID', access_token: 'TOKEN', template_name: 'gallery_ready' }) })
      .mockReturnValue(mockDb);

    await processWhatsAppQueue();
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it('marks item as sent on success', async () => {
    const item = makeItem();
    const configMock = { enabled: true, phone_number_id: 'PID', waba_id: 'WABA', access_token: 'TOKEN', template_name: 'gallery_ready' };
    dbFn
      .mockReturnValueOnce({ where: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue(configMock) })
      .mockReturnValueOnce({ ...mockDb, where: jest.fn().mockReturnThis(), andWhere: jest.fn().mockReturnThis(), orderBy: jest.fn().mockReturnThis(), limit: jest.fn().mockResolvedValue([item]) })
      .mockReturnValue(mockDb);

    sendWhatsAppMessage.mockResolvedValueOnce({ messageId: 'wamid.abc' });

    await processWhatsAppQueue();

    expect(mockDb.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'sent' }));
  });

  it('increments retry_count on failure and keeps status pending', async () => {
    const item = makeItem({ retry_count: 1 });
    const configMock = { enabled: true, phone_number_id: 'PID', waba_id: 'WABA', access_token: 'TOKEN', template_name: 'gallery_ready' };
    dbFn
      .mockReturnValueOnce({ where: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue(configMock) })
      .mockReturnValueOnce({ ...mockDb, where: jest.fn().mockReturnThis(), andWhere: jest.fn().mockReturnThis(), orderBy: jest.fn().mockReturnThis(), limit: jest.fn().mockResolvedValue([item]) })
      .mockReturnValue(mockDb);

    sendWhatsAppMessage.mockRejectedValueOnce(new Error('API down'));

    await processWhatsAppQueue();

    expect(mockDb.update).toHaveBeenCalledWith(
      expect.objectContaining({ retry_count: 2, error_message: 'API down' })
    );
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
ssh root@192.168.0.210 "cd /opt/picpeak/app/backend && npx jest __tests__/services/whatsappProcessor.test.js --no-coverage 2>&1 | tail -10"
```

Expected: `Cannot find module '../../src/services/whatsappProcessor'`

- [ ] **Step 3: Write the implementation**

```js
// backend/src/services/whatsappProcessor.js
'use strict';

const { db } = require('../database/db');
const logger = require('../utils/logger');
const { sendWhatsAppMessage } = require('./whatsappService');

// Maps app language codes to WhatsApp template language codes.
// Only pt_BR template exists initially; extend this map when more
// templates are approved.
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

// Resolve language code → WhatsApp language code, falling back to pt_BR
function resolveLanguageCode(lang) {
  return LANGUAGE_MAP[lang] || 'pt_BR';
}

// Format a raw date value (ISO string, Date, or null) to a human-readable
// date string for use in the WhatsApp template parameter.
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

// Build the ordered array of template body parameters from message_data.
// Order must match the approved template: {{1}} name, {{2}} event,
// {{3}} link, {{4}} password line (or ''), {{5}} expiry (or '').
function buildComponents(data) {
  const passwordLine = data.gallery_password && data.gallery_password !== 'No password required'
    ? `🔒 Senha: ${data.gallery_password}`
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

// Get WhatsApp config from DB (null if not found or disabled)
async function getWhatsAppConfig() {
  try {
    return await db('whatsapp_configs').where('id', 1).first();
  } catch (error) {
    logger.debug('whatsappProcessor: failed to read whatsapp_configs', { error: error.message });
    return null;
  }
}

/**
 * Queue a WhatsApp message for async delivery.
 * Mirrors queueEmail() from emailProcessor.js.
 */
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
    logger.info(`WhatsApp queued: ${messageType} → ${recipientPhone}`);
  } catch (error) {
    logger.error('Error queueing WhatsApp message:', error);
    throw error;
  }
}

// Process up to 10 pending items from the queue.
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

    logger.info(`WhatsApp queue: processing ${pending.length} messages`);

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

        logger.info(`WhatsApp message ${item.id} sent`);
      } catch (error) {
        await db('whatsapp_queue')
          .where('id', item.id)
          .update({ retry_count: item.retry_count + 1, error_message: error.message });

        logger.error(`WhatsApp message ${item.id} failed:`, error);
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
  // Process immediately on start
  processWhatsAppQueue().catch((err) => {
    logger.error('WhatsApp queue processor: initial run failed:', err);
  });
  // Then every 30 seconds
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
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
ssh root@192.168.0.210 "cd /opt/picpeak/app/backend && npx jest __tests__/services/whatsappProcessor.test.js --no-coverage 2>&1 | tail -15"
```

Expected: `Tests: 5 passed, 5 total`

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/whatsappProcessor.js backend/__tests__/services/whatsappProcessor.test.js
git commit -m "feat(whatsapp): add whatsappProcessor queue service"
```

---

## Task 4: `adminWhatsapp.js` — Config Routes

**Files:**
- Create: `backend/src/routes/adminWhatsapp.js`
- Create: `backend/__tests__/routes/adminWhatsapp.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// backend/__tests__/routes/adminWhatsapp.test.js
'use strict';

jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));

// Mock auth middleware — pass through
jest.mock('../../src/middleware/auth', () => ({
  adminAuth: (req, _res, next) => { req.admin = { id: 1, username: 'admin', roleName: 'super_admin' }; next(); },
}));
jest.mock('../../src/middleware/permissions', () => ({
  requirePermission: () => (_req, _res, next) => next(),
}));

// Mock db
const mockFirstConfig = jest.fn();
const mockDbUpdate = jest.fn().mockResolvedValue(1);
const mockDbInsert = jest.fn().mockResolvedValue([1]);
const mockDbWhere = jest.fn().mockReturnThis();
const dbChain = { first: mockFirstConfig, where: mockDbWhere, update: mockDbUpdate, insert: mockDbInsert };
const dbFn = jest.fn(() => dbChain);
jest.mock('../../src/database/db', () => ({
  db: dbFn,
  logActivity: jest.fn().mockResolvedValue(undefined),
}));

// Mock whatsappService for the test endpoint
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
  dbFn.mockReturnValue(dbChain);
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
    mockFirstConfig.mockResolvedValueOnce(null); // no existing record
    const res = await request(app).put('/config').send({
      phone_number_id: 'PID', waba_id: 'WABA',
      access_token: 'newtoken', template_name: 'gallery_ready', enabled: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockDbInsert).toHaveBeenCalled();
  });

  it('does not update access_token when value is ********', async () => {
    mockFirstConfig.mockResolvedValueOnce({ id: 1 }); // existing record
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
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
ssh root@192.168.0.210 "cd /opt/picpeak/app/backend && npx jest __tests__/routes/adminWhatsapp.test.js --no-coverage 2>&1 | tail -10"
```

Expected: `Cannot find module '../../src/routes/adminWhatsapp'`

- [ ] **Step 3: Write the implementation**

```js
// backend/src/routes/adminWhatsapp.js
'use strict';

const express = require('express');
const { db, logActivity } = require('../database/db');
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { sendWhatsAppMessage } = require('../services/whatsappService');
const logger = require('../utils/logger');

const router = express.Router();

// GET /api/admin/whatsapp-config
router.get('/config', adminAuth, requirePermission('settings.view'), async (req, res) => {
  try {
    const config = await db('whatsapp_configs').first();
    if (!config) {
      return res.json({
        phone_number_id: '',
        waba_id: '',
        access_token: '',
        template_name: 'gallery_ready',
        enabled: false,
      });
    }
    res.json({
      phone_number_id: config.phone_number_id,
      waba_id: config.waba_id,
      access_token: config.access_token ? '********' : '',
      template_name: config.template_name,
      enabled: Boolean(config.enabled),
    });
  } catch (error) {
    logger.error('GET whatsapp-config error:', error);
    res.status(500).json({ error: 'Failed to load WhatsApp configuration' });
  }
});

// PUT /api/admin/whatsapp-config
router.put('/config', adminAuth, requirePermission('settings.edit'), async (req, res) => {
  try {
    const { phone_number_id, waba_id, access_token, template_name, enabled } = req.body;

    const existing = await db('whatsapp_configs').first();

    const data = {
      phone_number_id: phone_number_id || '',
      waba_id: waba_id || '',
      template_name: template_name || 'gallery_ready',
      enabled: Boolean(enabled),
      updated_at: new Date(),
    };

    // Only update token if a real value was provided (not the masked placeholder)
    if (access_token && access_token !== '********') {
      data.access_token = access_token;
    }

    if (existing) {
      await db('whatsapp_configs').where('id', existing.id).update(data);
    } else {
      if (!data.access_token) data.access_token = '';
      await db('whatsapp_configs').insert(data);
    }

    await logActivity(
      'whatsapp_config_updated',
      { phone_number_id, enabled },
      null,
      { type: 'admin', id: req.admin.id, name: req.admin.username }
    );

    res.json({ success: true });
  } catch (error) {
    logger.error('PUT whatsapp-config error:', error);
    res.status(500).json({ error: 'Failed to save WhatsApp configuration' });
  }
});

// POST /api/admin/whatsapp-config/test
// Body: { phone: string }
router.post('/test', adminAuth, requirePermission('settings.edit'), async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) {
      return res.status(400).json({ error: 'Phone number is required' });
    }

    const config = await db('whatsapp_configs').first();
    if (!config || !config.phone_number_id || !config.access_token) {
      return res.status(400).json({ error: 'WhatsApp is not configured' });
    }

    // Send a test message using a minimal parameter set
    const testComponents = [
      'Test User',
      'Test Gallery',
      'https://example.com/gallery/test',
      '',
      '',
    ];

    const result = await sendWhatsAppMessage(phone, config, 'pt_BR', testComponents);
    res.json({ success: true, messageId: result.messageId });
  } catch (error) {
    logger.error('WhatsApp test send error:', error);
    res.status(500).json({ error: error.message || 'Failed to send test message' });
  }
});

module.exports = router;
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
ssh root@192.168.0.210 "cd /opt/picpeak/app/backend && npx jest __tests__/routes/adminWhatsapp.test.js --no-coverage 2>&1 | tail -15"
```

Expected: `Tests: 7 passed, 7 total`

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/adminWhatsapp.js backend/__tests__/routes/adminWhatsapp.test.js
git commit -m "feat(whatsapp): add adminWhatsapp config routes"
```

---

## Task 5: Register in `server.js`

**Files:**
- Modify: `backend/server.js`

- [ ] **Step 1: Add processor import (line ~23, after emailProcessor require)**

Find the block:
```js
const { initializeTransporter, startEmailQueueProcessor } = require('./src/services/emailProcessor');
```

Add immediately after:
```js
const { startWhatsAppQueueProcessor } = require('./src/services/whatsappProcessor');
```

- [ ] **Step 2: Register the route (after line ~628, near other admin routes)**

Find:
```js
app.use('/api/admin/webhooks', require('./src/routes/adminWebhooks'));
```

Add immediately after:
```js
app.use('/api/admin/whatsapp', require('./src/routes/adminWhatsapp'));
```

- [ ] **Step 3: Start the background processor (after line ~735, after startEmailQueueProcessor)**

Find:
```js
    startEmailQueueProcessor();
```

Add immediately after:
```js
    startWhatsAppQueueProcessor();
```

- [ ] **Step 4: Restart backend and verify no errors**

```bash
ssh root@192.168.0.210 "systemctl restart picpeak-backend && sleep 3 && tail -20 /opt/picpeak/logs/backend.log"
```

Expected: `WhatsApp queue processor started` in logs, no error lines.

- [ ] **Step 5: Smoke-test the new route**

```bash
# Get a valid admin token first (or use curl with existing session)
ssh root@192.168.0.210 "curl -s -X GET http://localhost:7101/api/admin/whatsapp/config -H 'Authorization: Bearer <ADMIN_TOKEN>' | python3 -m json.tool"
```

Expected: JSON with `phone_number_id: ""`, `enabled: false`.

- [ ] **Step 6: Commit**

```bash
git add backend/server.js
git commit -m "feat(whatsapp): register WhatsApp route and queue processor in server.js"
```

---

## Task 6: `adminEvents.js` — Resend Route + Creation Flow

**Files:**
- Modify: `backend/src/routes/adminEvents.js`

- [ ] **Step 1: Add `queueWhatsapp` and `getWhatsAppConfig` imports at top**

Find the existing require block at the top of `adminEvents.js`:
```js
const { queueEmail } = require('../services/emailProcessor');
```

Add immediately after:
```js
const { queueWhatsapp, getWhatsAppConfig } = require('../services/whatsappProcessor');
```

- [ ] **Step 2: Add `POST /:id/resend-whatsapp` route**

Find the existing `resend-email` route (around line 1588):
```js
// Resend creation email
router.post('/:id/resend-email', adminAuth, requirePermission('events.edit'), requireEventOwnership, async (req, res) => {
```

Add the following **after** the closing `});` of the `resend-email` route:

```js
// Resend WhatsApp notification
router.post('/:id/resend-whatsapp', adminAuth, requirePermission('events.edit'), requireEventOwnership, async (req, res) => {
  try {
    const { id } = req.params;

    const event = await db('events').where('id', id).first();
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    if (!event.customer_phone) {
      return res.status(400).json({ error: 'No phone number on this event' });
    }

    const waConfig = await getWhatsAppConfig();
    if (!waConfig || !waConfig.enabled) {
      return res.status(400).json({ error: 'WhatsApp notifications are not enabled' });
    }

    const recipientName = event.customer_name || event.host_name || '';
    const { shareUrl } = await buildShareLinkVariants({ slug: event.slug, shareToken: event.share_token });

    await queueWhatsapp(id, event.customer_phone, 'gallery_created', {
      customer_name: recipientName,
      event_name: event.event_name,
      gallery_link: shareUrl,
      gallery_password: req.body?.password || '',
      expiry_date: event.expires_at || null,
    });

    try {
      await logActivity('whatsapp_resent', {
        recipient: event.customer_phone,
        ip_address: req.ip || '0.0.0.0',
        user_agent: req.get('user-agent') || 'Unknown',
      }, id, { type: 'admin', id: req.admin.id, name: req.admin.username });
    } catch (logError) {
      logger.warn('Failed to log whatsapp_resent activity:', logError);
    }

    res.json({ success: true, message: 'WhatsApp message queued for sending' });
  } catch (error) {
    logger.error('Error resending WhatsApp:', error);
    res.status(500).json({ error: 'Failed to resend WhatsApp notification' });
  }
});
```

- [ ] **Step 3: Add `queueWhatsapp` call in the direct creation flow**

Find the block in the creation route (`router.post('/')`) where `email_queue` is directly inserted (around line 786):
```js
      await db('email_queue').insert({
        event_id: eventId,
        recipient_email: customerEmail,
        email_type: 'gallery_created',
        email_data: JSON.stringify(emailData),
        status: 'pending',
        created_at: new Date()
        // scheduled_at will use default value
      });
    }
```

Add immediately after the closing `}` of the `if (customerEmail && !isDraft)` block that contains the above insert:

```js
    // Queue WhatsApp notification when phone is available
    if (!isDraft) {
      try {
        const waConfig = await getWhatsAppConfig();
        if (waConfig?.enabled && customerPhone) {
          await queueWhatsapp(eventId, customerPhone, 'gallery_created', {
            customer_name: customerName || '',
            event_name,
            gallery_link: shareUrl,
            gallery_password: requirePassword ? password : '',
            expiry_date: expires_at ? expires_at.toISOString() : null,
          });
        }
      } catch (waError) {
        logger.warn('Failed to queue WhatsApp notification on creation', { error: waError.message });
      }
    }
```

- [ ] **Step 4: Add `queueWhatsapp` call in the draft publish flow**

Find the publish route (`router.post('/:id/publish')`), specifically the block where `email_queue` is inserted (around line 1058):
```js
      await db('email_queue').insert({
        event_id: id,
        recipient_email: customerEmail,
        email_type: 'gallery_created',
        email_data: JSON.stringify(emailData),
        status: 'pending',
        created_at: new Date()
      });
    }
```

Add immediately after the closing `}` of the `if (customerEmail)` block:

```js
    // Queue WhatsApp notification on publish
    try {
      const waConfig = await getWhatsAppConfig();
      if (waConfig?.enabled && event.customer_phone) {
        const { shareUrl: waShareUrl } = await buildShareLinkVariants({ slug: event.slug, shareToken: event.share_token });
        await queueWhatsapp(id, event.customer_phone, 'gallery_created', {
          customer_name: event.customer_name || event.host_name || '',
          event_name: event.event_name,
          gallery_link: waShareUrl,
          gallery_password: '',
          expiry_date: event.expires_at || null,
        });
      }
    } catch (waError) {
      logger.warn('Failed to queue WhatsApp notification on publish', { error: waError.message });
    }
```

- [ ] **Step 5: Restart backend and verify no errors**

```bash
ssh root@192.168.0.210 "systemctl restart picpeak-backend && sleep 3 && tail -10 /opt/picpeak/logs/backend.log"
```

Expected: server starts without errors.

- [ ] **Step 6: Run existing backend tests to catch regressions**

```bash
ssh root@192.168.0.210 "cd /opt/picpeak/app/backend && npm test 2>&1 | tail -20"
```

Expected: all tests pass (no failures introduced by this change).

- [ ] **Step 7: Commit**

```bash
git add backend/src/routes/adminEvents.js
git commit -m "feat(whatsapp): add resend-whatsapp route and queue calls in creation/publish flow"
```

---

## Task 7: Frontend — `whatsappConfig.service.ts`

**Files:**
- Create: `frontend/src/services/whatsappConfig.service.ts`

- [ ] **Step 1: Write the service**

```ts
// frontend/src/services/whatsappConfig.service.ts
import { api } from '../config/api';

export interface WhatsAppConfig {
  phone_number_id: string;
  waba_id: string;
  access_token: string;
  template_name: string;
  enabled: boolean;
}

export const whatsappConfigService = {
  async getConfig(): Promise<WhatsAppConfig> {
    const response = await api.get('/admin/whatsapp/config');
    return response.data;
  },

  async updateConfig(data: Partial<WhatsAppConfig>): Promise<{ success: boolean }> {
    const response = await api.put('/admin/whatsapp/config', data);
    return response.data;
  },

  async testConfig(phone: string): Promise<{ success: boolean; messageId?: string }> {
    const response = await api.post('/admin/whatsapp/test', { phone });
    return response.data;
  },
};
```

- [ ] **Step 2: Verify TypeScript compiles (no errors)**

```bash
cd D:\projects\picpeak\frontend && npx tsc --noEmit 2>&1 | head -20
```

Expected: no output (no errors).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/services/whatsappConfig.service.ts
git commit -m "feat(whatsapp): add whatsappConfig.service.ts"
```

---

## Task 8: Frontend — `MessagingConfigPage.tsx`

**Files:**
- Create: `frontend/src/pages/admin/MessagingConfigPage.tsx`

- [ ] **Step 1: Write the component**

```tsx
// frontend/src/pages/admin/MessagingConfigPage.tsx
import React, { useState } from 'react';
import {
  MessageCircle,
  Save,
  Send,
  Eye,
  EyeOff,
  CheckCircle,
  AlertCircle,
} from 'lucide-react';
import { toast } from 'react-toastify';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button, Input, Card, Loading } from '../../components/common';
import { whatsappConfigService, type WhatsAppConfig } from '../../services/whatsappConfig.service';

const WHATSAPP_CONFIG_QUERY_KEY = ['whatsapp-config'] as const;

export const MessagingConfigPage: React.FC = () => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [showToken, setShowToken] = useState(false);
  const [testPhone, setTestPhone] = useState('');
  const [showTestModal, setShowTestModal] = useState(false);

  const [form, setForm] = useState<WhatsAppConfig>({
    phone_number_id: '',
    waba_id: '',
    access_token: '',
    template_name: 'gallery_ready',
    enabled: false,
  });

  const { isLoading } = useQuery({
    queryKey: WHATSAPP_CONFIG_QUERY_KEY,
    queryFn: () => whatsappConfigService.getConfig(),
    onSuccess: (data) => setForm(data),
  });

  const saveMutation = useMutation({
    mutationFn: (data: Partial<WhatsAppConfig>) => whatsappConfigService.updateConfig(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: WHATSAPP_CONFIG_QUERY_KEY });
      toast.success(t('settings.messaging.saved', 'WhatsApp settings saved'));
    },
    onError: () => {
      toast.error(t('settings.messaging.saveFailed', 'Failed to save settings'));
    },
  });

  const testMutation = useMutation({
    mutationFn: (phone: string) => whatsappConfigService.testConfig(phone),
    onSuccess: () => {
      toast.success(t('settings.messaging.testSent', 'Test message sent!'));
      setShowTestModal(false);
      setTestPhone('');
    },
    onError: (err: any) => {
      toast.error(err?.response?.data?.error || t('settings.messaging.testFailed', 'Test message failed'));
    },
  });

  if (isLoading) return <Loading />;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <MessageCircle className="w-6 h-6 text-primary-600" />
        <div>
          <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">
            {t('settings.messaging.title', 'Configurações de Mensagens')}
          </h1>
          <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">
            {t('settings.messaging.description', 'Configure WhatsApp Business API to notify clients when their gallery is ready.')}
          </p>
        </div>
      </div>

      <Card padding="md">
        <div className="space-y-6">
          {/* Enable toggle */}
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
                {t('settings.messaging.enableWhatsApp', 'Ativar envio por WhatsApp')}
              </label>
              <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                {t('settings.messaging.enableDescription', 'Send WhatsApp notification when a gallery is created or published')}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setForm((f) => ({ ...f, enabled: !f.enabled }))}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-primary-500 ${
                form.enabled ? 'bg-primary-600' : 'bg-neutral-300 dark:bg-neutral-600'
              }`}
              aria-pressed={form.enabled}
            >
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${form.enabled ? 'translate-x-6' : 'translate-x-1'}`} />
            </button>
          </div>

          <hr className="border-neutral-200 dark:border-neutral-700" />

          {/* Phone Number ID */}
          <Input
            label={t('settings.messaging.phoneNumberId', 'Phone Number ID')}
            value={form.phone_number_id}
            onChange={(e) => setForm((f) => ({ ...f, phone_number_id: e.target.value }))}
            placeholder="123456789012345"
            helperText={t('settings.messaging.phoneNumberIdHelp', 'From Meta for Developers → WhatsApp → Getting Started')}
          />

          {/* WABA ID */}
          <Input
            label={t('settings.messaging.wabaId', 'WhatsApp Business Account ID')}
            value={form.waba_id}
            onChange={(e) => setForm((f) => ({ ...f, waba_id: e.target.value }))}
            placeholder="123456789012345"
            helperText={t('settings.messaging.wabaIdHelp', 'Found in your Meta Business Manager')}
          />

          {/* Access Token */}
          <div>
            <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-200 mb-1">
              {t('settings.messaging.accessToken', 'Access Token')}
            </label>
            <div className="relative">
              <Input
                type={showToken ? 'text' : 'password'}
                value={form.access_token}
                onChange={(e) => setForm((f) => ({ ...f, access_token: e.target.value }))}
                placeholder="EAAxxxxxxxx..."
                helperText={t('settings.messaging.accessTokenHelp', 'System User token with whatsapp_business_messaging permission')}
              />
              <button
                type="button"
                className="absolute right-3 top-2.5 text-neutral-400 hover:text-neutral-600"
                onClick={() => setShowToken((v) => !v)}
                aria-label={showToken ? 'Hide token' : 'Show token'}
              >
                {showToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {/* Template Name */}
          <Input
            label={t('settings.messaging.templateName', 'Nome do Template')}
            value={form.template_name}
            onChange={(e) => setForm((f) => ({ ...f, template_name: e.target.value }))}
            placeholder="gallery_ready"
            helperText={t('settings.messaging.templateNameHelp', 'Exact name of the approved template in Meta Business Manager')}
          />

          {/* Actions */}
          <div className="flex gap-3 pt-2">
            <Button
              variant="primary"
              leftIcon={<Save className="w-4 h-4" />}
              onClick={() => saveMutation.mutate(form)}
              disabled={saveMutation.isPending}
            >
              {saveMutation.isPending
                ? t('common.saving', 'Saving...')
                : t('common.save', 'Save')}
            </Button>

            <Button
              variant="outline"
              leftIcon={<Send className="w-4 h-4" />}
              onClick={() => setShowTestModal(true)}
              disabled={!form.phone_number_id || !form.access_token || form.access_token === ''}
            >
              {t('settings.messaging.testButton', 'Testar')}
            </Button>
          </div>
        </div>
      </Card>

      {/* Test Modal */}
      {showTestModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowTestModal(false)}>
          <div className="bg-white dark:bg-neutral-800 rounded-xl p-6 w-full max-w-md shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-4">
              {t('settings.messaging.testModalTitle', 'Enviar mensagem de teste')}
            </h2>
            <Input
              label={t('settings.messaging.testPhoneLabel', 'Número de telefone (formato internacional)')}
              value={testPhone}
              onChange={(e) => setTestPhone(e.target.value)}
              placeholder="+5511999999999"
            />
            <div className="flex gap-3 mt-4">
              <Button
                variant="primary"
                onClick={() => testMutation.mutate(testPhone)}
                disabled={!testPhone || testMutation.isPending}
              >
                {testMutation.isPending
                  ? t('common.sending', 'Enviando...')
                  : t('settings.messaging.testSendButton', 'Enviar')}
              </Button>
              <Button variant="outline" onClick={() => setShowTestModal(false)}>
                {t('common.cancel', 'Cancelar')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd D:\projects\picpeak\frontend && npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/admin/MessagingConfigPage.tsx
git commit -m "feat(whatsapp): add MessagingConfigPage settings tab"
```

---

## Task 9: Frontend — Wire `messaging` Tab into `SettingsPage.tsx`

**Files:**
- Modify: `frontend/src/pages/admin/SettingsPage.tsx`

- [ ] **Step 1: Add `MessagingConfigPage` import**

Find:
```ts
import { EmailConfigPage } from './EmailConfigPage';
```

Add immediately after:
```ts
import { MessagingConfigPage } from './MessagingConfigPage';
```

- [ ] **Step 2: Add `MessageCircle` to lucide-react imports**

Find the lucide-react import line (it already has `Mail`). Add `MessageCircle` to the same import:
```ts
import { ..., Mail, MessageCircle, ... } from 'lucide-react';
```

- [ ] **Step 3: Add `'messaging'` to `TabType` union**

Find:
```ts
  | 'email'
```

Add after it:
```ts
  | 'messaging'
```

- [ ] **Step 4: Add `'messaging'` to `ALL_TAB_KEYS`**

Find:
```ts
  'email', 'moderation',
```

Change to:
```ts
  'email', 'messaging', 'moderation',
```

- [ ] **Step 5: Add `'messaging'` to `TABS_WITH_OWN_HEADER`**

Find:
```ts
  const TABS_WITH_OWN_HEADER: TabType[] = ['features', 'email', 'branding', 'eventTypes', 'backup', 'cms'];
```

Change to:
```ts
  const TABS_WITH_OWN_HEADER: TabType[] = ['features', 'email', 'messaging', 'branding', 'eventTypes', 'backup', 'cms'];
```

- [ ] **Step 6: Add tab item to Communication group**

Find:
```ts
        { key: 'email',      label: t('settings.email.title',      'Email Settings'), icon: Mail },
        { key: 'moderation', label: t('settings.moderation.title', 'Moderation'),     icon: Flag },
```

Change to:
```ts
        { key: 'email',      label: t('settings.email.title',      'Email Settings'), icon: Mail },
        { key: 'messaging',  label: t('settings.messaging.title',  'Configurações de Mensagens'), icon: MessageCircle },
        { key: 'moderation', label: t('settings.moderation.title', 'Moderation'),     icon: Flag },
```

- [ ] **Step 7: Add render case**

Find:
```tsx
          {activeTab === 'email' && <EmailConfigPage />}
```

Add immediately after:
```tsx
          {activeTab === 'messaging' && <MessagingConfigPage />}
```

- [ ] **Step 8: Verify TypeScript compiles**

```bash
cd D:\projects\picpeak\frontend && npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/pages/admin/SettingsPage.tsx
git commit -m "feat(whatsapp): add messaging tab to Settings Communication group"
```

---

## Task 10: Frontend — Resend WhatsApp Button in `EventDetailsPage.tsx`

**Files:**
- Modify: `frontend/src/pages/admin/EventDetailsPage.tsx`

- [ ] **Step 1: Add `MessageCircle` to lucide-react import in `EventDetailsPage.tsx`**

Find the lucide-react import (it already imports `Mail`). Add `MessageCircle`:
```ts
import { ..., Mail, MessageCircle, ... } from 'lucide-react';
```

- [ ] **Step 2: Add WhatsApp config query**

Find where `useQuery` is used for event data near the top of the component. Add a new query below the existing ones:

```tsx
  const { data: whatsappConfig } = useQuery({
    queryKey: ['whatsapp-config'],
    queryFn: () => whatsappConfigService.getConfig(),
    staleTime: 60_000,
  });
  const whatsappEnabled = Boolean(whatsappConfig?.enabled);
```

- [ ] **Step 3: Add `whatsappConfigService` import**

Find:
```ts
import { eventsService } from '../../services/events.service';
```

Add after:
```ts
import { whatsappConfigService } from '../../services/whatsappConfig.service';
```

- [ ] **Step 4: Add `resendWhatsApp` to `eventsService` calls**

Open `frontend/src/services/events.service.ts`. After the `resendCreationEmail` method, add:

```ts
  async resendWhatsApp(eventId: number): Promise<{ success: boolean; message: string }> {
    const response = await api.post(`/admin/events/${eventId}/resend-whatsapp`);
    return response.data;
  },
```

- [ ] **Step 5: Add the resend WhatsApp button in `EventDetailsPage.tsx`**

Find the existing resend email button:
```tsx
                <Button
                  variant="outline"
                  size="sm"
                  leftIcon={<Mail className="w-4 h-4" />}
                  onClick={async () => {
                    try {
                      await eventsService.resendCreationEmail(event.id);
                      toast.success(t('events.creationEmailResent'));
                    } catch {
                      toast.error(t('events.failedToResendEmail'));
                    }
                  }}
                  className="w-full justify-center"
                >
                  {t('events.resendCreationEmail')}
                </Button>
```

Add immediately after:
```tsx
                {event.customer_phone && whatsappEnabled && (
                  <Button
                    variant="outline"
                    size="sm"
                    leftIcon={<MessageCircle className="w-4 h-4" />}
                    onClick={async () => {
                      try {
                        await eventsService.resendWhatsApp(event.id);
                        toast.success(t('events.whatsappResent'));
                      } catch {
                        toast.error(t('events.failedToResendWhatsApp'));
                      }
                    }}
                    className="w-full justify-center"
                  >
                    {t('events.resendWhatsApp')}
                  </Button>
                )}
```

- [ ] **Step 6: Verify TypeScript compiles**

```bash
cd D:\projects\picpeak\frontend && npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/pages/admin/EventDetailsPage.tsx frontend/src/services/events.service.ts
git commit -m "feat(whatsapp): add resend WhatsApp button to EventDetailsPage"
```

---

## Task 11: i18n — Add New Keys to All 7 Locale Files

**Files:**
- Modify: `frontend/src/i18n/locales/en.json`
- Modify: `frontend/src/i18n/locales/de.json`
- Modify: `frontend/src/i18n/locales/pt.json`
- Modify: `frontend/src/i18n/locales/ru.json`
- Modify: `frontend/src/i18n/locales/nl.json`
- Modify: `frontend/src/i18n/locales/fr.json`
- Modify: `frontend/src/i18n/locales/es.json`

In each file, find the `"events"` key object and add:

- [ ] **Step 1: Add event keys in `en.json`**

```json
"resendWhatsApp": "Resend WhatsApp",
"whatsappResent": "WhatsApp message sent",
"failedToResendWhatsApp": "Failed to resend WhatsApp"
```

- [ ] **Step 2: Add event keys in `de.json`**

```json
"resendWhatsApp": "WhatsApp erneut senden",
"whatsappResent": "WhatsApp-Nachricht gesendet",
"failedToResendWhatsApp": "WhatsApp erneut senden fehlgeschlagen"
```

- [ ] **Step 3: Add event keys in `pt.json`**

```json
"resendWhatsApp": "Reenviar WhatsApp",
"whatsappResent": "Mensagem WhatsApp enviada",
"failedToResendWhatsApp": "Falha ao reenviar WhatsApp"
```

- [ ] **Step 4: Add event keys in `ru.json`**

```json
"resendWhatsApp": "Повторно отправить WhatsApp",
"whatsappResent": "Сообщение WhatsApp отправлено",
"failedToResendWhatsApp": "Не удалось отправить WhatsApp"
```

- [ ] **Step 5: Add event keys in `nl.json`**

```json
"resendWhatsApp": "WhatsApp opnieuw sturen",
"whatsappResent": "WhatsApp-bericht verzonden",
"failedToResendWhatsApp": "WhatsApp opnieuw sturen mislukt"
```

- [ ] **Step 6: Add event keys in `fr.json`**

```json
"resendWhatsApp": "Renvoyer WhatsApp",
"whatsappResent": "Message WhatsApp envoyé",
"failedToResendWhatsApp": "Échec du renvoi WhatsApp"
```

- [ ] **Step 7: Add event keys in `es.json`**

```json
"resendWhatsApp": "Reenviar WhatsApp",
"whatsappResent": "Mensaje de WhatsApp enviado",
"failedToResendWhatsApp": "Error al reenviar WhatsApp"
```

For each file, also add the `settings.messaging` section. Find the `"settings"` key and add inside it:

```json
"messaging": {
  "title": "<see table below>",
  "description": "<see table below>",
  "enableWhatsApp": "<see table below>",
  "enableDescription": "<see table below>",
  "phoneNumberId": "Phone Number ID",
  "phoneNumberIdHelp": "<see table below>",
  "wabaId": "WhatsApp Business Account ID",
  "wabaIdHelp": "<see table below>",
  "accessToken": "Access Token",
  "accessTokenHelp": "<see table below>",
  "templateName": "<see table below>",
  "templateNameHelp": "<see table below>",
  "testButton": "<see table below>",
  "testModalTitle": "<see table below>",
  "testPhoneLabel": "<see table below>",
  "testSendButton": "<see table below>",
  "saved": "<see table below>",
  "saveFailed": "<see table below>",
  "testSent": "<see table below>",
  "testFailed": "<see table below>"
}
```

| Key | en | de | pt | ru | nl | fr | es |
|-----|----|----|----|----|----|----|-----|
| `title` | Message Settings | Nachrichteneinstellungen | Configurações de Mensagens | Настройки сообщений | Berichtinstellingen | Paramètres de messagerie | Configuración de mensajes |
| `description` | Configure WhatsApp Business API... | WhatsApp Business API konfigurieren... | Configure a API do WhatsApp Business... | Настройте WhatsApp Business API... | Configureer de WhatsApp Business API... | Configurez l'API WhatsApp Business... | Configure la API de WhatsApp Business... |
| `enableWhatsApp` | Enable WhatsApp notifications | WhatsApp-Benachrichtigungen aktivieren | Ativar envio por WhatsApp | Включить уведомления WhatsApp | WhatsApp-meldingen inschakelen | Activer les notifications WhatsApp | Activar notificaciones de WhatsApp |
| `enableDescription` | Send WhatsApp notification when a gallery is created | WhatsApp-Nachricht bei Galerie-Erstellung senden | Enviar notificação quando uma galeria for criada | Отправлять уведомление при создании галереи | WhatsApp-bericht sturen bij aanmaken galerie | Envoyer une notification à la création d'une galerie | Enviar notificación al crear una galería |
| `phoneNumberIdHelp` | From Meta for Developers → WhatsApp | Von Meta for Developers → WhatsApp | Em Meta for Developers → WhatsApp | В Meta for Developers → WhatsApp | Via Meta for Developers → WhatsApp | Depuis Meta for Developers → WhatsApp | Desde Meta for Developers → WhatsApp |
| `wabaIdHelp` | Found in Meta Business Manager | In Meta Business Manager zu finden | Encontrado no Meta Business Manager | Найдено в Meta Business Manager | Te vinden in Meta Business Manager | Trouvé dans Meta Business Manager | Disponible en Meta Business Manager |
| `accessTokenHelp` | System User token with whatsapp_business_messaging | System-User-Token mit whatsapp_business_messaging | Token de System User com whatsapp_business_messaging | Токен системного пользователя с whatsapp_business_messaging | Systeemgebruikerstoken met whatsapp_business_messaging | Token utilisateur système avec whatsapp_business_messaging | Token de usuario del sistema con whatsapp_business_messaging |
| `templateName` | Template Name | Template-Name | Nome do Template | Название шаблона | Sjabloonnaam | Nom du modèle | Nombre de la plantilla |
| `templateNameHelp` | Exact name of the approved template | Exakter Name des genehmigten Templates | Nome exato do template aprovado | Точное название одобренного шаблона | Exacte naam van goedgekeurd sjabloon | Nom exact du modèle approuvé | Nombre exacto de la plantilla aprobada |
| `testButton` | Test | Testen | Testar | Тест | Testen | Tester | Probar |
| `testModalTitle` | Send test message | Testnachricht senden | Enviar mensagem de teste | Отправить тестовое сообщение | Testbericht sturen | Envoyer un message de test | Enviar mensaje de prueba |
| `testPhoneLabel` | Phone number (international format) | Telefonnummer (internationales Format) | Número de telefone (formato internacional) | Номер телефона (международный формат) | Telefoonnummer (internationaal formaat) | Numéro de téléphone (format international) | Número de teléfono (formato internacional) |
| `testSendButton` | Send | Senden | Enviar | Отправить | Sturen | Envoyer | Enviar |
| `saved` | WhatsApp settings saved | WhatsApp-Einstellungen gespeichert | Configurações WhatsApp salvas | Настройки WhatsApp сохранены | WhatsApp-instellingen opgeslagen | Paramètres WhatsApp sauvegardés | Configuración de WhatsApp guardada |
| `saveFailed` | Failed to save settings | Einstellungen konnten nicht gespeichert werden | Falha ao salvar configurações | Не удалось сохранить настройки | Instellingen opslaan mislukt | Échec de la sauvegarde | Error al guardar la configuración |
| `testSent` | Test message sent! | Testnachricht gesendet! | Mensagem de teste enviada! | Тестовое сообщение отправлено! | Testbericht verzonden! | Message de test envoyé ! | ¡Mensaje de prueba enviado! |
| `testFailed` | Test message failed | Testnachricht fehlgeschlagen | Falha ao enviar mensagem de teste | Ошибка отправки тестового сообщения | Testbericht mislukt | Échec du message de test | Error en mensaje de prueba |

- [ ] **Step 8: Verify i18n extract passes**

```bash
cd D:\projects\picpeak\frontend && npm run i18n:status 2>&1 | tail -20
```

Expected: no missing keys reported (or only keys unrelated to this feature).

- [ ] **Step 9: Commit**

```bash
git add frontend/src/i18n/locales/
git commit -m "feat(whatsapp): add i18n keys for WhatsApp messaging feature (7 locales)"
```

---

## Task 12: Build, Deploy, and Smoke Test

- [ ] **Step 1: Build the frontend**

```bash
ssh root@192.168.0.210 "cd /opt/picpeak/app/frontend && npm run build 2>&1 | tail -10"
```

Expected: `dist/index.html` built, no TypeScript or Vite errors.

- [ ] **Step 2: Restart backend**

```bash
ssh root@192.168.0.210 "systemctl restart picpeak-backend && sleep 3 && tail -15 /opt/picpeak/logs/backend.log"
```

Expected: `WhatsApp queue processor started` in logs.

- [ ] **Step 3: Smoke test — Settings tab visible**

Open `https://suhrealfotos.com/admin/settings?tab=messaging` in browser.
Expected: "Configurações de Mensagens" tab renders with form fields.

- [ ] **Step 4: Smoke test — GET config API**

```bash
ssh root@192.168.0.210 "TOKEN=$(sqlite3 /opt/picpeak/app/backend/data/photo_sharing.db \"SELECT token FROM admin_sessions ORDER BY created_at DESC LIMIT 1\") && curl -s http://localhost:7101/api/admin/whatsapp/config -H \"Authorization: Bearer \$TOKEN\""
```

Expected: `{"phone_number_id":"","waba_id":"","access_token":"","template_name":"gallery_ready","enabled":false}`

- [ ] **Step 5: Smoke test — Event detail page**

Open any event that has a `customer_phone`. With WhatsApp disabled, the button should NOT appear. Enable WhatsApp in settings (even without real credentials), reload the event page — the "Reenviar WhatsApp" button should appear.

- [ ] **Step 6: Run all backend tests**

```bash
ssh root@192.168.0.210 "cd /opt/picpeak/app/backend && npm test 2>&1 | tail -20"
```

Expected: all tests pass.

- [ ] **Step 7: Final commit**

```bash
git add -A
git commit -m "feat(whatsapp): complete WhatsApp Business API integration"
```

---

## Self-Review Checklist

- ✅ Migration (Task 1) creates both tables with correct schema
- ✅ `whatsappService.js` (Task 2): E.164 normalisation + Meta API call with axios
- ✅ `whatsappProcessor.js` (Task 3): `queueWhatsapp()` + `processWhatsAppQueue()` + `startWhatsAppQueueProcessor()`
- ✅ `adminWhatsapp.js` (Task 4): GET (masked token), PUT (skip token if `********`), POST test
- ✅ `server.js` (Task 5): route + processor registered
- ✅ `adminEvents.js` (Task 6): resend route + two creation points (create + publish draft)
- ✅ Frontend service (Task 7): `getConfig`, `updateConfig`, `testConfig`
- ✅ `MessagingConfigPage` (Task 8): toggle + 4 fields + save + test modal
- ✅ `SettingsPage` (Task 9): `messaging` tab in Communication group
- ✅ `EventDetailsPage` (Task 10): button gated on `event.customer_phone && whatsappEnabled`
- ✅ i18n (Task 11): all 7 locales, both `events.*` and `settings.messaging.*` keys
- ✅ No TBDs, no placeholders, no "similar to Task N" shortcuts
- ✅ `queueWhatsapp` signature consistent across all uses: `(eventId, recipientPhone, messageType, messageData)`
- ✅ `sendWhatsAppMessage` signature consistent: `(recipientPhone, config, languageCode, components)`
- ✅ `WHATSAPP_CONFIG_QUERY_KEY` used in both `MessagingConfigPage` and `EventDetailsPage`
