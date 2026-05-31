# WhatsApp Business API Integration — Design Spec

**Date:** 2026-05-21
**Status:** Approved
**Scope:** Notify clients via WhatsApp when their gallery is ready, mirroring the existing email notification system.

---

## 1. Context

PicPeak already sends a `gallery_created` email when an event is published. The `customer_phone` field already exists on the `events` table (gated by `event_phone_field_enabled`). This spec adds a parallel WhatsApp notification channel using the Meta Cloud API directly — no intermediary (Twilio, etc.).

---

## 2. Prerequisites (Manual — outside code)

These steps must be completed before activating the feature in Settings.

### 2.1 Meta App Setup
1. Go to [Meta for Developers](https://developers.facebook.com) → create app → select **"Conectar-se com clientes pelo WhatsApp"** (option 11)
2. Add **WhatsApp** product to the app
3. In **WhatsApp → Getting Started**: note `phone_number_id` and `waba_id`
4. For production: add a real phone number under **Phone Numbers** → verify via SMS/call

### 2.2 Access Token
- Temporary token (24h) available in the developer panel for testing
- For production: create a **System User** in Meta Business Manager → generate permanent token with `whatsapp_business_messaging` permission

### 2.3 Message Template
Submit a template named `gallery_ready` (category: `UTILITY`, language: `pt_BR`) for Meta approval.

**Template body:**
```
Olá, {{1}}! 🎉

Sua galeria *{{2}}* já está disponível.

📸 Acesse: {{3}}
{{4}}
⏳ Disponível até: {{5}}
```

| Parameter | Value |
|-----------|-------|
| `{{1}}` | Client name (`customer_name`) |
| `{{2}}` | Event name (`event_name`) |
| `{{3}}` | Gallery URL (`share_link`) |
| `{{4}}` | Password line (`🔒 Senha: abc123`) or empty string if no password |
| `{{5}}` | Expiry date or empty string if no expiry |

Meta does not support conditional parameters natively. `{{4}}` and `{{5}}` receive empty string `""` when not applicable — submit template with this behavior documented.

Approval typically takes 1–24h. The approved template name goes into the "Nome do Template" field in Settings.

---

## 3. Architecture

### 3.1 Flow

```
Gallery created / published
        ↓
adminEvents.js → queueWhatsapp()  [mirrors queueEmail()]
        ↓
whatsapp_queue table
        ↓
whatsappProcessor.js  [background service, polling every 30s]
        ↓
whatsappService.js → Meta Cloud API  POST /v19.0/{phone_number_id}/messages
```

Resend button in `EventDetailsPage` → `POST /api/admin/events/:id/resend-whatsapp` → same flow from `queueWhatsapp()`.

### 3.2 Send Conditions (all must be true)

1. `whatsapp_configs.enabled = true`
2. `event.customer_phone` is not null
3. `event_phone_field_enabled = true` (existing setting)

Any condition false → silent skip, does not block gallery creation.

---

## 4. Database (new migrations)

### `whatsapp_configs`
```sql
id               integer PK autoincrement
phone_number_id  varchar(255) not null
waba_id          varchar(255) not null
access_token     varchar(1000) not null   -- stored encrypted or as-is (same as smtp_pass)
template_name    varchar(255) not null default 'gallery_ready'
enabled          boolean default false
updated_at       datetime default CURRENT_TIMESTAMP
```

### `whatsapp_queue`
```sql
id               integer PK autoincrement
event_id         integer FK → events(id)
recipient_phone  varchar(50) not null      -- E.164 format: +5511999999999
message_type     varchar(50) not null      -- e.g. 'gallery_created'
message_data     json                      -- template parameter values
status           varchar(20) default 'pending'  -- pending / sent / failed
retry_count      integer default 0
created_at       datetime default CURRENT_TIMESTAMP
scheduled_at     datetime default CURRENT_TIMESTAMP
sent_at          datetime
error_message    text
```

---

## 5. Backend

### 5.1 `src/services/whatsappService.js`

Single responsibility: call Meta Cloud API.

```js
// Normalizes phone to E.164, then calls:
// POST https://graph.facebook.com/v19.0/{phone_number_id}/messages
async function sendWhatsAppMessage(recipientPhone, templateName, languageCode, components)
```

- Normalizes `customer_phone` to E.164 before sending (Meta rejects other formats)
- `components` = array of template body parameters in order: name, event name, gallery URL, password line, expiry date
- Throws on HTTP error — caller handles retry logic

### 5.2 `src/services/whatsappProcessor.js`

Mirrors `emailProcessor.js`:
- Polling every 30s
- Fetches `whatsapp_queue` where `status = 'pending'` AND `retry_count < 3`
- Calls `whatsappService.sendWhatsAppMessage()`
- Success → `status = 'sent'`, `sent_at = now()`
- Failure → `retry_count++`, save `error_message`
- After 3 failures → `status = 'failed'`
- Exports `queueWhatsapp(eventId, recipientPhone, messageType, messageData)` helper

Registered in `server.js` alongside existing background services.

### 5.3 New routes in `src/routes/adminEvents.js`

**`POST /:id/resend-whatsapp`**
- Auth: `adminAuth` + `requirePermission('events.edit')` + `requireEventOwnership`
- Validates: event exists, `customer_phone` not null, `whatsapp_configs.enabled = true`
- Returns 400 with specific message if phone missing or WhatsApp disabled
- Calls `queueWhatsapp()`, logs activity `whatsapp_resent`
- Returns `{ success: true, message: 'WhatsApp message queued' }`

### 5.4 New route file `src/routes/adminWhatsapp.js`

**`GET /api/admin/whatsapp-config`**
- Returns config with `access_token` masked as `'********'`

**`PUT /api/admin/whatsapp-config`**
- Upserts `whatsapp_configs`
- Only updates `access_token` if value is not `'********'`
- Logs activity `whatsapp_config_updated`

**`POST /api/admin/whatsapp-config/test`**
- Body: `{ phone }` — target number for test message
- Sends a real message via `whatsappService` directly (not queued)
- Returns success/error from Meta API

### 5.5 Integration in gallery creation flow

In `adminEvents.js`, at both points where `queueEmail()` is called (direct creation + draft publish), add immediately after:

```js
// Wrapped in its own try/catch — never blocks gallery creation
try {
  const waConfig = await getWhatsAppConfig(); // cached, like isPhoneFieldEnabled()
  if (waConfig?.enabled && customerPhone) {
    await queueWhatsapp(eventId, customerPhone, 'gallery_created', {
      customer_name: recipientName,
      event_name: eventName,
      gallery_link: shareUrl,
      gallery_password: galleryPassword,
      expiry_date: event.expires_at,
    });
  }
} catch (waError) {
  logger.warn('Failed to queue WhatsApp notification', { error: waError.message });
}
```

---

## 6. Frontend

### 6.1 New Settings tab — "Configurações de Mensagens"

**Location:** `SettingsPage.tsx` → Communication group, after "Email Settings"

```
Communication
  ├── Email Settings         (existing)
  ├── Moderation             (existing)
  └── Configurações de Mensagens   ← new (key: 'messaging')
```

**New file:** `src/pages/admin/MessagingConfigPage.tsx`
Follows same pattern as `EmailConfigPage.tsx`.

**Form fields:**
| Field | Type | Maps to |
|-------|------|---------|
| Ativar envio por WhatsApp | Toggle | `enabled` |
| Phone Number ID | Text | `phone_number_id` |
| WhatsApp Business Account ID | Text | `waba_id` |
| Access Token | Password | `access_token` (masked) |
| Nome do Template | Text | `template_name` |

**Test button:** opens modal asking for a phone number → calls `POST /api/admin/whatsapp-config/test`.

**New service:** `src/services/whatsappConfig.service.ts`
- `getWhatsAppConfig()` → GET `/api/admin/whatsapp-config`
- `updateWhatsAppConfig(data)` → PUT `/api/admin/whatsapp-config`
- `testWhatsAppConfig(phone)` → POST `/api/admin/whatsapp-config/test`

### 6.2 Changes to `SettingsPage.tsx`

```ts
// 1. Add to TabType union:
| 'messaging'

// 2. Add to ALL_TAB_KEYS:
'messaging'

// 3. Add to TABS_WITH_OWN_HEADER:
'messaging'

// 4. Add to Communication group items:
{ key: 'messaging', label: t('settings.messaging.title', 'Configurações de Mensagens'), icon: MessageCircle }

// 5. Add render:
{activeTab === 'messaging' && <MessagingConfigPage />}
```

### 6.3 Resend button in `EventDetailsPage.tsx`

Added alongside the existing "Reenviar email" button:

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

`whatsappEnabled` sourced from a query to `GET /api/admin/whatsapp-config` (cached via React Query).
`eventsService.resendWhatsApp(id)` → `POST /api/admin/events/:id/resend-whatsapp`.

---

## 7. i18n — New Keys (all 7 locales)

Add to `src/i18n/locales/{en,de,pt,ru,nl,fr,es}.json`:

| Key | en | de | pt | ru | nl | fr | es |
|-----|----|----|----|----|----|----|-----|
| `settings.messaging.title` | Message Settings | Nachrichteneinstellungen | Configurações de Mensagens | Настройки сообщений | Berichtinstellingen | Paramètres de messagerie | Configuración de mensajes |
| `events.resendWhatsApp` | Resend WhatsApp | WhatsApp erneut senden | Reenviar WhatsApp | Повторно отправить WhatsApp | WhatsApp opnieuw sturen | Renvoyer WhatsApp | Reenviar WhatsApp |
| `events.whatsappResent` | WhatsApp message sent | WhatsApp-Nachricht gesendet | Mensagem WhatsApp enviada | Сообщение WhatsApp отправлено | WhatsApp-bericht verzonden | Message WhatsApp envoyé | Mensaje de WhatsApp enviado |
| `events.failedToResendWhatsApp` | Failed to resend WhatsApp | WhatsApp erneut senden fehlgeschlagen | Falha ao reenviar WhatsApp | Не удалось отправить WhatsApp | WhatsApp opnieuw sturen mislukt | Échec du renvoi WhatsApp | Error al reenviar WhatsApp |

Additional keys for `MessagingConfigPage.tsx` fields to be added during implementation (labels, descriptions, placeholders, test modal text).

---

## 8. Files Changed / Created

### New files
| Path | Description |
|------|-------------|
| `backend/src/services/whatsappService.js` | Meta Cloud API wrapper |
| `backend/src/services/whatsappProcessor.js` | Queue processor + `queueWhatsapp()` helper |
| `backend/src/routes/adminWhatsapp.js` | GET/PUT config + POST test |
| `backend/migrations/core/XXX_create_whatsapp_tables.js` | Creates `whatsapp_configs` + `whatsapp_queue` |
| `frontend/src/pages/admin/MessagingConfigPage.tsx` | Settings tab UI |
| `frontend/src/services/whatsappConfig.service.ts` | API calls for config |

### Modified files
| Path | Change |
|------|--------|
| `backend/server.js` | Register `whatsappProcessor` background service + `adminWhatsapp` route |
| `backend/src/routes/adminEvents.js` | Add `POST /:id/resend-whatsapp` + `queueWhatsapp()` calls in creation flow |
| `frontend/src/pages/admin/SettingsPage.tsx` | Add `messaging` tab to Communication group |
| `frontend/src/pages/admin/EventDetailsPage.tsx` | Add resend WhatsApp button |
| `frontend/src/i18n/locales/*.json` | Add new keys (7 files) |
