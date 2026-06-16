# Backup/Export + "What's New" — Design

Date: 2026-06-16
Status: Approved (pending spec review)
Issues: #57 (backup/export + reveal folder), #58 ("what's new" release notes)

Two small, related data-safety/update-experience features, built together because
both touch the Settings popover / updater wiring added in the auto-update work.

---

## Feature 58 — "What's new" in the update banner

**Goal:** When an update is downloaded, show that release's notes, not just
"vX.Y.Z is ready."

**Why it's clean:** `electron-updater`'s `update-downloaded` event already carries
`info.releaseNotes` (string or `{version, note}[]`, sourced from the GitHub Release).
Nothing new to fetch.

**Components:**
- `apps/desktop/src/main/updater.ts` — `UpdateState` gains an optional
  `notes?: string`. The `update-downloaded` handler normalizes
  `info.releaseNotes` to a plain string (it can be a string or an array) and sets
  it on the `ready` state.
- `api.d.ts` `UpdateState` — add `notes?: string`.
- `apps/desktop/src/renderer/src/components/UpdateBanner.tsx` — when `status ===
  'ready'` and `notes` is present, render a compact **"What's new ▸"** disclosure
  that expands to show the notes (rendered as plain text / minimal formatting,
  not full HTML, to avoid injecting release-controlled markup). No notes → banner
  is exactly as today.

**Data flow:** `update-downloaded(info)` → `set({status:'ready', version,
notes})` → pushed over `docgit:update` → banner shows version + optional
expander.

**Error handling:** `releaseNotes` absent/empty → `notes` undefined → expander
not rendered. Never blocks.

**Security note:** release notes are author-controlled text from GitHub; render
as **text** (or a tiny safe markdown subset), never as raw `dangerouslySetInnerHTML`.

**Testing:** typecheck + smoke (banner renders null at idle, no notes path
exercised in boot). Manual confirmation deferred to a real release (same
limitation as auto-update itself).

---

## Feature 57 — Backup / export + reveal data folder

**Key fact that shapes this:** `docgit.db` (in `app.getPath('userData')` =
`~/Library/Application Support/DocGit/`) is a *complete* backup — the `objects`
table stores the full file bytes of every version, content-addressed. So copying
that one file preserves all documents, versions, branches, and content. No need
to also bundle the live document files.

**Scope decision (locked):** Restore = **replace** the current database (after
auto-saving a safety copy of the existing one). Merging two histories is hard and
rarely needed — out of scope for v1.

### Components

**`apps/desktop/src/main/backup.ts`** (new, electron-free core logic, dir-injected
where possible):
- `backupDatabase(dbPath, destPath)` — `copyFileSync(dbPath, destPath)`. DocGit
  runs the database in **WAL mode** (`PRAGMA journal_mode = WAL`), so
  committed-but-not-yet-checkpointed writes live in the `docgit.db-wal` sidecar,
  not in the main `.db` file. For a live (store-still-open) backup the caller must
  therefore first run `PRAGMA wal_checkpoint(TRUNCATE)` (via `service.checkpoint()`)
  to flush the WAL into the main file; after that, copying the single `docgit.db`
  is a complete, consistent backup. Returns the dest path.
- `restoreDatabase(dbPath, srcPath)` — validate `srcPath` is a readable SQLite
  DocGit database (open it, check `PRAGMA user_version` / presence of the
  `documents` table) → copy current `dbPath` to `${dbPath}.bak` (safety) → copy
  `srcPath` over `dbPath`. Throws a friendly error if the source isn't a valid
  DocGit DB.

**`apps/desktop/src/main/index.ts` (+ service):**
- The `DocumentService` exposes `close()`/path access; backup/restore must
  coordinate with the open store. Plan: `backupDatabase` can run against the live
  file (SQLite WAL/rollback-journal copy is consistent for a quiesced DB); for
  restore, the app must **dispose the service, swap the file, and require a
  relaunch** (simplest correct path — see below).
- IPC handlers (registered in `registerIpc`):
  - `backup:run` → opens a save dialog (`dialog.showSaveDialog`, default name
    `DocGit-backup-YYYY-MM-DD.docgitdb`), then `backupDatabase`. Returns the
    written path or null if cancelled.
  - `backup:restore` → opens an open dialog (`dialog.showOpenDialog`, filter
    `.docgitdb`/`.db`), validates + `restoreDatabase`, then prompts the user that
    DocGit must relaunch to load the restored data (`app.relaunch(); app.quit()`).
  - `data:reveal` → `shell.showItemInFolder(join(userData,'docgit.db'))` (opens
    the data folder in Finder with the DB selected).

**`apps/desktop/src/preload/index.ts` + `api.d.ts`:**
- `runBackup(): Promise<string | null>`, `restoreBackup(): Promise<void>`,
  `revealDataFolder(): Promise<void>`.

**`apps/desktop/src/renderer/src/components/SettingsMenu.tsx`:**
- Add a **Data** section to the popover: **Back up now…**, **Restore from
  backup…**, **Reveal data folder**. Restore shows a confirm first ("This
  replaces your current history with the backup. Your current data is saved to
  `docgit.db.bak` first. DocGit will relaunch.").

### Restore = replace + safety + relaunch (the correct, simple path)

Hot-swapping the SQLite file under a live connection is unsafe. So restore:
1. Validate the chosen file is a DocGit DB.
2. Dispose the service (close the DB connection).
3. Copy current `docgit.db` → `docgit.db.bak`.
4. Copy the chosen backup over `docgit.db`.
5. `app.relaunch(); app.exit(0)` — the app reopens against the restored DB.

If any step before (4) fails, nothing is changed and a friendly error is shown.

### Caveat to document

A restored DB remembers the file *paths* tracked on the old machine. If the
documents now live elsewhere (new Mac, moved folders), history/content is fully
intact, but live-watching may need the files re-added at their new location.
Note this in TECH-NOTES and in the restore confirmation copy.

### Testing

- **Smoke (`runSmokeTest`)**: exercise `backupDatabase` + `restoreDatabase`
  against temp files — back up a populated DB, corrupt/replace, restore, and
  assert the documents/commits come back. Also assert `restoreDatabase` rejects a
  non-DocGit file. (This is the real verification path, since these are pure fs/
  sqlite functions runnable in the headless Electron smoke.)
- typecheck; boot check renders the new Settings section without error.

---

## Out of scope (both features)

- Cloud/automatic backup (export is a local, user-controlled file — privacy
  intact).
- Merging two histories on restore.
- Rendering rich HTML release notes (text/safe-subset only).
- Scheduled/automatic local backups (could be a follow-up).

## Build order

1. #58 ("what's new") — thin, isolated.
2. #57 backup/export — `backup.ts` (+ smoke) → IPC/preload → Settings UI → docs.
