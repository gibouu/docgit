# In-app Auto-Update — Design

Date: 2026-06-15
Status: Approved (pending spec review)
Tracking issue: #54

## Goal

Let an installed DocGit update itself instead of requiring a manual DMG
download + drag-to-Applications. On launch, the app checks GitHub Releases,
downloads a newer **notarized** build in the background, and shows a
non-blocking "Restart to update" banner. User data is untouched.

## Product decisions (locked)

- **On by default, with a clear opt-out.** Auto-update is enabled out of the
  box; a Settings toggle and a one-time first-run note explain the single
  network call (to GitHub Releases) and how to turn it off.
- **Silent download → prompt to restart.** electron-updater downloads in the
  background; a non-blocking banner offers "Restart to update". "Later" defers
  to next quit (`autoInstallOnAppQuit`).
- **Check on launch only.** One check per app start. No periodic polling.

## Approach

Use **`electron-updater`** (electron-builder's updater) with the GitHub
provider. It verifies the macOS code signature before installing, consumes the
`zip` + `latest-mac.yml` + blockmap that electron-builder produces, and emits
clean lifecycle events. Rejected alternatives: hand-rolled GitHub-API polling
(no signature verification, user still drags-to-install) and
`update-electron-app`/update.electronjs.org (routes checks through a
third-party server — wrong for a privacy-first, local-only app).

## Privacy stance

DocGit's headline is "local-only, zero network." Auto-update introduces
exactly **one** network interaction: the update check/download against GitHub
Releases. This is on by default, **disableable in Settings**, and documented.
No telemetry, no other host, ever. README + TECH-NOTES are updated to state
this carve-out explicitly.

---

## Components

Each unit has one responsibility and a narrow interface.

### 1. Release pipeline

**`apps/desktop/electron-builder.yml`**
- Add a `zip` mac target alongside `dir` + `dmg` (electron-updater cannot
  update from a DMG; it needs the zip).
- Add a `publish` block so electron-builder writes the updater feed
  (`latest-mac.yml`) and bundles `app-update.yml` into the app Resources:
  ```yaml
  publish:
    provider: github
    owner: gibouu
    repo: docgit
  ```
- Notarization (`notarize: true`, hardenedRuntime) already applies to all mac
  targets, so the zip is notarized too. `npmRebuild: false` and the
  bundle-everything `files` list are unchanged.

**`.github/workflows/release.yml`**
- The release step currently uploads only `apps/desktop/release/*.dmg`. Extend
  it to also upload the updater feed artifacts:
  `*.dmg`, `*.zip`, `*.zip.blockmap`, `*-mac.yml` (i.e. `latest-mac.yml`).
- Keep using `gh release create` (do NOT switch to electron-builder
  `--publish always`, to keep signing creds and release creation as-is); the
  `publish` config in electron-builder.yml is only there to *generate*
  `latest-mac.yml` + `app-update.yml`, not to upload.

### 2. Settings store — `apps/desktop/src/main/settings.ts`

No general settings store exists today. Add a tiny one (no new dependency):
- Reads/writes `settings.json` in `app.getPath('userData')` (same dir as
  `docgit.db`).
- Shape: `{ autoUpdate: boolean; seenUpdateNote: boolean }`, default
  `{ autoUpdate: true, seenUpdateNote: false }` (`seenUpdateNote` gates the
  one-time first-run note).
- API: `getSettings(): AppSettings`, `setSetting<K>(key, value): AppSettings`.
- Tolerant of a missing/corrupt file (returns defaults; never throws into the
  app). Pure, unit-testable.

### 3. Updater module — `apps/desktop/src/main/updater.ts`

Wraps `electron-updater.autoUpdater`. One responsibility: drive the update
lifecycle and report state to the renderer.
- Config: `autoDownload = true`, `autoInstallOnAppQuit = true`,
  `autoUpdater.logger = <activity.log writer>`.
- **Hard guard:** does nothing unless `app.isPackaged` is true — so dev,
  `DOCGIT_SMOKE`, and `DOCGIT_BOOT_CHECK` never make a network call
  (electron-updater also refuses when unpackaged). A `dev-app-update.yml` is
  added so the wiring *can* be exercised against a fake local feed without
  network, but the real check only runs in packaged builds.
- `initAutoUpdate(getWindow, settings)`:
  - Registers event handlers (`checking-for-update`, `update-available`,
    `update-not-available`, `download-progress`, `update-downloaded`,
    `error`) that push a small `UpdateState` to the renderer over IPC and log
    each transition.
  - If `app.isPackaged && settings.autoUpdate`, calls `checkForUpdates()` once.
- State machine surfaced to the renderer:
  `UpdateState = { status: 'idle'|'checking'|'available'|'downloading'|'ready'|'error'|'disabled', version?: string, percent?: number }`.
- IPC (registered next to the existing handlers in `main/index.ts`):
  - `update:getState` → current `UpdateState`
  - `update:check` → manual check (ignores the enabled flag; for the "Check
    now" button)
  - `update:install` → `autoUpdater.quitAndInstall()`
  - `update:setEnabled(enabled)` → persists via settings; if just enabled,
    triggers a check
  - push channel `docgit:update` → renderer subscribes for live state
- **Errors never crash or block.** Offline / rate-limited / signature-mismatch
  → a log line + `status:'error'`; the app works fully with no network.

### 4. Renderer

**`apps/desktop/src/renderer/src/components/UpdateBanner.tsx`** — a
non-blocking bar shown when `status === 'ready'`: "DocGit vX.Y.Z is ready —
[Restart to update] [Later]". "Restart" → `update:install`; "Later" dismisses
(installs on next quit anyway). Subscribes to `docgit:update`.

**Settings popover** — a gear button in the library header opening a small
popover with:
- **Automatic updates** toggle (`update:setEnabled`).
- Current version + a **Check now** button (`update:check`) reflecting state
  (Checking… / Up to date / vX.Y.Z downloading… / Ready).

**First-run note** — a one-time modal (gated by a `seenUpdateNote` flag in
settings) explaining the single GitHub call and pointing at the toggle.

### 5. Docs

- `README.md`: revise the "local-only, zero network" line to note the single,
  disableable update check.
- `docs/TECH-NOTES.md`: a section documenting the updater (electron-updater +
  GitHub, signature-verified, launch-only, opt-out), and the one residual
  network exception to the privacy promise.

---

## Data flow

```
launch (packaged) → initAutoUpdate
  settings.autoUpdate? ── no → status:'disabled'
        │ yes
        ▼
  autoUpdater.checkForUpdates()
   ├─ update-not-available → status:'idle'
   ├─ error → status:'error' (logged; app unaffected)
   └─ update-available → status:'available'
         ▼ (autoDownload)
       download-progress → status:'downloading', percent
         ▼
       update-downloaded → status:'ready', version
         ▼ renderer banner
       user: Restart → update:install → quitAndInstall()
       user: Later  → installs on next app quit
```

## Error handling

- Every updater failure path resolves to a logged `status:'error'`; no dialog,
  no retry storm (launch-only).
- The app must run identically with networking disabled — verified by the
  `app.isPackaged` guard (dev/smoke never check) and by reasoning about the
  error events.

## Testing

- **Unit (vitest):** `settings.ts` — defaults when file is missing/corrupt;
  round-trip read/write of `autoUpdate` + `seenUpdateNote`. (This is the only
  cleanly unit-testable unit; place it where the desktop build can run it, or
  as a focused node test.)
- **Smoke / typecheck:** `pnpm typecheck`; `pnpm --filter @docgit/desktop
  smoke` must still pass with the updater wired — i.e. the `app.isPackaged`
  guard makes `initAutoUpdate` a no-op under `DOCGIT_SMOKE`/`DOCGIT_BOOT_CHECK`
  (assert no network call / no throw). Extend the boot check to confirm the
  renderer mounts with the updater IPC present.
- **Build artifact check:** `pnpm --filter @docgit/desktop dist` produces
  `*.dmg`, `*.zip`, `*.zip.blockmap`, and `latest-mac.yml` in
  `apps/desktop/release/`. (Local run is unsigned but proves the artifact
  set.)

### ⚠️ Verification limit (explicit)

True end-to-end auto-update — an installed build detecting, downloading, and
installing a newer release — **can only be verified by a real signed release
cycle** the maintainer runs: push `vN`, install the DMG, push `vN+1`, observe
the installed app self-update. There is no way to click-test real auto-update
locally or in CI. This feature therefore ships as **wired + pipeline-ready**;
the live confirmation happens on the next tagged release. The acceptance
checklist in #54 records this as the final, human-run gate.

## Out of scope

- Delta/differential updates (electron-updater does blockmap deltas
  automatically where possible; no extra work, not a requirement).
- A dedicated update server (GitHub Releases suffices).
- Windows/Linux updaters (DocGit is mac-only).
- Periodic background checks (decided: launch-only).

## Build order

1. Release pipeline (electron-builder.yml + release.yml) — get the feed
   artifacts produced first; verify via `dist`.
2. `settings.ts` (+ unit tests).
3. `updater.ts` + IPC wiring + preload/types + `app.isPackaged` guard; smoke
   stays green.
4. Renderer: UpdateBanner, Settings popover, first-run note.
5. Docs (README + TECH-NOTES).
