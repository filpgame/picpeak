# Auto-Update Card — Design Spec

**Date:** 2026-05-30  
**Status:** Approved  

## Overview

Add an "Application Version" card to `/admin/settings?tab=status` that shows the current version, checks the personal fork (`filpgame/picpeak`) for new releases, and lets the admin trigger a one-click server update. Replaces the existing floating `UpdateNotification` banner.

---

## Architecture

### Approach

Backend spawns the existing `scripts/picpeak-setup.sh` as a detached process when the admin clicks "Update." The script handles git fetch → checkout latest tag → npm install → frontend build → migrations → `systemctl restart`. Frontend polls until the server comes back with the new version, then auto-reloads.

### Components Changed / Added

| Layer | File | Change |
|---|---|---|
| Backend service | `backend/src/services/updateCheckService.js` | Point GitHub releases API at `filpgame/picpeak` (via env var) |
| Backend route | `backend/src/routes/adminSystem.js` | Add `POST /updates/apply`, `GET /logs/download` |
| Frontend hook | `frontend/src/features/settings/hooks/useUpdateCard.ts` | New — update state machine + polling |
| Frontend component | `frontend/src/features/settings/components/UpdateCard.tsx` | New — renders all 6 states |
| Frontend tab | `frontend/src/features/settings/tabs/StatusTab.tsx` | Add `<UpdateCard />` as first card |
| i18n | `frontend/src/i18n/locales/*.json` (all 7) | Add `admin.updates.card.*` keys |
| Deleted | `frontend/src/components/admin/UpdateNotification.tsx` | Replaced by card |
| Deleted | `frontend/src/components/admin/UpdateInstructionsDialog.tsx` | No longer needed |
| Admin layout | wherever `<UpdateNotification />` is rendered | Remove usage |

---

## Backend

### `updateCheckService.js`

```js
const RELEASES_REPO = process.env.GITHUB_RELEASES_REPO || 'filpgame/picpeak';
// Use RELEASES_REPO in the GitHub API URL and releaseNotesUrl
```

Also update `releaseNotesUrl` in `adminSystem.js` to use the same constant.

### `POST /admin/system/updates/apply`

- **Auth:** `adminAuth` + `requirePermission('settings.edit')`
- **Guard:** module-level `let updateInProgress = false`; returns 409 if already running; resets to `false` only on spawn error (a successful spawn means the process keeps running after the Node process exits — the flag is irrelevant post-restart)
- **Spawn:** `spawn('bash', [scriptPath], { detached: true, stdio: 'ignore' })` + `child.unref()`
- **Script path:** resolved via `path.resolve(__dirname, '../../../scripts/picpeak-setup.sh')` (routes → src → backend → project root → scripts)
- **Response:** `202 { status: 'started', targetVersion: string }`
- **Error:** 500 on spawn failure, resets `updateInProgress`

### `GET /admin/system/logs/download`

- **Auth:** `adminAuth` + `requirePermission('settings.view')`
- **Query param:** `type` = `combined` (default) or `error`
- **File mapping:**
  - `combined` → `backend/logs/combined.log`
  - `error` → `backend/logs/error.log`
- **Headers:** `Content-Disposition: attachment; filename=picpeak-<type>.log`, `Content-Type: text/plain`
- **Stream:** `fs.createReadStream` — returns 404 if file does not exist

---

## Frontend

### `useUpdateCard.ts`

State union:
```ts
type UpdatePhase =
  | { phase: 'loading' }
  | { phase: 'idle'; current: string; channel: string; lastChecked: string }
  | { phase: 'update-available'; current: string; latest: string; channel: string; lastChecked: string }
  | { phase: 'updating'; targetVersion: string }
  | { phase: 'restarting'; targetVersion: string }
  | { phase: 'complete'; version: string }
  | { phase: 'error' }
```

Polling logic:
1. Fetch `/admin/system/updates` on mount (query key `['update-check']`, 1h stale time)
2. `triggerUpdate()`:
   - POST `/admin/system/updates/apply` → set `updating`
   - After 10s → set `restarting`
   - Poll `GET /admin/system/version` every 3s
   - When `version.backend` matches `targetVersion` → set `complete` → `window.location.reload()` after 2s
   - After 3 minutes total → set `error`
3. `checkAgain()`: `queryClient.invalidateQueries(['update-check'])` + `refetch()`
4. Cleanup: all timers/intervals cleared on unmount

### `UpdateCard.tsx`

Thin component consuming `useUpdateCard`. Renders:

| Phase | UI |
|---|---|
| `loading` | Skeleton rows |
| `idle` | Title + version row + "Up to date" badge + "Check again" link |
| `update-available` | Title + version row (current → latest) + "Update to vX.X.X" primary button + "Check again" link |
| `updating` | Disabled spinner button + info alert with update description |
| `restarting` | Disabled spinner button + info alert "Server is restarting…" |
| `complete` | "Up to date" badge + success alert "Updated to vX — reloading…" |
| `error` | "Retry" button + warning alert + download links for `combined.log` and `error.log` |

Log download links are plain `<a href="/api/admin/system/logs/download?type=combined">` — no JS, browser handles the file download.

Card position: **first card** in `StatusTab`, above Storage Overview.

### i18n Keys

Added under `admin.updates.card` in all 7 locale files (`de`, `en`, `es`, `fr`, `nl`, `pt`, `ru`):

```json
{
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

---

## Update Flow (sequence)

```
Admin clicks "Update to vX"
  → POST /admin/system/updates/apply (202)
  → UI: phase = 'updating'
  → [~10s] UI: phase = 'restarting'
  → Poll GET /admin/system/version every 3s
      ├─ version.backend === targetVersion → phase = 'complete' → reload
      └─ 3min elapsed → phase = 'error'
```

The backend process (`server.js`) is killed by `systemctl restart` mid-script. The detached bash process is independent of the Node process and continues running through the restart.

---

## Files Deleted

- `frontend/src/components/admin/UpdateNotification.tsx`
- `frontend/src/components/admin/UpdateInstructionsDialog.tsx`
- Remove `<UpdateNotification />` render site in admin layout

---

## Out of Scope

- Streaming log output during update (user chose spinner UX)
- Rollback on failure
- Separate updater daemon
- Scheduling updates
