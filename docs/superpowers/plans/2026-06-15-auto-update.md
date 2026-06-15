# In-app Auto-Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an installed DocGit check GitHub Releases on launch, download a newer notarized build in the background, and offer a non-blocking "Restart to update" banner — on by default, disableable in Settings.

**Architecture:** `electron-updater` (GitHub provider) driven from a guarded main-process module, fed by `zip` + `latest-mac.yml` artifacts the release pipeline now publishes. A tiny JSON settings store holds the opt-out flag. The renderer shows a banner + a settings popover + a one-time privacy note. Everything is hard-guarded by `app.isPackaged`, so dev/smoke/boot never touch the network.

**Tech Stack:** Electron, electron-vite (bundles deps — packaged app ships no node_modules), electron-builder, electron-updater, React, `node:fs`/`node:sqlite`.

**Spec:** `docs/superpowers/specs/2026-06-15-auto-update-design.md` · **Tracking:** issue #54

**Repo rules:** No signatures/footers on commits or PRs. Update `docs/TECH-NOTES.md` for shipped limits. Verify with `pnpm build && pnpm typecheck && pnpm test` and `pnpm --filter @docgit/desktop smoke`.

**Critical build facts (verified):**
- `apps/desktop/electron.vite.config.ts` bundles deps via `externalizeDepsPlugin({ exclude: [...] })`. The packaged app has NO `node_modules`, so **`electron-updater` MUST be added to that `exclude` list** to be bundled. The smoke test imports the whole main bundle, so a broken `electron-updater` bundle makes smoke fail on import — that's our real "did it bundle?" check.
- There is no `is.dev` helper; use **`app.isPackaged`** (false in `pnpm dev` and in `electron out/main/index.js` smoke/boot runs) as the network guard.
- The desktop package has **no vitest harness** (`"test": "echo ..."`). Desktop-side logic is verified by `pnpm --filter @docgit/desktop smoke` (headless Electron) + `pnpm typecheck`. So `settings.ts` is written electron-free (takes a `dir` argument) and verified inside `runSmokeTest`.

**Build order (each task is independently committable):**
1. Release pipeline (artifacts) — Task 1
2. Settings store — Task 2
3. Updater module + IPC + preload + guard — Task 3
4. Renderer: UpdateBanner — Task 4
5. Renderer: Settings popover + first-run note — Task 5
6. Docs — Task 6

Branch: `feat/auto-update` (already created off main).

---

## Task 1: Release pipeline — publish updater artifacts

**Files:**
- Modify: `apps/desktop/electron-builder.yml`
- Modify: `.github/workflows/release.yml`

- [ ] **Step 1: Add the `zip` target + `publish` block to electron-builder.yml**

In `apps/desktop/electron-builder.yml`, change the `mac.target` list to include `zip`, and add a top-level `publish` block (electron-updater needs the zip + `latest-mac.yml`; the `publish` config makes electron-builder emit `latest-mac.yml` and bundle `app-update.yml` into the app — it does NOT upload, since the workflow still uploads via `gh`):

```yaml
mac:
  icon: build/icon.icns
  category: public.app-category.productivity
  target:
    - target: dir
    - target: dmg
    - target: zip
  hardenedRuntime: true
  gatekeeperAssess: false
  notarize: true
publish:
  provider: github
  owner: gibouu
  repo: docgit
```
(Leave the `dmg:` block and everything else unchanged.)

- [ ] **Step 2: Upload the updater feed in release.yml**

In `.github/workflows/release.yml`, change the `gh release create` file list from only `*.dmg` to include the zip, its blockmap, and the yml feed:

```yaml
      - name: Create release with DMG + update feed
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          gh release create "${GITHUB_REF_NAME}" \
            --title "DocGit ${GITHUB_REF_NAME}" \
            --generate-notes \
            apps/desktop/release/*.dmg \
            apps/desktop/release/*.zip \
            apps/desktop/release/*.zip.blockmap \
            apps/desktop/release/latest-mac.yml
```

- [ ] **Step 3: Verify the artifact set is produced locally**

Run: `pnpm --filter @docgit/desktop dist`
Expected: completes (unsigned locally is fine) and `apps/desktop/release/` contains a `.dmg`, a `.zip`, a `.zip.blockmap`, and `latest-mac.yml`.
Check: `ls apps/desktop/release/ | grep -E '\.dmg$|\.zip$|\.zip\.blockmap$|latest-mac\.yml'` lists all four.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/electron-builder.yml .github/workflows/release.yml
git commit -m "release: publish zip + latest-mac.yml update feed for auto-update"
```

---

## Task 2: Settings store

**Files:**
- Create: `apps/desktop/src/main/settings.ts`
- Modify: `apps/desktop/src/main/index.ts` (smoke assertions in `runSmokeTest`)

- [ ] **Step 1: Write `settings.ts` (electron-free, dir-injected)**

Create `apps/desktop/src/main/settings.ts`:

```ts
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** App-level preferences, stored as JSON next to the version database. */
export interface AppSettings {
  /** Check GitHub Releases for updates on launch. */
  autoUpdate: boolean;
  /** Whether the one-time auto-update privacy note has been shown. */
  seenUpdateNote: boolean;
}

const DEFAULTS: AppSettings = { autoUpdate: true, seenUpdateNote: false };

/**
 * Tiny JSON-backed settings store. `dir` is the data directory
 * (`app.getPath('userData')` in the app; a temp dir in tests). Never throws
 * into the app: a missing or corrupt file yields defaults.
 */
export class Settings {
  private file: string;
  private cache: AppSettings;

  constructor(dir: string) {
    this.file = join(dir, 'settings.json');
    this.cache = this.read();
  }

  private read(): AppSettings {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<AppSettings>;
      return { ...DEFAULTS, ...parsed };
    } catch {
      return { ...DEFAULTS };
    }
  }

  get(): AppSettings {
    return { ...this.cache };
  }

  set<K extends keyof AppSettings>(key: K, value: AppSettings[K]): AppSettings {
    this.cache = { ...this.cache, [key]: value };
    try {
      writeFileSync(this.file, JSON.stringify(this.cache, null, 2));
    } catch {
      // persistence is best-effort; in-memory cache still reflects the change
    }
    return this.get();
  }
}
```

- [ ] **Step 2: Add settings assertions to the smoke test**

In `apps/desktop/src/main/index.ts`, inside `runSmokeTest` (just before the final `console.log('SMOKE OK'...)` at ~line 500), add a self-contained settings round-trip check. First add the import at the top with the other local imports:

```ts
import { Settings } from './settings.js';
```

Then inside `runSmokeTest`'s `try` block, before `console.log('SMOKE OK'...)`:

```ts
    // Settings store: defaults, persistence, and corrupt-file tolerance.
    const s1 = new Settings(dir);
    if (s1.get().autoUpdate !== true || s1.get().seenUpdateNote !== false) {
      throw new Error('settings defaults wrong');
    }
    s1.set('autoUpdate', false);
    s1.set('seenUpdateNote', true);
    const s2 = new Settings(dir); // re-read from disk
    if (s2.get().autoUpdate !== false || s2.get().seenUpdateNote !== true) {
      throw new Error('settings did not persist');
    }
    writeFileSync(join(dir, 'settings.json'), '{ this is not json');
    if (new Settings(dir).get().autoUpdate !== true) {
      throw new Error('corrupt settings should fall back to defaults');
    }
```
(`writeFileSync` and `join` are already imported in the smoke scope via the top-of-file `node:fs`/`node:path` imports — verify; `writeFileSync` is destructured at the top of `runSmokeTest` from `node:fs`. If not present there, add `writeFileSync` to that destructure.)

- [ ] **Step 3: Verify**

Run: `pnpm --filter @docgit/desktop smoke`
Expected: `SMOKE OK ...` (settings assertions pass) and `BOOT CHECK OK`.
Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/main/settings.ts apps/desktop/src/main/index.ts
git commit -m "desktop: JSON app-settings store (autoUpdate opt-out), verified in smoke"
```

---

## Task 3: Updater module + IPC + preload

**Files:**
- Modify: `apps/desktop/package.json` (add `electron-updater`)
- Modify: `apps/desktop/electron.vite.config.ts` (bundle `electron-updater`)
- Create: `apps/desktop/src/main/updater.ts`
- Modify: `apps/desktop/src/main/index.ts` (init + IPC + Settings wiring)
- Modify: `apps/desktop/src/preload/index.ts` + `apps/desktop/src/preload/api.d.ts`

- [ ] **Step 1: Add the dependency**

Run: `pnpm --filter @docgit/desktop add -D electron-updater`
(Dev-dep is correct here — the desktop package keeps all deps in `devDependencies` because electron-vite bundles them.)

- [ ] **Step 2: Bundle electron-updater (electron-vite exclude list)**

In `apps/desktop/electron.vite.config.ts`, add `'electron-updater'` to the `main` plugin's exclude array so it's bundled into `out/main` (the packaged app has no node_modules):

```ts
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['@docgit/core', '@docgit/ui', 'chokidar', 'fflate', 'electron-updater'] })],
  },
```

- [ ] **Step 3: Write `updater.ts`**

Create `apps/desktop/src/main/updater.ts`:

```ts
import { app, type BrowserWindow } from 'electron';
import electronUpdater from 'electron-updater';
import { appendFileSync } from 'node:fs';

const { autoUpdater } = electronUpdater;

export interface UpdateState {
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error' | 'disabled';
  version?: string;
  percent?: number;
}

type Send = (state: UpdateState) => void;

let state: UpdateState = { status: 'idle' };

export function getUpdateState(): UpdateState {
  return state;
}

/**
 * Wire electron-updater to the renderer. Network access is hard-gated by
 * `app.isPackaged`, so dev, smoke, and boot-check never reach out. Every
 * failure resolves to a logged `error` state — the app works fully offline.
 */
export function initUpdater(send: Send, logPath: string, autoUpdate: boolean): void {
  const log = (msg: string) => {
    try {
      appendFileSync(logPath, `${new Date().toISOString()}  updater ${msg}\n`);
    } catch {
      // logging must never break the app
    }
  };

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = { info: log, warn: log, error: log, debug: () => {} } as never;

  const set = (next: UpdateState) => {
    state = next;
    send(state);
  };

  autoUpdater.on('checking-for-update', () => set({ status: 'checking' }));
  autoUpdater.on('update-available', (info) => set({ status: 'available', version: info.version }));
  autoUpdater.on('update-not-available', () => set({ status: 'idle' }));
  autoUpdater.on('download-progress', (p) => set({ status: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => set({ status: 'ready', version: info.version }));
  autoUpdater.on('error', (err) => {
    log(`error ${String(err)}`);
    set({ status: 'error' });
  });

  if (!app.isPackaged) {
    set({ status: 'disabled' });
    return;
  }
  if (autoUpdate) void autoUpdater.checkForUpdates();
  else set({ status: 'disabled' });
}

/** Manual check (the "Check now" button) — ignores the enabled flag. */
export function checkForUpdatesNow(): void {
  if (!app.isPackaged) return;
  void autoUpdater.checkForUpdates();
}

/** Quit and install a downloaded update. */
export function quitAndInstall(): void {
  autoUpdater.quitAndInstall();
}
```

- [ ] **Step 4: Wire init + IPC in index.ts**

In `apps/desktop/src/main/index.ts`:

1. Add imports near the top:
```ts
import { Settings } from './settings.js';
import { initUpdater, getUpdateState, checkForUpdatesNow, quitAndInstall, type UpdateState } from './updater.js';
```

2. Add a module-level `let settings: Settings;` next to the existing `let service` / `let win` declarations.

3. In the normal launch path of `app.whenReady().then(...)` (after `createWindow();`), initialize settings + updater:
```ts
  settings = new Settings(app.getPath('userData'));
  initUpdater(sendUpdateState, join(app.getPath('userData'), 'activity.log'), settings.get().autoUpdate);
```

4. Add a `sendUpdateState` helper near the existing `notifyRenderer`:
```ts
function sendUpdateState(state: UpdateState): void {
  win?.webContents.send('docgit:update', state);
}
```

5. Register IPC handlers inside `registerIpc` (or a small `registerUpdateIpc(settings)` called from the normal path — note: smoke/boot call `registerIpc` without settings, so guard the settings-dependent handlers). Add to `registerIpc`:
```ts
  ipcMain.handle('update:getState', () => getUpdateState());
  ipcMain.handle('update:check', () => checkForUpdatesNow());
  ipcMain.handle('update:install', () => quitAndInstall());
  ipcMain.handle('update:settings', () => (settings ? settings.get() : { autoUpdate: true, seenUpdateNote: false }));
  ipcMain.handle('update:setEnabled', (_e, enabled: boolean) => {
    if (!settings) return { autoUpdate: enabled, seenUpdateNote: false };
    const next = settings.set('autoUpdate', enabled);
    if (enabled) checkForUpdatesNow();
    return next;
  });
  ipcMain.handle('update:markNoteSeen', () => (settings ? settings.set('seenUpdateNote', true) : { autoUpdate: true, seenUpdateNote: true }));
```
(Because `settings` is only assigned in the normal path, smoke/boot-check — which call `registerIpc` directly — safely hit the `settings ?` fallbacks. This keeps the smoke/boot harness network- and state-free.)

- [ ] **Step 5: Preload bridge + types**

In `apps/desktop/src/preload/index.ts`, add to the `api` object:
```ts
  updateState: () => ipcRenderer.invoke('update:getState'),
  checkForUpdate: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  updateSettings: () => ipcRenderer.invoke('update:settings'),
  setAutoUpdate: (enabled: boolean) => ipcRenderer.invoke('update:setEnabled', enabled),
  markUpdateNoteSeen: () => ipcRenderer.invoke('update:markNoteSeen'),
  onUpdate: (callback: (state: unknown) => void) => {
    const listener = (_event: unknown, state: unknown) => callback(state);
    ipcRenderer.on('docgit:update', listener);
    return () => ipcRenderer.removeListener('docgit:update', listener);
  },
```

In `apps/desktop/src/preload/api.d.ts`, add an exported type + methods to `DocgitApi`:
```ts
export interface UpdateState {
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error' | 'disabled';
  version?: string;
  percent?: number;
}
export interface AppSettings {
  autoUpdate: boolean;
  seenUpdateNote: boolean;
}
```
and inside `interface DocgitApi { ... }`:
```ts
  updateState(): Promise<UpdateState>;
  checkForUpdate(): Promise<void>;
  installUpdate(): Promise<void>;
  updateSettings(): Promise<AppSettings>;
  setAutoUpdate(enabled: boolean): Promise<AppSettings>;
  markUpdateNoteSeen(): Promise<AppSettings>;
  onUpdate(callback: (state: UpdateState) => void): () => void;
```

- [ ] **Step 6: Verify (this proves electron-updater bundled)**

Run: `pnpm typecheck`
Expected: clean.
Run: `pnpm --filter @docgit/desktop smoke`
Expected: `SMOKE OK` + `BOOT CHECK OK`. (Smoke imports the full main bundle, which now imports `updater.ts` → `electron-updater`; passing smoke confirms it bundles and resolves. The `app.isPackaged` guard means no network call happens.)

> If smoke FAILS on an `electron-updater` import/resolve error (Rollup can choke on its dynamic requires), fall back: remove it from the electron-vite `exclude` (keep it external) and pack it by adding `node_modules/electron-updater/**` + its transitive deps to electron-builder.yml `files`. Re-verify smoke. Note whichever path was taken in the commit message.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/package.json apps/desktop/pnpm-lock.yaml ../../pnpm-lock.yaml apps/desktop/electron.vite.config.ts apps/desktop/src/main/updater.ts apps/desktop/src/main/index.ts apps/desktop/src/preload
git commit -m "desktop: electron-updater module + IPC, app.isPackaged-guarded (no-op in dev/smoke)"
```
(Adjust the lockfile path to whatever `git status` shows.)

---

## Task 4: Renderer — UpdateBanner

**Files:**
- Create: `apps/desktop/src/renderer/src/components/UpdateBanner.tsx`
- Modify: `apps/desktop/src/renderer/src/App.tsx` (mount the banner)
- Modify: `apps/desktop/src/renderer/src/styles.css` (banner styles)

- [ ] **Step 1: Write the banner component**

Create `apps/desktop/src/renderer/src/components/UpdateBanner.tsx`:

```tsx
import { useEffect, useState } from 'react';
import type { UpdateState } from '../../../preload/api';

/** Non-blocking bar shown when a downloaded update is ready to install. */
export function UpdateBanner() {
  const [state, setState] = useState<UpdateState>({ status: 'idle' });
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    void window.docgit.updateState().then(setState);
    return window.docgit.onUpdate((s) => {
      setState(s);
      setDismissed(false); // a newly-ready update re-shows the bar
    });
  }, []);

  if (state.status !== 'ready' || dismissed) return null;

  return (
    <div className="update-banner" role="status">
      <span>
        DocGit {state.version ? `v${state.version}` : ''} is ready to install.
      </span>
      <span className="update-banner-actions">
        <button type="button" className="btn btn-primary btn-mini" onClick={() => void window.docgit.installUpdate()}>
          Restart to update
        </button>
        <button type="button" className="btn btn-mini" onClick={() => setDismissed(true)}>
          Later
        </button>
      </span>
    </div>
  );
}
```

- [ ] **Step 2: Mount it at app level**

In `apps/desktop/src/renderer/src/App.tsx`, import and render `<UpdateBanner />` as the first child inside the top-level `.app` container (above the titlebar/content), so it spans the window. Read App.tsx first to match its structure; add:
```tsx
import { UpdateBanner } from './components/UpdateBanner.js';
```
and place `<UpdateBanner />` just inside the root element's JSX.

- [ ] **Step 3: Styles**

Append to `apps/desktop/src/renderer/src/styles.css`:
```css
.update-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 8px 16px;
  font-size: 12.5px;
  color: var(--dg-accent-ink);
  background: var(--dg-accent);
  -webkit-app-region: no-drag;
}
.update-banner-actions { display: flex; gap: 8px; flex: none; }
.update-banner .btn-mini { padding: 4px 10px; }
```

- [ ] **Step 4: Verify**

Run: `pnpm typecheck && pnpm --filter @docgit/desktop smoke`
Expected: both green (BOOT CHECK loads the renderer with the banner mounted; it renders nothing while status is idle).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer
git commit -m "desktop: non-blocking update-ready banner"
```

---

## Task 5: Renderer — Settings popover + first-run note

**Files:**
- Create: `apps/desktop/src/renderer/src/components/SettingsMenu.tsx`
- Modify: `apps/desktop/src/renderer/src/views/Library.tsx` (gear button in header)
- Modify: `apps/desktop/src/renderer/src/App.tsx` (first-run note modal)
- Modify: `apps/desktop/src/renderer/src/styles.css`

- [ ] **Step 1: Settings popover component**

Create `apps/desktop/src/renderer/src/components/SettingsMenu.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import type { AppSettings, UpdateState } from '../../../preload/api';

const STATUS_LABEL: Record<UpdateState['status'], string> = {
  idle: 'Up to date',
  checking: 'Checking…',
  available: 'Update found…',
  downloading: 'Downloading…',
  ready: 'Ready — restart to update',
  error: "Couldn't check",
  disabled: 'Automatic updates off',
};

export function SettingsMenu({ version }: { version: string }) {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [update, setUpdate] = useState<UpdateState>({ status: 'idle' });
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    void window.docgit.updateSettings().then(setSettings);
    void window.docgit.updateState().then(setUpdate);
    const offUpdate = window.docgit.onUpdate(setUpdate);
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      offUpdate();
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="settings-wrap" ref={wrapRef}>
      <button type="button" className="btn" aria-label="Settings" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        ⚙
      </button>
      {open && (
        <div className="settings-popover" role="menu">
          <label className="settings-row">
            <input
              type="checkbox"
              checked={settings?.autoUpdate ?? true}
              onChange={async (e) => setSettings(await window.docgit.setAutoUpdate(e.target.checked))}
            />
            Automatic updates
          </label>
          <p className="settings-hint">
            Checks GitHub for a new version on launch — the only time DocGit uses the network.
          </p>
          <div className="settings-row settings-status">
            <span>{STATUS_LABEL[update.status]}{update.status === 'downloading' && update.percent != null ? ` ${update.percent}%` : ''}</span>
            <button type="button" className="btn btn-mini" onClick={() => void window.docgit.checkForUpdate()}>
              Check now
            </button>
          </div>
          <p className="settings-version">DocGit v{version}</p>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Add the gear to the library header + pass the version**

In `apps/desktop/src/renderer/src/views/Library.tsx`, import `SettingsMenu` and render it in the `.library-actions` group (before "+ Add document"). The app version is available via `window.docgit` only if exposed; instead read it from the package at build time is awkward — pass an empty string fallback or wire a tiny `app:version` if needed. SIMPLEST: render `<SettingsMenu version={__APP_VERSION__} />` where `__APP_VERSION__` is injected; if that's not already configured, render `<SettingsMenu version="" />` and have the component hide the version line when empty. To avoid build-config scope, use the empty-string approach and guard the version line:
  - In `SettingsMenu`, change the version line to `{version && <p className="settings-version">DocGit v{version}</p>}`.
  - In `Library.tsx`: `<SettingsMenu version="" />`.

(Showing the live version is a nice-to-have; wiring `app.getVersion()` through IPC can be a follow-up. Keep this task scoped to the toggle + check-now.)

- [ ] **Step 3: First-run privacy note**

In `apps/desktop/src/renderer/src/App.tsx`, add a one-time modal gated by settings. On mount, read settings; if `!seenUpdateNote`, show a `Modal` (reuse `../components/Modal`) explaining auto-update + the single network call, with an "OK" button that calls `window.docgit.markUpdateNoteSeen()` and closes. Add:
```tsx
import { useEffect, useState } from 'react';
import { Modal } from './components/Modal.js';
// ...
const [showUpdateNote, setShowUpdateNote] = useState(false);
useEffect(() => {
  void window.docgit.updateSettings().then((s) => setShowUpdateNote(!s.seenUpdateNote));
}, []);
// in JSX:
{showUpdateNote && (
  <Modal title="DocGit keeps itself up to date" onClose={() => { void window.docgit.markUpdateNoteSeen(); setShowUpdateNote(false); }}>
    <p className="modal-hint">
      DocGit now checks GitHub for a new version when it starts, and installs updates in the background.
      This is the only time DocGit uses the network — everything else stays on your Mac. You can turn it
      off any time under ⚙ Settings.
    </p>
    <div className="modal-actions">
      <button type="button" className="btn btn-primary" onClick={() => { void window.docgit.markUpdateNoteSeen(); setShowUpdateNote(false); }}>
        Got it
      </button>
    </div>
  </Modal>
)}
```

- [ ] **Step 4: Styles**

Append to `styles.css`:
```css
.settings-wrap { position: relative; display: inline-block; }
.settings-popover {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  min-width: 240px;
  z-index: 20;
  background: var(--dg-paper-raised);
  border: 1px solid var(--dg-hairline);
  border-radius: 10px;
  box-shadow: 0 8px 28px rgba(33, 29, 24, 0.14);
  padding: 12px 14px;
}
.settings-row { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.settings-status { justify-content: space-between; margin-top: 10px; }
.settings-hint { margin: 6px 0 0; font-size: 11.5px; color: var(--dg-ink-soft); }
.settings-version { margin: 10px 0 0; font-size: 11px; color: var(--dg-ink-soft); }
```

- [ ] **Step 5: Verify**

Run: `pnpm typecheck && pnpm --filter @docgit/desktop smoke`
Expected: both green. (Boot check renders the renderer; the first-run note reads settings via IPC — the `settings ?` fallback returns `seenUpdateNote:false`, so the modal renders without error.)

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer
git commit -m "desktop: settings popover (auto-update toggle + check now) and first-run note"
```

---

## Task 6: Docs

**Files:**
- Modify: `README.md`
- Modify: `docs/TECH-NOTES.md`

- [ ] **Step 1: README privacy wording**

In `README.md`, find the privacy/"zero network" / "nothing leaves this Mac" claim and revise it to carve out the update check. Replace the absolute claim with, e.g.:
> Everything stays on your Mac. The one exception: DocGit checks GitHub for a new version when it launches and can update itself — on by default, and switchable off under ⚙ Settings. No other network use, no telemetry.

Also, in the Download section, add a line: "Once installed, DocGit updates itself — no need to re-download."

- [ ] **Step 2: TECH-NOTES entry**

Append a new section to `docs/TECH-NOTES.md`:
```markdown
## 8. Auto-update

- **electron-updater, GitHub provider, launch-only.** Packaged builds check
  the repo's Releases on startup, download a newer **notarized** build in the
  background, and prompt "Restart to update". The macOS code signature is
  verified before install. On by default; opt out under ⚙ Settings
  (`autoUpdate` in `settings.json`, next to the database).
- **Privacy exception.** This is the only network call DocGit makes. It can be
  disabled; no telemetry is sent and no other host is contacted.
- **Release feed.** `release.yml` publishes the DMG (first install) plus the
  `zip` + `latest-mac.yml` (+ blockmap) that electron-updater consumes. The
  `zip` target and `publish:` block live in `electron-builder.yml`.
- **Bundling.** `electron-updater` is in the electron-vite `exclude` list so
  it's bundled into `out/main` (the packaged app ships no node_modules). The
  smoke test imports the main bundle, so a broken updater bundle fails CI.
- **Verification limit.** Real download-and-install is only exercisable via a
  live signed release cycle (tag vN → install → tag vN+1 → observe self-update)
  — there's no local/CI click-test. Confirm on the next tagged release.
- **Dev/smoke are inert.** Guarded by `app.isPackaged`; dev runs and the
  headless smoke/boot checks never reach the network.
```

- [ ] **Step 3: Verify + commit**

Run: `pnpm build && pnpm typecheck && pnpm --filter @docgit/desktop smoke`
Expected: all green.
```bash
git add README.md docs/TECH-NOTES.md
git commit -m "docs: document auto-update + revise the zero-network privacy claim"
```

---

## Final verification

- [ ] `pnpm build && pnpm typecheck && pnpm test && pnpm --filter @docgit/desktop smoke` — all green.
- [ ] `pnpm --filter @docgit/desktop dist` produces `.dmg`, `.zip`, `.zip.blockmap`, `latest-mac.yml`.
- [ ] Issue #54 acceptance boxes ticked except the human-run live-release gate.
- [ ] **Hand-off note to the user:** the live end-to-end test (tag vN → install → tag vN+1 → self-update) is theirs to run on the next release; everything else is wired and verified.

---

## Self-Review

**Spec coverage:**
- Release pipeline (zip + publish + feed upload) → Task 1 ✓
- Settings store with opt-out + seenUpdateNote, default-tolerant → Task 2 ✓
- Updater module, autoDownload + autoInstallOnAppQuit, app.isPackaged guard, state machine, IPC (getState/check/install/setEnabled/markNoteSeen), push channel, error-swallowing → Task 3 ✓
- electron-updater dependency + bundling via exclude list (+ fallback noted) → Task 3 ✓
- UpdateBanner (ready → Restart/Later) → Task 4 ✓
- Settings popover (toggle + check now) + first-run note → Task 5 ✓
- Privacy docs (README + TECH-NOTES) → Task 6 ✓
- Verification limit called out → Final verification + Task 6 TECH-NOTES ✓

**Placeholder scan:** No TBD/TODO. The one deliberately deferred nicety (live version string in the settings popover) is scoped out explicitly with an empty-string fallback, not left as a placeholder. The electron-vite-bundling fallback is a real, specified contingency, not a vague "handle errors."

**Type consistency:** `UpdateState`/`AppSettings` shapes match across `updater.ts`, `settings.ts`, preload `api.d.ts`, and the renderer components. IPC channel names match exactly between `main/index.ts` (`update:getState`/`update:check`/`update:install`/`update:settings`/`update:setEnabled`/`update:markNoteSeen`, push `docgit:update`) and the preload bridge. Preload method names (`updateState`/`checkForUpdate`/`installUpdate`/`updateSettings`/`setAutoUpdate`/`markUpdateNoteSeen`/`onUpdate`) are used identically in Task 4/5 components.
