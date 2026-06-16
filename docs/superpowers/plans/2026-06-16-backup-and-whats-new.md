# Backup/Export + "What's New" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show release notes when an update is ready (#58), and let users back up / restore the history database and reveal the data folder (#57).

**Architecture:** Both extend the auto-update/settings wiring already on main. #58 threads `releaseNotes` from `electron-updater` through `UpdateState` → IPC → the banner. #57 adds a pure `backup.ts` (copy/validate/restore the single `docgit.db`, which already contains all version content), wired through IPC to the Settings popover; restore = replace-with-safety-copy + relaunch.

**Tech Stack:** Electron, electron-updater, electron-vite (bundles deps), `node:sqlite`, `node:fs`, React.

**Spec:** `docs/superpowers/specs/2026-06-16-backup-and-whats-new-design.md`. **Issues:** #58, #57.

**Repo facts (verified on this branch):**
- `UpdateState` is defined in BOTH `apps/desktop/src/main/updater.ts` and `apps/desktop/src/preload/api.d.ts` (process boundary) — keep them in sync.
- `update-downloaded` handler is at `updater.ts` (`autoUpdater.on('update-downloaded', (info) => set({ status: 'ready', version: info.version }))`).
- `DocumentService.dispose()` (`service.ts:123`) closes watchers + the store; `service` is a module-level `let` in `index.ts`; the DB path is `join(app.getPath('userData'), 'docgit.db')`.
- IPC registered in `registerIpc(svc)` in `index.ts`; preload bridge in `preload/index.ts`; types in `preload/api.d.ts`. Push channel `docgit:update`.
- Settings popover: `apps/desktop/src/renderer/src/components/SettingsMenu.tsx` (gear in the library header).
- Verification: `pnpm typecheck` + `pnpm --filter @docgit/desktop smoke` (no renderer unit harness; smoke is headless Electron and runs `runSmokeTest` in `index.ts` ~line 169, ending with `console.log('SMOKE OK'...)`). `node:sqlite`'s `DatabaseSync` is available in main.

**Repo rules:** No signatures/footers. Update `docs/TECH-NOTES.md` for the restore caveat. Branch: `feat/backup-and-whats-new` (already created).

**Build order:** Task 1 (#58) → Tasks 2–4 (#57).

---

## Task 1: "What's new" release notes in the update banner (#58)

**Files:**
- Modify: `apps/desktop/src/main/updater.ts`
- Modify: `apps/desktop/src/preload/api.d.ts`
- Modify: `apps/desktop/src/renderer/src/components/UpdateBanner.tsx`
- Modify: `apps/desktop/src/renderer/src/styles.css`

- [ ] **Step 1: Add `notes` to `UpdateState` (both copies)**

In `apps/desktop/src/main/updater.ts`, extend the interface:
```ts
export interface UpdateState {
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error' | 'disabled';
  version?: string;
  percent?: number;
  notes?: string;
}
```
In `apps/desktop/src/preload/api.d.ts`, add the same `notes?: string;` field to the `UpdateState` interface there.

- [ ] **Step 2: Normalize `releaseNotes` and set it on the ready state**

In `updater.ts`, add a helper above `initUpdater` (electron-updater's `releaseNotes` is `string | { version: string; note: string | null }[] | null`):
```ts
function notesToText(
  rn: string | Array<{ version: string; note: string | null }> | null | undefined,
): string | undefined {
  if (!rn) return undefined;
  if (typeof rn === 'string') return rn.trim() || undefined;
  const text = rn.map((r) => r.note ?? '').filter(Boolean).join('\n\n').trim();
  return text || undefined;
}
```
Update the `update-downloaded` handler:
```ts
  autoUpdater.on('update-downloaded', (info) =>
    set({ status: 'ready', version: info.version, notes: notesToText(info.releaseNotes) }),
  );
```

- [ ] **Step 3: Render a "What's new" expander in the banner**

Replace the body of `apps/desktop/src/renderer/src/components/UpdateBanner.tsx` with (adds a notes disclosure; unchanged behavior when `notes` is absent):
```tsx
import { useEffect, useState } from 'react';
import type { UpdateState } from '../../../preload/api';

/** Non-blocking bar shown when a downloaded update is ready to install. */
export function UpdateBanner() {
  const [state, setState] = useState<UpdateState>({ status: 'idle' });
  const [dismissed, setDismissed] = useState(false);
  const [showNotes, setShowNotes] = useState(false);

  useEffect(() => {
    void window.docgit.updateState().then(setState);
    return window.docgit.onUpdate((s) => {
      setState(s);
      setDismissed(false); // a newly-ready update re-shows the bar
      setShowNotes(false);
    });
  }, []);

  if (state.status !== 'ready' || dismissed) return null;

  return (
    <div className="update-banner" role="status">
      <div className="update-banner-main">
        <span>
          DocGit {state.version ? `v${state.version}` : ''} is ready to install.
          {state.notes && (
            <button type="button" className="update-banner-whatsnew" onClick={() => setShowNotes((v) => !v)}>
              {showNotes ? 'Hide' : "What's new"} {showNotes ? '▾' : '▸'}
            </button>
          )}
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
      {state.notes && showNotes && <div className="update-banner-notes">{state.notes}</div>}
    </div>
  );
}
```

- [ ] **Step 4: Styles**

In `apps/desktop/src/renderer/src/styles.css`, find the existing `.update-banner` rule and adjust it to stack, then add the new rules. Replace the existing `.update-banner { ... }` declaration with:
```css
.update-banner {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 16px;
  font-size: 12.5px;
  color: var(--dg-accent-ink);
  background: var(--dg-accent);
  -webkit-app-region: no-drag;
}
.update-banner-main { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.update-banner-whatsnew {
  margin-left: 8px;
  background: none;
  border: none;
  color: var(--dg-accent-ink);
  text-decoration: underline;
  cursor: pointer;
  font-size: 12px;
  opacity: 0.85;
}
.update-banner-notes {
  white-space: pre-wrap;
  max-height: 160px;
  overflow-y: auto;
  font-size: 11.5px;
  line-height: 1.4;
  background: color-mix(in srgb, var(--dg-accent) 80%, black);
  border-radius: 8px;
  padding: 8px 10px;
}
```
(Keep the existing `.update-banner-actions` / `.update-banner .btn-mini` rules.)

- [ ] **Step 5: Verify**

Run: `pnpm typecheck && pnpm --filter @docgit/desktop smoke`
Expected: `SMOKE OK` + `BOOT CHECK OK` (banner renders null at idle; notes path is type-checked).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/updater.ts apps/desktop/src/preload/api.d.ts apps/desktop/src/renderer
git commit -m "desktop: show release notes ('What's new') in the update banner"
```

---

## Task 2: `backup.ts` — copy / validate / restore the database (#57)

**Files:**
- Create: `apps/desktop/src/main/backup.ts`
- Modify: `apps/desktop/src/main/index.ts` (smoke assertions in `runSmokeTest`)

- [ ] **Step 1: Write `backup.ts`**

Create `apps/desktop/src/main/backup.ts`:
```ts
import { copyFileSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

/** Copy the database file to `destPath` (a complete backup — objects hold all content). */
export function backupDatabase(dbPath: string, destPath: string): string {
  copyFileSync(dbPath, destPath);
  return destPath;
}

/** Throw a friendly error if `srcPath` is not a readable DocGit database. */
export function assertDocgitDb(srcPath: string): void {
  if (!existsSync(srcPath)) throw new Error('That file no longer exists.');
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(srcPath, { readOnly: true });
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='documents'").get();
    if (!row) throw new Error("That file isn't a DocGit backup.");
  } catch {
    throw new Error("That file isn't a DocGit backup.");
  } finally {
    db?.close();
  }
}

/**
 * Replace `dbPath` with `srcPath`, after saving the current database to
 * `${dbPath}.bak`. The caller MUST close the live store before calling this.
 */
export function restoreDatabase(dbPath: string, srcPath: string): void {
  assertDocgitDb(srcPath);
  if (existsSync(dbPath)) copyFileSync(dbPath, `${dbPath}.bak`);
  copyFileSync(srcPath, dbPath);
}
```
(If `new DatabaseSync(srcPath, { readOnly: true })` fails typecheck, the option name in this Node version may differ — check the existing `SnapshotStore` constructor in `packages/core/src/store/store.ts` for the accepted options shape and match it; the readOnly open is only a safety nicety, a plain `new DatabaseSync(srcPath)` also works for the table check.)

- [ ] **Step 2: Add backup/restore assertions to the smoke test**

In `apps/desktop/src/main/index.ts`, inside `runSmokeTest`'s `try` block, just before the `console.log('SMOKE OK'...)` line, add (the smoke already has a populated store at `join(dir, 'docgit.db')`, plus `mkdtempSync`/`writeFileSync`/`join`/`tmpdir` in scope):
```ts
    // Backup / restore round-trip + validation.
    const { backupDatabase, restoreDatabase, assertDocgitDb } = await import('./backup.js');
    const { SnapshotStore } = await import('@docgit/core');
    const backupPath = join(dir, 'backup.docgitdb');
    backupDatabase(join(dir, 'docgit.db'), backupPath);
    assertDocgitDb(backupPath); // valid DocGit db → no throw
    const restoreDir = mkdtempSync(join(tmpdir(), 'docgit-restore-'));
    const restoredDb = join(restoreDir, 'docgit.db');
    restoreDatabase(restoredDb, backupPath);
    const restored = new SnapshotStore(restoredDb);
    if (restored.listDocuments().length === 0) throw new Error('restore lost documents');
    restored.close();
    writeFileSync(join(dir, 'notadb.txt'), 'hello');
    let rejected = false;
    try { assertDocgitDb(join(dir, 'notadb.txt')); } catch { rejected = true; }
    if (!rejected) throw new Error('assertDocgitDb should reject a non-DocGit file');
```

- [ ] **Step 3: Verify**

Run: `pnpm typecheck && pnpm --filter @docgit/desktop smoke`
Expected: `SMOKE OK` (backup/restore assertions pass) + `BOOT CHECK OK`.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/main/backup.ts apps/desktop/src/main/index.ts
git commit -m "desktop: backup/restore/validate the history database (verified in smoke)"
```

---

## Task 3: IPC + preload for backup/restore/reveal (#57)

**Files:**
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/src/preload/index.ts` + `apps/desktop/src/preload/api.d.ts`

- [ ] **Step 1: Imports + IPC handlers in `index.ts`**

Add the import near the other local imports:
```ts
import { backupDatabase, restoreDatabase, assertDocgitDb } from './backup.js';
```
Ensure `copyFileSync` is imported from `node:fs` at the top (the file already imports `copyFileSync, existsSync, mkdirSync` — confirm). Then add to `registerIpc`:
```ts
  ipcMain.handle('backup:run', async () => {
    const res = await dialog.showSaveDialog(win!, {
      title: 'Back up DocGit',
      defaultPath: `DocGit-backup-${new Date().toISOString().slice(0, 10)}.docgitdb`,
    });
    if (res.canceled || !res.filePath) return null;
    return backupDatabase(join(app.getPath('userData'), 'docgit.db'), res.filePath);
  });

  ipcMain.handle('backup:restore', async () => {
    const res = await dialog.showOpenDialog(win!, {
      title: 'Restore DocGit from a backup',
      filters: [{ name: 'DocGit backup', extensions: ['docgitdb', 'db'] }],
      properties: ['openFile'],
    });
    if (res.canceled || !res.filePaths[0]) return;
    const src = res.filePaths[0];
    assertDocgitDb(src); // validate BEFORE touching anything; throws → renderer shows error, nothing changed
    const dbPath = join(app.getPath('userData'), 'docgit.db');
    service?.dispose(); // close the live DB before swapping the file
    restoreDatabase(dbPath, src); // saves docgit.db.bak, then overwrites
    app.relaunch();
    app.exit(0);
  });

  ipcMain.handle('data:reveal', () => {
    shell.showItemInFolder(join(app.getPath('userData'), 'docgit.db'));
  });
```
(`new Date().toISOString()` for the default filename is fine in the app — this is not the smoke path; it runs on a user click.)

- [ ] **Step 2: Preload bridge + types**

In `apps/desktop/src/preload/index.ts`, add to `api`:
```ts
  runBackup: () => ipcRenderer.invoke('backup:run'),
  restoreBackup: () => ipcRenderer.invoke('backup:restore'),
  revealDataFolder: () => ipcRenderer.invoke('data:reveal'),
```
In `apps/desktop/src/preload/api.d.ts`, add to `interface DocgitApi`:
```ts
  runBackup(): Promise<string | null>;
  restoreBackup(): Promise<void>;
  revealDataFolder(): Promise<void>;
```

- [ ] **Step 3: Verify + commit**

Run: `pnpm typecheck && pnpm --filter @docgit/desktop smoke`
Expected: green (the new handlers aren't exercised in smoke/boot, but registration must compile and not break boot).
```bash
git add apps/desktop/src/main/index.ts apps/desktop/src/preload
git commit -m "desktop: IPC for backup/restore/reveal-data-folder"
```

---

## Task 4: Settings popover "Data" section + restore confirm + docs (#57)

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/SettingsMenu.tsx`
- Modify: `apps/desktop/src/renderer/src/styles.css`
- Modify: `docs/TECH-NOTES.md`

- [ ] **Step 1: Add a Data section to `SettingsMenu`**

Read `SettingsMenu.tsx` first. It already renders a popover with the auto-update toggle + status. Add a small confirm-state for restore and a Data block. Inside the component add:
```tsx
const [confirmRestore, setConfirmRestore] = useState(false);
const [dataMsg, setDataMsg] = useState('');
```
Add this block inside the `.settings-popover`, after the existing update controls (before the version line):
```tsx
<div className="settings-divider" />
<div className="settings-section-label">Your data</div>
<div className="settings-data-actions">
  <button
    type="button"
    className="btn btn-mini"
    onClick={async () => {
      const path = await window.docgit.runBackup();
      setDataMsg(path ? 'Backup saved.' : '');
    }}
  >
    Back up now…
  </button>
  <button type="button" className="btn btn-mini" onClick={() => window.docgit.revealDataFolder()}>
    Reveal data folder
  </button>
</div>
{!confirmRestore ? (
  <button type="button" className="settings-restore-link" onClick={() => setConfirmRestore(true)}>
    Restore from a backup…
  </button>
) : (
  <div className="settings-restore-confirm">
    <p>This replaces your current history with the backup. Your current data is saved to <code>docgit.db.bak</code> first, and DocGit will relaunch.</p>
    <div className="settings-data-actions">
      <button type="button" className="btn btn-mini" onClick={() => setConfirmRestore(false)}>Cancel</button>
      <button
        type="button"
        className="btn btn-mini btn-danger"
        onClick={async () => {
          try {
            await window.docgit.restoreBackup(); // app relaunches on success; an invalid file rejects here
            setConfirmRestore(false);
          } catch (err) {
            setDataMsg(err instanceof Error ? err.message.replace(/^.*Error[^:]*:\s*/, '') : String(err));
          }
        }}
      >
        Choose backup & restore
      </button>
    </div>
  </div>
)}
{dataMsg && <p className="settings-hint">{dataMsg}</p>}
```
(`.btn-danger` exists in the stylesheet from the delete feature.)

- [ ] **Step 2: Styles**

Append to `styles.css`:
```css
.settings-divider { height: 1px; background: var(--dg-hairline); margin: 12px 0 10px; }
.settings-section-label { font-size: 11px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: var(--dg-ink-soft); margin-bottom: 8px; }
.settings-data-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.settings-restore-link { display: inline-block; margin-top: 8px; background: none; border: none; padding: 0; color: var(--dg-ink-soft); text-decoration: underline; cursor: pointer; font-size: 12px; }
.settings-restore-confirm { margin-top: 8px; font-size: 12px; }
.settings-restore-confirm p { margin: 0 0 8px; color: var(--dg-ink-soft); }
.settings-restore-confirm code { font-size: 11px; }
```

- [ ] **Step 3: TECH-NOTES caveat**

Append to `docs/TECH-NOTES.md` (under the existing sections):
```markdown
## 9. Backup / restore

- **One file is the whole backup.** `docgit.db` holds every version's full file
  bytes (content-addressed `objects` table), so "Back up now…" copies that single
  file and captures all documents, versions, and branches — not just metadata.
- **Restore = replace + relaunch.** Restoring validates the chosen file is a
  DocGit database, saves the current one to `docgit.db.bak`, overwrites
  `docgit.db`, and relaunches. There is no history merge (out of scope) — restore
  swaps in the backup wholesale.
- **Paths travel, files may not.** A restored database remembers where the tracked
  documents lived on the original machine. History and version *content* are fully
  intact, but if the actual files now live elsewhere (new Mac, moved folders),
  live-watching may need them re-added at their new locations.
```

- [ ] **Step 4: Verify**

Run: `pnpm typecheck && pnpm --filter @docgit/desktop smoke`
Expected: green (boot check renders the new Settings section without console errors).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer docs/TECH-NOTES.md
git commit -m "desktop: Settings 'Your data' — backup, restore (with confirm), reveal folder"
```

---

## Final verification

- [ ] `pnpm build && pnpm typecheck && pnpm test && pnpm --filter @docgit/desktop smoke` — all green.
- [ ] Manual (running app, deferred to user): ⚙ → Back up now (file written); Reveal data folder (Finder opens); Restore (confirm → pick the backup → app relaunches with data intact); update banner "What's new" expander shows notes on a real release.

---

## Self-Review

**Spec coverage:**
- #58 release notes through UpdateState → banner expander, text-rendered, graceful when absent → Task 1 ✓
- #57 `docgit.db`-is-the-backup, `backup.ts` copy/validate/restore, smoke verification → Task 2 ✓
- #57 IPC backup:run / backup:restore (validate→dispose→bak→overwrite→relaunch) / data:reveal + preload/types → Task 3 ✓
- #57 Settings "Your data" section, restore confirm copy, TECH-NOTES caveat → Task 4 ✓
- Restore = replace + safety `.bak` + relaunch (locked decision) → Task 3 ✓
- Out of scope (merge, cloud, rich HTML notes) → respected ✓

**Placeholder scan:** No TBD/TODO. The one conditional (DatabaseSync readOnly option name) gives a concrete fallback (`new DatabaseSync(srcPath)`), not a vague instruction.

**Type consistency:** `UpdateState.notes?: string` added in both copies (updater.ts + api.d.ts). `backupDatabase`/`restoreDatabase`/`assertDocgitDb` signatures match across backup.ts, the smoke test, and the IPC handlers. Preload method names (`runBackup`/`restoreBackup`/`revealDataFolder`) match between `preload/index.ts`, `api.d.ts`, and the SettingsMenu calls.
