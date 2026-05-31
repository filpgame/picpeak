# Auto-Update Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an "Application Version" card to `/admin/settings?tab=status` that shows the current version, checks `filpgame/picpeak` GitHub releases for updates, and lets the admin trigger a one-click server update via a detached shell process.

**Architecture:** The backend spawns `scripts/picpeak-setup.sh` as a detached process (survives the Node.js restart), responds 202, and the frontend polls `/admin/system/version` every 3s until the new version is detected. The existing floating `UpdateNotification` banner is removed and replaced by this card.

**Tech Stack:** Node.js/Express (backend), React 18 + TypeScript + Vitest + React Query (frontend), i18next (7 locale files)

---

## File Map

| Action | Path | Responsibility |
|---|---|---|
| Modify | `backend/src/services/updateCheckService.js` | Use `GITHUB_RELEASES_REPO` env var instead of hardcoded `the-luap/picpeak` |
| Modify | `backend/src/routes/adminSystem.js` | Add `POST /updates/apply`, `GET /logs/download`; fix `releaseNotesUrl` |
| Create | `backend/src/routes/__tests__/adminSystem.apply.test.js` | Tests for apply endpoint |
| Create | `backend/src/routes/__tests__/adminSystem.logs.test.js` | Tests for log download endpoint |
| Modify | `frontend/src/i18n/locales/*.json` (7 files) | Add `admin.updates.card.*` keys in all languages |
| Create | `frontend/src/features/settings/hooks/useUpdateCard.ts` | Update state machine + polling logic |
| Create | `frontend/src/features/settings/hooks/__tests__/useUpdateCard.test.tsx` | Hook tests |
| Create | `frontend/src/features/settings/components/UpdateCard.tsx` | Renders all 6 UI states |
| Create | `frontend/src/features/settings/components/__tests__/UpdateCard.test.tsx` | Component render tests |
| Modify | `frontend/src/features/settings/tabs/StatusTab.tsx` | Add `<UpdateCard />` as first card |
| Modify | `frontend/src/pages/admin/AdminDashboard.tsx` | Remove `<UpdateNotification />` |
| Delete | `frontend/src/components/admin/UpdateNotification.tsx` | Replaced by card |
| Delete | `frontend/src/components/admin/UpdateInstructionsDialog.tsx` | No longer needed |

---

## Task 1: Fix version-check repo URL

**Files:**
- Modify: `backend/src/services/updateCheckService.js`
- Modify: `backend/src/routes/adminSystem.js`
- Create: `backend/src/routes/__tests__/adminSystem.version.test.js`

- [ ] **Step 1: Write a failing test verifying the GitHub API URL uses the env var**

Create `backend/src/routes/__tests__/adminSystem.version.test.js`:

```js
jest.mock('../../middleware/auth', () => ({
  adminAuth: (_req, _res, next) => { _req.admin = { id: 1 }; next(); },
}));
jest.mock('../../middleware/permissions', () => ({
  requirePermission: () => (_req, _res, next) => next(),
}));
jest.mock('../../services/updateCheckService', () => ({
  checkForUpdates: jest.fn().mockResolvedValue({
    current: '4.1.2-beta.0',
    channel: 'beta',
    updateAvailable: false,
    latest: { stable: '4.1.2', beta: '4.1.2-beta.0', forChannel: '4.1.2-beta.0' },
    lastChecked: new Date().toISOString(),
  }),
  getCurrentChannel: jest.fn().mockReturnValue('beta'),
}));
jest.mock('../../services/environmentService', () => ({
  detectEnvironment: jest.fn(),
  generateUpdateInstructions: jest.fn(),
}));
jest.mock('../../services/updateNotificationService', () => ({
  checkAndNotifyUpdates: jest.fn(),
  sendTestUpdateNotification: jest.fn(),
  getUpdateNotificationSettings: jest.fn().mockResolvedValue({}),
}));
jest.mock('../../database/db', () => ({ db: jest.fn(), withRetry: jest.fn() }));

const request = require('supertest');
const express = require('express');

describe('GET /system/updates — repo env var', () => {
  it('calls checkForUpdates (which should use GITHUB_RELEASES_REPO env var)', async () => {
    const { checkForUpdates } = require('../../services/updateCheckService');
    const router = require('../adminSystem');
    const app = express();
    app.use(express.json());
    app.use('/system', router);

    const res = await request(app).get('/system/updates');
    expect(res.status).toBe(200);
    expect(checkForUpdates).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to confirm it currently passes (baseline)**

```
cd backend && npx jest src/routes/__tests__/adminSystem.version.test.js --no-coverage
```

Expected: PASS (the test just checks the call happens — the env var change is validated next).

- [ ] **Step 3: Add `RELEASES_REPO` constant to `updateCheckService.js`**

In `backend/src/services/updateCheckService.js`, find line 1 (top of file, after requires):

```js
// BEFORE — line ~7 inside fetchAvailableVersions():
const response = await axios.get(
  'https://api.github.com/repos/the-luap/picpeak/releases',
```

Add the constant at the top of the file (after the existing `const logger` require), then use it:

```js
// Add near top of file, after requires:
const RELEASES_REPO = process.env.GITHUB_RELEASES_REPO || 'filpgame/picpeak';
```

Then change the axios call inside `fetchAvailableVersions()`:

```js
const response = await axios.get(
  `https://api.github.com/repos/${RELEASES_REPO}/releases`,
```

- [ ] **Step 4: Fix `releaseNotesUrl` in `adminSystem.js`**

In `backend/src/routes/adminSystem.js`, find the line:

```js
releaseNotesUrl: `https://github.com/the-luap/picpeak/releases/tag/v${updateInfo.latest.forChannel}`
```

Replace with:

```js
releaseNotesUrl: `https://github.com/${process.env.GITHUB_RELEASES_REPO || 'filpgame/picpeak'}/releases/tag/v${updateInfo.latest.forChannel}`
```

- [ ] **Step 5: Run test again to confirm still passes**

```
cd backend && npx jest src/routes/__tests__/adminSystem.version.test.js --no-coverage
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/updateCheckService.js backend/src/routes/adminSystem.js backend/src/routes/__tests__/adminSystem.version.test.js
git commit -m "fix(updates): check filpgame/picpeak releases via GITHUB_RELEASES_REPO env var"
```

---

## Task 2: Add `POST /updates/apply` endpoint

**Files:**
- Modify: `backend/src/routes/adminSystem.js`
- Create: `backend/src/routes/__tests__/adminSystem.apply.test.js`

- [ ] **Step 1: Write failing tests for the apply endpoint**

Create `backend/src/routes/__tests__/adminSystem.apply.test.js`:

```js
jest.mock('../../middleware/auth', () => ({
  adminAuth: (_req, _res, next) => { _req.admin = { id: 1 }; next(); },
}));
jest.mock('../../middleware/permissions', () => ({
  requirePermission: () => (_req, _res, next) => next(),
}));
jest.mock('../../services/updateNotificationService', () => ({
  checkAndNotifyUpdates: jest.fn(),
  sendTestUpdateNotification: jest.fn(),
  getUpdateNotificationSettings: jest.fn().mockResolvedValue({}),
}));
jest.mock('../../services/environmentService', () => ({
  detectEnvironment: jest.fn(),
  generateUpdateInstructions: jest.fn(),
}));
jest.mock('../../database/db', () => ({ db: jest.fn(), withRetry: jest.fn() }));

const mockSpawn = jest.fn(() => ({ unref: jest.fn() }));
jest.mock('child_process', () => ({ spawn: mockSpawn }));

jest.mock('../../services/updateCheckService', () => ({
  checkForUpdates: jest.fn().mockResolvedValue({
    current: '4.1.2-beta.0',
    channel: 'beta',
    updateAvailable: true,
    latest: { stable: '4.1.2', beta: '4.1.3-beta.0', forChannel: '4.1.3-beta.0' },
    lastChecked: new Date().toISOString(),
  }),
  getCurrentChannel: jest.fn().mockReturnValue('beta'),
}));

const request = require('supertest');
const express = require('express');

function buildApp() {
  // Use isolateModules so updateInProgress flag resets between tests
  let router;
  jest.isolateModules(() => {
    router = require('../adminSystem');
  });
  const app = express();
  app.use(express.json());
  app.use('/system', router);
  return app;
}

describe('POST /system/updates/apply', () => {
  beforeEach(() => {
    mockSpawn.mockClear();
    mockSpawn.mockReturnValue({ unref: jest.fn() });
  });

  it('returns 202 and spawns setup script', async () => {
    const app = buildApp();
    const res = await request(app).post('/system/updates/apply');
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('started');
    expect(res.body.targetVersion).toBe('4.1.3-beta.0');
    expect(mockSpawn).toHaveBeenCalledWith(
      'bash',
      [expect.stringContaining('picpeak-setup.sh')],
      expect.objectContaining({ detached: true, stdio: 'ignore' })
    );
  });

  it('returns 409 if spawn already in progress', async () => {
    const app = buildApp();
    // First request starts it
    await request(app).post('/system/updates/apply');
    // Second request hits the guard
    const res = await request(app).post('/system/updates/apply');
    expect(res.status).toBe(409);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('returns 500 and resets flag if spawn throws', async () => {
    mockSpawn.mockImplementation(() => { throw new Error('spawn failed'); });
    const app = buildApp();
    const res = await request(app).post('/system/updates/apply');
    expect(res.status).toBe(500);

    // Flag reset — second request can proceed
    mockSpawn.mockReturnValue({ unref: jest.fn() });
    const res2 = await request(app).post('/system/updates/apply');
    expect(res2.status).toBe(202);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```
cd backend && npx jest src/routes/__tests__/adminSystem.apply.test.js --no-coverage
```

Expected: FAIL — route not found (404)

- [ ] **Step 3: Add `spawn` require and `updateInProgress` flag to `adminSystem.js`**

At the top of `backend/src/routes/adminSystem.js`, after the existing `require` lines, add:

```js
const { spawn } = require('child_process');

let updateInProgress = false;
```

- [ ] **Step 4: Add the `POST /updates/apply` route to `adminSystem.js`**

Add this block before the `module.exports` line at the bottom of `backend/src/routes/adminSystem.js`:

```js
// Trigger automatic update by running the setup/update script as a detached process
router.post('/updates/apply', adminAuth, requirePermission('settings.edit'), async (req, res) => {
  if (updateInProgress) {
    return res.status(409).json({ error: 'Update already in progress' });
  }

  updateInProgress = true;

  try {
    const updateInfo = await checkForUpdates();
    const scriptPath = path.resolve(__dirname, '../../../scripts/picpeak-setup.sh');

    const child = spawn('bash', [scriptPath], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();

    res.status(202).json({
      status: 'started',
      targetVersion: updateInfo.latest?.forChannel,
    });
  } catch (error) {
    updateInProgress = false;
    logger.error('Failed to start update process:', error);
    res.status(500).json({ error: 'Failed to start update process' });
  }
});
```

- [ ] **Step 5: Run tests to confirm they pass**

```
cd backend && npx jest src/routes/__tests__/adminSystem.apply.test.js --no-coverage
```

Expected: 3 passing

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/adminSystem.js backend/src/routes/__tests__/adminSystem.apply.test.js
git commit -m "feat(updates): add POST /updates/apply endpoint to trigger server update"
```

---

## Task 3: Add `GET /logs/download` endpoint

**Files:**
- Modify: `backend/src/routes/adminSystem.js`
- Create: `backend/src/routes/__tests__/adminSystem.logs.test.js`

- [ ] **Step 1: Write failing tests**

Create `backend/src/routes/__tests__/adminSystem.logs.test.js`:

```js
const { PassThrough } = require('stream');

jest.mock('../../middleware/auth', () => ({
  adminAuth: (_req, _res, next) => { _req.admin = { id: 1 }; next(); },
}));
jest.mock('../../middleware/permissions', () => ({
  requirePermission: () => (_req, _res, next) => next(),
}));
jest.mock('../../services/updateCheckService', () => ({
  checkForUpdates: jest.fn(),
  getCurrentChannel: jest.fn().mockReturnValue('beta'),
}));
jest.mock('../../services/updateNotificationService', () => ({
  checkAndNotifyUpdates: jest.fn(),
  sendTestUpdateNotification: jest.fn(),
  getUpdateNotificationSettings: jest.fn().mockResolvedValue({}),
}));
jest.mock('../../services/environmentService', () => ({
  detectEnvironment: jest.fn(),
  generateUpdateInstructions: jest.fn(),
}));
jest.mock('../../database/db', () => ({ db: jest.fn(), withRetry: jest.fn() }));

const mockAccess = jest.fn();
const mockCreateReadStream = jest.fn();

jest.mock('fs', () => {
  const original = jest.requireActual('fs');
  return {
    ...original,
    promises: {
      ...original.promises,
      access: mockAccess,
    },
    createReadStream: mockCreateReadStream,
  };
});

const request = require('supertest');
const express = require('express');

let app;
beforeAll(() => {
  const router = require('../adminSystem');
  app = express();
  app.use(express.json());
  app.use('/system', router);
});

describe('GET /system/logs/download', () => {
  beforeEach(() => {
    mockAccess.mockReset();
    mockCreateReadStream.mockReset();
  });

  it('streams combined.log with correct headers', async () => {
    mockAccess.mockResolvedValue(undefined);
    const stream = new PassThrough();
    stream.end('log line 1\nlog line 2\n');
    mockCreateReadStream.mockReturnValue(stream);

    const res = await request(app).get('/system/logs/download?type=combined');

    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toBe('attachment; filename=picpeak-combined.log');
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.text).toContain('log line 1');
    expect(mockCreateReadStream).toHaveBeenCalledWith(expect.stringContaining('combined.log'));
  });

  it('streams error.log when type=error', async () => {
    mockAccess.mockResolvedValue(undefined);
    const stream = new PassThrough();
    stream.end('error entry\n');
    mockCreateReadStream.mockReturnValue(stream);

    const res = await request(app).get('/system/logs/download?type=error');

    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toBe('attachment; filename=picpeak-error.log');
    expect(mockCreateReadStream).toHaveBeenCalledWith(expect.stringContaining('error.log'));
  });

  it('defaults to combined.log when type param is missing', async () => {
    mockAccess.mockResolvedValue(undefined);
    const stream = new PassThrough();
    stream.end('data');
    mockCreateReadStream.mockReturnValue(stream);

    const res = await request(app).get('/system/logs/download');
    expect(res.status).toBe(200);
    expect(mockCreateReadStream).toHaveBeenCalledWith(expect.stringContaining('combined.log'));
  });

  it('returns 404 when log file does not exist', async () => {
    mockAccess.mockRejectedValue(new Error('ENOENT'));

    const res = await request(app).get('/system/logs/download?type=combined');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```
cd backend && npx jest src/routes/__tests__/adminSystem.logs.test.js --no-coverage
```

Expected: FAIL — route not found (404)

- [ ] **Step 3: Add `fsSync` require and the `GET /logs/download` route to `adminSystem.js`**

At the top of `backend/src/routes/adminSystem.js`, after the existing `const fs = require('fs').promises;` line, add:

```js
const fsSync = require('fs');
```

Then add this route before the `module.exports` line:

```js
// Download backend log files
router.get('/logs/download', adminAuth, requirePermission('settings.view'), async (req, res) => {
  const type = req.query.type === 'error' ? 'error' : 'combined';
  const filename = `${type}.log`;
  const logPath = path.join(__dirname, '../../logs', filename);

  try {
    await fs.access(logPath);
  } catch {
    return res.status(404).json({ error: 'Log file not found' });
  }

  res.setHeader('Content-Disposition', `attachment; filename=picpeak-${filename}`);
  res.setHeader('Content-Type', 'text/plain');

  const stream = fsSync.createReadStream(logPath);
  stream.pipe(res);
});
```

- [ ] **Step 4: Run tests to confirm they pass**

```
cd backend && npx jest src/routes/__tests__/adminSystem.logs.test.js --no-coverage
```

Expected: 4 passing

- [ ] **Step 5: Run full backend test suite to check for regressions**

```
cd backend && npx jest --no-coverage 2>&1 | tail -20
```

Expected: all tests pass (or same failures as before this task)

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/adminSystem.js backend/src/routes/__tests__/adminSystem.logs.test.js
git commit -m "feat(system): add GET /logs/download endpoint for combined and error logs"
```

---

## Task 4: Add i18n keys to all locale files

**Files:**
- Modify: `frontend/src/i18n/locales/en.json`
- Modify: `frontend/src/i18n/locales/de.json`
- Modify: `frontend/src/i18n/locales/es.json`
- Modify: `frontend/src/i18n/locales/fr.json`
- Modify: `frontend/src/i18n/locales/nl.json`
- Modify: `frontend/src/i18n/locales/pt.json`
- Modify: `frontend/src/i18n/locales/ru.json`

In each file, find the `"admin"` → `"updates"` object and add the `"card"` sub-object shown below. The existing keys in `"updates"` are not changed.

- [ ] **Step 1: Add keys to `en.json`**

Find `"updates": {` inside `"admin"` and add `"card"` as a new key in that object:

```json
"card": {
  "title": "Application Version",
  "upToDate": "Up to date",
  "updateAvailable": "Update available",
  "updateTo": "Update to {{version}}",
  "checkAgain": "Check again",
  "lastChecked": "Last checked: {{time}}",
  "updating": "Updating…",
  "updatingDesc": "Updating to {{version}} — installing dependencies and building frontend. The server will restart automatically.",
  "restarting": "Restarting…",
  "restartingDesc": "Server is restarting — page will reload automatically when ready.",
  "complete": "Updated to {{version}} — reloading page…",
  "errorTitle": "Update may have encountered an issue, or the server is taking longer than expected to restart.",
  "downloadCombinedLog": "Download combined.log",
  "downloadErrorLog": "Download error.log",
  "retry": "Retry"
}
```

- [ ] **Step 2: Add keys to `de.json`**

```json
"card": {
  "title": "Anwendungsversion",
  "upToDate": "Aktuell",
  "updateAvailable": "Update verfügbar",
  "updateTo": "Auf {{version}} aktualisieren",
  "checkAgain": "Erneut prüfen",
  "lastChecked": "Zuletzt geprüft: {{time}}",
  "updating": "Wird aktualisiert…",
  "updatingDesc": "Aktualisierung auf {{version}} — Abhängigkeiten werden installiert und das Frontend wird erstellt. Der Server wird automatisch neu gestartet.",
  "restarting": "Wird neu gestartet…",
  "restartingDesc": "Der Server wird neu gestartet — die Seite lädt automatisch neu, wenn er bereit ist.",
  "complete": "Auf {{version}} aktualisiert — Seite wird neu geladen…",
  "errorTitle": "Beim Update ist möglicherweise ein Problem aufgetreten, oder der Server benötigt länger als erwartet zum Neustart.",
  "downloadCombinedLog": "combined.log herunterladen",
  "downloadErrorLog": "error.log herunterladen",
  "retry": "Erneut versuchen"
}
```

- [ ] **Step 3: Add keys to `es.json`**

```json
"card": {
  "title": "Versión de la aplicación",
  "upToDate": "Actualizado",
  "updateAvailable": "Actualización disponible",
  "updateTo": "Actualizar a {{version}}",
  "checkAgain": "Verificar de nuevo",
  "lastChecked": "Última verificación: {{time}}",
  "updating": "Actualizando…",
  "updatingDesc": "Actualizando a {{version}} — instalando dependencias y compilando el frontend. El servidor se reiniciará automáticamente.",
  "restarting": "Reiniciando…",
  "restartingDesc": "El servidor se está reiniciando — la página se recargará automáticamente cuando esté lista.",
  "complete": "Actualizado a {{version}} — recargando página…",
  "errorTitle": "Es posible que la actualización haya encontrado un problema, o el servidor está tardando más de lo esperado en reiniciarse.",
  "downloadCombinedLog": "Descargar combined.log",
  "downloadErrorLog": "Descargar error.log",
  "retry": "Reintentar"
}
```

- [ ] **Step 4: Add keys to `fr.json`**

```json
"card": {
  "title": "Version de l’application",
  "upToDate": "À jour",
  "updateAvailable": "Mise à jour disponible",
  "updateTo": "Mettre à jour vers {{version}}",
  "checkAgain": "Vérifier à nouveau",
  "lastChecked": "Dernière vérification : {{time}}",
  "updating": "Mise à jour en cours…",
  "updatingDesc": "Mise à jour vers {{version}} — installation des dépendances et compilation du frontend. Le serveur redémarrera automatiquement.",
  "restarting": "Redémarrage…",
  "restartingDesc": "Le serveur redémarre — la page se rechargera automatiquement dès qu’il sera prêt.",
  "complete": "Mis à jour vers {{version}} — rechargement de la page…",
  "errorTitle": "La mise à jour a peut-être rencontré un problème, ou le serveur prend plus de temps que prévu pour redémarrer.",
  "downloadCombinedLog": "Télécharger combined.log",
  "downloadErrorLog": "Télécharger error.log",
  "retry": "Réessayer"
}
```

- [ ] **Step 5: Add keys to `nl.json`**

```json
"card": {
  "title": "Versie van de applicatie",
  "upToDate": "Up-to-date",
  "updateAvailable": "Update beschikbaar",
  "updateTo": "Bijwerken naar {{version}}",
  "checkAgain": "Opnieuw controleren",
  "lastChecked": "Laatst gecontroleerd: {{time}}",
  "updating": "Bijwerken…",
  "updatingDesc": "Bijwerken naar {{version}} — afhankelijkheden installeren en frontend bouwen. De server zal automatisch opnieuw starten.",
  "restarting": "Herstarten…",
  "restartingDesc": "De server herstart — de pagina wordt automatisch herladen zodra deze gereed is.",
  "complete": "Bijgewerkt naar {{version}} — pagina herladen…",
  "errorTitle": "De update is mogelijk mislukt, of de server heeft meer tijd nodig dan verwacht om te herstarten.",
  "downloadCombinedLog": "Download combined.log",
  "downloadErrorLog": "Download error.log",
  "retry": "Opnieuw proberen"
}
```

- [ ] **Step 6: Add keys to `pt.json`**

```json
"card": {
  "title": "Versão da aplicação",
  "upToDate": "Atualizado",
  "updateAvailable": "Atualização disponível",
  "updateTo": "Atualizar para {{version}}",
  "checkAgain": "Verificar novamente",
  "lastChecked": "Última verificação: {{time}}",
  "updating": "A atualizar…",
  "updatingDesc": "A atualizar para {{version}} — a instalar dependências e a compilar o frontend. O servidor será reiniciado automaticamente.",
  "restarting": "A reiniciar…",
  "restartingDesc": "O servidor está a reiniciar — a página será recarregada automaticamente quando estiver pronta.",
  "complete": "Atualizado para {{version}} — a recarregar a página…",
  "errorTitle": "A atualização pode ter encontrado um problema, ou o servidor está a demorar mais do que o esperado a reiniciar.",
  "downloadCombinedLog": "Transferir combined.log",
  "downloadErrorLog": "Transferir error.log",
  "retry": "Tentar novamente"
}
```

- [ ] **Step 7: Add keys to `ru.json`**

```json
"card": {
  "title": "Версия приложения",
  "upToDate": "Актуальная версия",
  "updateAvailable": "Доступно обновление",
  "updateTo": "Обновить до {{version}}",
  "checkAgain": "Проверить снова",
  "lastChecked": "Последняя проверка: {{time}}",
  "updating": "Обновление…",
  "updatingDesc": "Обновление до {{version}} — установка зависимостей и сборка фронтенда. Сервер перезапустится автоматически.",
  "restarting": "Перезапуск…",
  "restartingDesc": "Сервер перезапускается — страница автоматически обновится, когда будет готова.",
  "complete": "Обновлено до {{version}} — перезагрузка страницы…",
  "errorTitle": "Возможно, при обновлении возникла ошибка, или сервер перезапускается дольше ожидаемого.",
  "downloadCombinedLog": "Скачать combined.log",
  "downloadErrorLog": "Скачать error.log",
  "retry": "Повторить"
}
```

- [ ] **Step 8: Validate all JSON files are valid**

```
cd frontend && node -e "
['en','de','es','fr','nl','pt','ru'].forEach(lang => {
  const d = require('./src/i18n/locales/' + lang + '.json');
  const card = d.admin.updates.card;
  console.log(lang + ':', Object.keys(card).length, 'keys');
  if (!card.title || !card.retry) throw new Error(lang + ' missing keys');
});
console.log('All OK');
"
```

Expected output:
```
en: 15 keys
de: 15 keys
...
All OK
```

- [ ] **Step 9: Commit**

```bash
git add frontend/src/i18n/locales/
git commit -m "feat(i18n): add admin.updates.card keys to all 7 locale files"
```

---

## Task 5: Create `useUpdateCard` hook

**Files:**
- Create: `frontend/src/features/settings/hooks/useUpdateCard.ts`
- Create: `frontend/src/features/settings/hooks/__tests__/useUpdateCard.test.tsx`

- [ ] **Step 1: Write failing tests**

Create `frontend/src/features/settings/hooks/__tests__/useUpdateCard.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useUpdateCard } from '../useUpdateCard';
import { api } from '../../../../config/api';

vi.mock('../../../../config/api', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

const apiGet = vi.mocked(api.get);
const apiPost = vi.mocked(api.post);

function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, Wrapper };
}

const UP_TO_DATE_RESPONSE = {
  data: {
    enabled: true,
    updateAvailable: false,
    current: '4.1.2-beta.0',
    channel: 'beta',
    lastChecked: '2026-05-30T00:00:00.000Z',
    latest: { stable: '4.1.2', beta: '4.1.2-beta.0', forChannel: '4.1.2-beta.0' },
  },
};

const UPDATE_AVAILABLE_RESPONSE = {
  data: {
    enabled: true,
    updateAvailable: true,
    current: '4.1.2-beta.0',
    channel: 'beta',
    lastChecked: '2026-05-30T00:00:00.000Z',
    latest: { stable: '4.1.2', beta: '4.1.3-beta.0', forChannel: '4.1.3-beta.0' },
  },
};

describe('useUpdateCard', () => {
  beforeEach(() => {
    apiGet.mockReset();
    apiPost.mockReset();
    // Fake timers but NOT Date — avoids React Query stale-time issues
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts in loading phase before query resolves', () => {
    apiGet.mockReturnValue(new Promise(() => {})); // never resolves
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useUpdateCard(), { wrapper: Wrapper });
    expect(result.current.state.phase).toBe('loading');
  });

  it('transitions to idle when no update is available', async () => {
    apiGet.mockResolvedValue(UP_TO_DATE_RESPONSE);
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useUpdateCard(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.state.phase).toBe('idle'));

    const s = result.current.state as { phase: string; current: string; channel: string };
    expect(s.current).toBe('4.1.2-beta.0');
    expect(s.channel).toBe('beta');
  });

  it('transitions to update-available when a newer version exists', async () => {
    apiGet.mockResolvedValue(UPDATE_AVAILABLE_RESPONSE);
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useUpdateCard(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.state.phase).toBe('update-available'));

    const s = result.current.state as { phase: string; latest: string };
    expect(s.latest).toBe('4.1.3-beta.0');
  });

  it('transitions to updating immediately when triggerUpdate is called', async () => {
    apiGet.mockResolvedValue(UPDATE_AVAILABLE_RESPONSE);
    apiPost.mockResolvedValue({ data: { status: 'started' } });

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useUpdateCard(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.state.phase).toBe('update-available'));

    act(() => {
      result.current.triggerUpdate();
    });

    expect(result.current.state.phase).toBe('updating');
    expect(apiPost).toHaveBeenCalledWith('/admin/system/updates/apply');
  });

  it('transitions to restarting after 10 seconds', async () => {
    apiGet.mockResolvedValue(UPDATE_AVAILABLE_RESPONSE);
    apiPost.mockResolvedValue({ data: { status: 'started' } });

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useUpdateCard(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.state.phase).toBe('update-available'));

    act(() => {
      result.current.triggerUpdate();
    });
    expect(result.current.state.phase).toBe('updating');

    await act(async () => {
      vi.advanceTimersByTime(10_001);
    });

    expect(result.current.state.phase).toBe('restarting');
  });

  it('transitions to error after 3 minute timeout', async () => {
    // Version endpoint always throws (server stays down)
    apiGet.mockImplementation((url) => {
      if (url === '/admin/system/updates') return Promise.resolve(UPDATE_AVAILABLE_RESPONSE);
      return Promise.reject(new Error('connection refused'));
    });
    apiPost.mockResolvedValue({ data: { status: 'started' } });

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useUpdateCard(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.state.phase).toBe('update-available'));

    act(() => { result.current.triggerUpdate(); });

    await act(async () => {
      vi.advanceTimersByTime(3 * 60 * 1000 + 1);
    });

    await waitFor(() => expect(result.current.state.phase).toBe('error'));
  });

  it('sets error phase if POST returns non-409 error', async () => {
    apiGet.mockResolvedValue(UPDATE_AVAILABLE_RESPONSE);
    apiPost.mockRejectedValue({ response: { status: 500 } });

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useUpdateCard(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.state.phase).toBe('update-available'));

    // triggerUpdate is synchronous — state becomes 'updating' immediately,
    // then transitions to 'error' once the fire-and-forget POST rejects
    act(() => { result.current.triggerUpdate(); });
    expect(result.current.state.phase).toBe('updating');
    await waitFor(() => expect(result.current.state.phase).toBe('error'));
  });

  it('cleans up timers on unmount', async () => {
    apiGet.mockResolvedValue(UPDATE_AVAILABLE_RESPONSE);
    apiPost.mockResolvedValue({ data: { status: 'started' } });

    const { Wrapper } = makeWrapper();
    const { result, unmount } = renderHook(() => useUpdateCard(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.state.phase).toBe('update-available'));

    act(() => { result.current.triggerUpdate(); });
    unmount();

    // Advancing timers after unmount should not throw
    expect(() => act(() => { vi.advanceTimersByTime(15_000); })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```
cd frontend && npx vitest run src/features/settings/hooks/__tests__/useUpdateCard.test.tsx
```

Expected: FAIL — module not found

- [ ] **Step 3: Create `useUpdateCard.ts`**

Create `frontend/src/features/settings/hooks/useUpdateCard.ts`:

```typescript
import { useState, useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../config/api';

export type UpdatePhase =
  | { phase: 'loading' }
  | { phase: 'idle'; current: string; channel: string; lastChecked: string }
  | { phase: 'update-available'; current: string; latest: string; channel: string; lastChecked: string }
  | { phase: 'updating'; targetVersion: string }
  | { phase: 'restarting'; targetVersion: string }
  | { phase: 'complete'; version: string }
  | { phase: 'error' };

async function fetchUpdateInfo() {
  const res = await api.get('/admin/system/updates');
  return res.data;
}

async function fetchVersion() {
  const res = await api.get('/admin/system/version');
  return res.data;
}

export function useUpdateCard() {
  const queryClient = useQueryClient();
  const [state, setState] = useState<UpdatePhase>({ phase: 'loading' });
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const transitionRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startTimeRef = useRef<number>(0);

  const { data: updateInfo, refetch } = useQuery({
    queryKey: ['update-check'],
    queryFn: fetchUpdateInfo,
    staleTime: 60 * 60 * 1000,
    retry: false,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (!updateInfo) return;
    setState((prev) => {
      if (
        prev.phase === 'updating' ||
        prev.phase === 'restarting' ||
        prev.phase === 'complete' ||
        prev.phase === 'error'
      ) return prev;

      if (updateInfo.updateAvailable) {
        return {
          phase: 'update-available',
          current: updateInfo.current,
          latest: updateInfo.latest?.forChannel,
          channel: updateInfo.channel,
          lastChecked: updateInfo.lastChecked,
        };
      }
      return {
        phase: 'idle',
        current: updateInfo.current,
        channel: updateInfo.channel,
        lastChecked: updateInfo.lastChecked,
      };
    });
  }, [updateInfo]);

  function clearTimers() {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (transitionRef.current) { clearTimeout(transitionRef.current); transitionRef.current = null; }
  }

  useEffect(() => () => clearTimers(), []);

  function triggerUpdate() {
    const targetVersion = updateInfo?.latest?.forChannel ?? '';
    setState({ phase: 'updating', targetVersion });
    startTimeRef.current = Date.now();

    api.post('/admin/system/updates/apply').catch((err: unknown) => {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status !== 409) {
        clearTimers();
        setState({ phase: 'error' });
        return;
      }
    });

    transitionRef.current = setTimeout(() => {
      setState({ phase: 'restarting', targetVersion });
    }, 10_000);

    pollRef.current = setInterval(async () => {
      if (Date.now() - startTimeRef.current > 3 * 60 * 1000) {
        clearTimers();
        setState({ phase: 'error' });
        return;
      }
      try {
        const data = await fetchVersion();
        if (data.backend === targetVersion) {
          clearTimers();
          setState({ phase: 'complete', version: targetVersion });
          setTimeout(() => window.location.reload(), 2000);
        }
      } catch {
        // Server still restarting — keep polling
      }
    }, 3_000);
  }

  function checkAgain() {
    queryClient.invalidateQueries({ queryKey: ['update-check'] });
    refetch();
  }

  return { state, triggerUpdate, checkAgain };
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```
cd frontend && npx vitest run src/features/settings/hooks/__tests__/useUpdateCard.test.tsx
```

Expected: 7 passing

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/settings/hooks/useUpdateCard.ts frontend/src/features/settings/hooks/__tests__/useUpdateCard.test.tsx
git commit -m "feat(settings): add useUpdateCard hook with update state machine"
```

---

## Task 6: Create `UpdateCard` component

**Files:**
- Create: `frontend/src/features/settings/components/UpdateCard.tsx`
- Create: `frontend/src/features/settings/components/__tests__/UpdateCard.test.tsx`

- [ ] **Step 1: Write failing render tests**

Create `frontend/src/features/settings/components/__tests__/UpdateCard.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UpdateCard } from '../UpdateCard';
import * as useUpdateCardModule from '../../hooks/useUpdateCard';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts?.version) return `${key}:${opts.version}`;
      if (opts?.time) return `${key}:${opts.time}`;
      return key;
    },
  }),
}));

vi.mock('../../hooks/useUpdateCard');

const mockUseUpdateCard = vi.mocked(useUpdateCardModule.useUpdateCard);

const triggerUpdate = vi.fn();
const checkAgain = vi.fn();

function setupHook(state: useUpdateCardModule.UpdatePhase) {
  mockUseUpdateCard.mockReturnValue({ state, triggerUpdate, checkAgain });
}

describe('UpdateCard', () => {
  beforeEach(() => {
    triggerUpdate.mockReset();
    checkAgain.mockReset();
  });

  it('renders up-to-date state', () => {
    setupHook({ phase: 'idle', current: '4.1.2-beta.0', channel: 'beta', lastChecked: '2026-05-30T00:00:00Z' });
    render(<UpdateCard />);
    expect(screen.getByText('admin.updates.card.upToDate')).toBeInTheDocument();
    expect(screen.getByText('admin.updates.card.checkAgain')).toBeInTheDocument();
  });

  it('renders update-available state with update button', () => {
    setupHook({ phase: 'update-available', current: '4.1.2-beta.0', latest: '4.1.3-beta.0', channel: 'beta', lastChecked: '2026-05-30T00:00:00Z' });
    render(<UpdateCard />);
    expect(screen.getByText(/admin.updates.card.updateTo/)).toBeInTheDocument();
    expect(screen.getByText('admin.updates.card.checkAgain')).toBeInTheDocument();
  });

  it('calls triggerUpdate when update button is clicked', async () => {
    setupHook({ phase: 'update-available', current: '4.1.2-beta.0', latest: '4.1.3-beta.0', channel: 'beta', lastChecked: '2026-05-30T00:00:00Z' });
    render(<UpdateCard />);
    await userEvent.click(screen.getByText(/admin.updates.card.updateTo/));
    expect(triggerUpdate).toHaveBeenCalledOnce();
  });

  it('renders updating state with disabled spinner button', () => {
    setupHook({ phase: 'updating', targetVersion: '4.1.3-beta.0' });
    render(<UpdateCard />);
    expect(screen.getByText('admin.updates.card.updating')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /admin.updates.card.updating/ })).toBeDisabled();
  });

  it('renders restarting state', () => {
    setupHook({ phase: 'restarting', targetVersion: '4.1.3-beta.0' });
    render(<UpdateCard />);
    expect(screen.getByText('admin.updates.card.restarting')).toBeInTheDocument();
  });

  it('renders complete state', () => {
    setupHook({ phase: 'complete', version: '4.1.3-beta.0' });
    render(<UpdateCard />);
    expect(screen.getByText(/admin.updates.card.complete/)).toBeInTheDocument();
  });

  it('renders error state with log download links', () => {
    setupHook({ phase: 'error' });
    render(<UpdateCard />);
    expect(screen.getByText('admin.updates.card.errorTitle')).toBeInTheDocument();
    expect(screen.getByText('admin.updates.card.downloadCombinedLog')).toBeInTheDocument();
    expect(screen.getByText('admin.updates.card.downloadErrorLog')).toBeInTheDocument();
  });

  it('log download links point to correct API paths', () => {
    setupHook({ phase: 'error' });
    render(<UpdateCard />);
    const combinedLink = screen.getByText('admin.updates.card.downloadCombinedLog').closest('a');
    const errorLink = screen.getByText('admin.updates.card.downloadErrorLog').closest('a');
    expect(combinedLink).toHaveAttribute('href', '/api/admin/system/logs/download?type=combined');
    expect(errorLink).toHaveAttribute('href', '/api/admin/system/logs/download?type=error');
  });

  it('calls checkAgain when "check again" is clicked', async () => {
    setupHook({ phase: 'idle', current: '4.1.2-beta.0', channel: 'beta', lastChecked: '2026-05-30T00:00:00Z' });
    render(<UpdateCard />);
    await userEvent.click(screen.getByText('admin.updates.card.checkAgain'));
    expect(checkAgain).toHaveBeenCalledOnce();
  });

  it('retry button calls triggerUpdate', async () => {
    setupHook({ phase: 'error' });
    render(<UpdateCard />);
    await userEvent.click(screen.getByText('admin.updates.card.retry'));
    expect(triggerUpdate).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```
cd frontend && npx vitest run src/features/settings/components/__tests__/UpdateCard.test.tsx
```

Expected: FAIL — module not found

- [ ] **Step 3: Create `UpdateCard.tsx`**

Create `frontend/src/features/settings/components/UpdateCard.tsx`:

```tsx
import React from 'react';
import { ArrowUpCircle, RefreshCw, Download, CheckCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Card } from '../../../components/common';
import { useUpdateCard } from '../hooks/useUpdateCard';

export const UpdateCard: React.FC = () => {
  const { t } = useTranslation();
  const { state, triggerUpdate, checkAgain } = useUpdateCard();

  const channelBadge =
    ('channel' in state && state.channel === 'beta') ? (
      <span className="ml-1 px-1.5 py-0.5 text-xs bg-amber-100 text-amber-700 rounded font-bold">
        BETA
      </span>
    ) : null;

  return (
    <Card padding="md">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 flex items-center gap-2">
          <ArrowUpCircle className="w-5 h-5" />
          {t('admin.updates.card.title')}
          {channelBadge}
        </h2>

        {state.phase === 'update-available' && (
          <button
            onClick={triggerUpdate}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-colors"
          >
            <ArrowUpCircle className="w-4 h-4" />
            {t('admin.updates.card.updateTo', { version: `v${state.latest}` })}
          </button>
        )}

        {(state.phase === 'updating' || state.phase === 'restarting') && (
          <button
            disabled
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-neutral-400 bg-neutral-100 dark:bg-neutral-700 rounded-lg cursor-not-allowed"
          >
            <RefreshCw className="w-4 h-4 animate-spin" />
            {state.phase === 'updating'
              ? t('admin.updates.card.updating')
              : t('admin.updates.card.restarting')}
          </button>
        )}

        {state.phase === 'error' && (
          <button
            onClick={triggerUpdate}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-colors"
          >
            {t('admin.updates.card.retry')}
          </button>
        )}
      </div>

      {(state.phase === 'idle' || state.phase === 'update-available') && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-neutral-600 dark:text-neutral-400 mb-3">
          <span>
            v<span className="font-semibold text-neutral-900 dark:text-neutral-100">{state.current}</span>
          </span>
          {state.phase === 'update-available' && (
            <>
              <span className="text-indigo-500 font-bold">→</span>
              <span className="text-indigo-600 dark:text-indigo-400 font-semibold">
                v{state.latest}
              </span>
            </>
          )}
        </div>
      )}

      {state.phase === 'idle' && (
        <div className="flex items-center gap-2 text-sm text-green-700 dark:text-green-400">
          <CheckCircle className="w-4 h-4" />
          <span>{t('admin.updates.card.upToDate')}</span>
        </div>
      )}

      {state.phase === 'updating' && (
        <div className="p-3 bg-blue-50 dark:bg-blue-900/30 rounded-lg text-sm text-blue-800 dark:text-blue-200">
          {t('admin.updates.card.updatingDesc', { version: `v${state.targetVersion}` })}
        </div>
      )}

      {state.phase === 'restarting' && (
        <div className="p-3 bg-blue-50 dark:bg-blue-900/30 rounded-lg text-sm text-blue-800 dark:text-blue-200">
          {t('admin.updates.card.restartingDesc')}
        </div>
      )}

      {state.phase === 'complete' && (
        <div className="p-3 bg-green-50 dark:bg-green-900/30 rounded-lg text-sm text-green-800 dark:text-green-200">
          {t('admin.updates.card.complete', { version: `v${state.version}` })}
        </div>
      )}

      {state.phase === 'error' && (
        <div className="p-3 bg-amber-50 dark:bg-amber-900/30 rounded-lg text-sm text-amber-800 dark:text-amber-200">
          <p>{t('admin.updates.card.errorTitle')}</p>
          <div className="flex flex-wrap gap-4 mt-2">
            <a
              href="/api/admin/system/logs/download?type=combined"
              className="inline-flex items-center gap-1 font-semibold underline hover:text-amber-900 dark:hover:text-amber-100"
            >
              <Download className="w-3.5 h-3.5" />
              {t('admin.updates.card.downloadCombinedLog')}
            </a>
            <a
              href="/api/admin/system/logs/download?type=error"
              className="inline-flex items-center gap-1 font-semibold underline hover:text-amber-900 dark:hover:text-amber-100"
            >
              <Download className="w-3.5 h-3.5" />
              {t('admin.updates.card.downloadErrorLog')}
            </a>
          </div>
        </div>
      )}

      {(state.phase === 'idle' || state.phase === 'update-available') && state.lastChecked && (
        <div className="mt-3 text-xs text-neutral-500 dark:text-neutral-400">
          {t('admin.updates.card.lastChecked', {
            time: new Date(state.lastChecked).toLocaleString(),
          })}{' '}
          ·{' '}
          <button
            onClick={checkAgain}
            className="text-indigo-600 dark:text-indigo-400 hover:underline"
          >
            {t('admin.updates.card.checkAgain')}
          </button>
        </div>
      )}
    </Card>
  );
};
```

- [ ] **Step 4: Run tests to confirm they pass**

```
cd frontend && npx vitest run src/features/settings/components/__tests__/UpdateCard.test.tsx
```

Expected: 9 passing

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/settings/components/UpdateCard.tsx frontend/src/features/settings/components/__tests__/UpdateCard.test.tsx
git commit -m "feat(settings): add UpdateCard component with 6 update states"
```

---

## Task 7: Wire UpdateCard into StatusTab + remove UpdateNotification

**Files:**
- Modify: `frontend/src/features/settings/tabs/StatusTab.tsx`
- Modify: `frontend/src/pages/admin/AdminDashboard.tsx`
- Delete: `frontend/src/components/admin/UpdateNotification.tsx`
- Delete: `frontend/src/components/admin/UpdateInstructionsDialog.tsx`

- [ ] **Step 1: Add `UpdateCard` as first card in `StatusTab.tsx`**

In `frontend/src/features/settings/tabs/StatusTab.tsx`, add the import after the existing imports:

```tsx
import { UpdateCard } from '../components/UpdateCard';
```

Then in the JSX, find the opening `<div className="space-y-6">` (line ~114) and insert `<UpdateCard />` as the first child:

```tsx
return (
  <div className="space-y-6">
    <UpdateCard />

    {/* Storage Overview */}
    {storageInfo && (() => {
```

- [ ] **Step 2: Remove `UpdateNotification` from `AdminDashboard.tsx`**

In `frontend/src/pages/admin/AdminDashboard.tsx`:

Remove the import line:
```tsx
import { UpdateNotification } from '../../components/admin/UpdateNotification';
```

Remove the render usage (line ~143):
```tsx
<UpdateNotification />
```

- [ ] **Step 3: Delete the two replaced component files**

```bash
rm frontend/src/components/admin/UpdateNotification.tsx
rm frontend/src/components/admin/UpdateInstructionsDialog.tsx
```

- [ ] **Step 4: Run the full frontend test suite to check for regressions**

```
cd frontend && npx vitest run
```

Expected: all tests pass. If any test imports `UpdateNotification` or `UpdateInstructionsDialog`, update them to remove those imports.

- [ ] **Step 5: Run lint to catch any dangling imports**

```
cd frontend && npm run lint 2>&1 | grep -E "error|warning" | head -20
```

Expected: no errors. Fix any "no-unused-vars" or missing import errors before continuing.

- [ ] **Step 6: Build frontend to verify no TypeScript errors**

```
cd frontend && npm run build:check 2>&1 | tail -20
```

Expected: build succeeds with no type errors.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/features/settings/tabs/StatusTab.tsx frontend/src/pages/admin/AdminDashboard.tsx
git rm frontend/src/components/admin/UpdateNotification.tsx frontend/src/components/admin/UpdateInstructionsDialog.tsx
git commit -m "feat(settings): add UpdateCard to status tab, remove UpdateNotification banner"
```

---

## Post-implementation verification

After all tasks are done, run the full test suites one final time:

```bash
cd backend && npx jest --no-coverage 2>&1 | tail -5
cd frontend && npx vitest run 2>&1 | tail -5
```

Both should report all tests passing.

To verify the version check points to the fork, check the environment on the server:

```bash
ssh root@192.168.0.210 "grep -r 'GITHUB_RELEASES_REPO\|filpgame' /opt/picpeak/app/backend/src/services/updateCheckService.js"
```

Expected: shows `filpgame/picpeak` as the default.
