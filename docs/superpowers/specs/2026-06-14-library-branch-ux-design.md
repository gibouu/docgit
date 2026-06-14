# Library & Branch UX — Design

Date: 2026-06-14
Status: Approved (pending spec review)

## Guiding principle

DocGit is the source of truth and pushes changes **down to disk**. What you see in the
app matches your real files: renaming a document renames the real file, deleting can
remove the real file. The real file is **never** touched without an explicit choice, and
risky operations fail loudly rather than half-applying.

## Scope

Four buildable features, each an independent vertical slice
(store method → service → IPC → preload → renderer), shippable as separate PRs:

1. Drag-and-drop from Finder to add files
2. Rename a document (DocGit name **and** the real file on disk, kept in sync)
3. Delete a document (remove from DocGit, optionally move the real file to Trash)
4. Branch reason (suggested chips + free text)

Plus one UX cleanup that the new controls depend on:

5. Simplify the Details dock panel

**Out of scope (deferred):** folders (filed as a GitHub issue — mirror-disk folders with
real `mkdir`/move semantics), moving files between locations, permanent (non-Trash)
deletion, bulk select.

## Repo conventions

- `gibouu/docgit`, pnpm monorepo: `packages/core`, `packages/ui`, `apps/desktop`.
- **No signatures on this repo** — commits, PRs, and issues are unsigned (no `— gib`, no
  Claude co-sign).
- IPC pattern to follow (modeled by `renameBranch`):
  store method (`packages/core/src/store/store.ts`) → service wrapper
  (`apps/desktop/src/main/service.ts`, calls `onChanged`) → `ipcMain.handle`
  (`apps/desktop/src/main/index.ts`) → preload bridge + type
  (`apps/desktop/src/preload/index.ts`, `api.d.ts`) → renderer call.
- Data model: `documents(id, path, name, current_branch_id, created_at, shared, my_name)`
  where `id = SHA256(path)[:16]` and is the PK referenced by branches/commits;
  `branches(id, document_id, name, color, head_commit_id, archived, position,
  created_at, forked_from_commit_id, synced_upstream_commit_id)`.

---

## Feature 1 — Drag-and-drop to add files

**Behaviour:** dropping `.docx/.xlsx/.pptx` files from Finder anywhere on the library
window starts tracking them. The existing "Add document" picker button stays.

**Renderer (`views/Library.tsx`):**
- `dragover` over the library root shows a soft "Drop to add" overlay; `dragleave`/`drop`
  clears it.
- On `drop`, resolve each dropped file's filesystem path via Electron `webUtils`
  (`webUtils.getPathForFile(file)`), exposed through preload — the modern, `file.path`-safe
  approach.
- Filter to supported extensions; unsupported files are ignored with a brief toast
  ("Only Word, Excel and PowerPoint files can be added").

**New IPC `docs:addPaths(paths: string[])`:**
- Main handler loops `svc.addDocument(path)` (reuses the existing add flow at
  `service.ts:147`), which is idempotent for already-tracked paths.
- Returns the list of added/updated document ids so the renderer can refresh + highlight.

**No on-disk movement** — pure "add". (Drop-into-folder / drop-to-move are part of the
deferred folders feature.)

---

## Feature 2 — Rename (DocGit name + real file in sync)

**Behaviour:** editing a document's name renames the **real file on disk** and updates the
DocGit label, so the two never drift and the file stays easy to find. The base name is
editable; the **extension is preserved**.

**Critical: keep the document `id` stable.** `id = SHA256(path)` but it is the PK that
branches and commits reference. Rename must NOT recompute/change the id. It updates the
`path` and `name` columns on the same id and re-points the file watcher.

**New store method `renameDocument(documentId, newBaseName)`** (in `store.ts`):
- Compute the new absolute path (same directory, new base name, original extension).
- Update `path` and `name` on the existing id. (Filesystem rename happens in the service
  layer, which owns fs + watcher; the store stays pure-data.)

**Service `renameDocument` (`service.ts`)** — orchestrates the risky parts, ordered so a
failure never leaves DocGit and disk out of sync:
1. Pre-checks: target name non-empty; no collision with an existing file in the same
   directory; document not mid-rename.
2. `fs.rename(oldPath, newPath)` **first** (the operation most likely to fail).
3. In a DB transaction, call `store.renameDocument`. If the DB step throws, `fs.rename`
   back to the original path before surfacing the error.
4. Re-point the chokidar watcher to `newPath`; `onChanged(documentId)`.

**Flag harder — error handling:** map the real failure modes to clear, inline messages
shown **inside the rename dialog** (red alert bar), blocking the rename:
- `EBUSY`/`EPERM` (open in Word, locked) → "Word has this file open — close it and try
  again."
- Name collision → "A file called *X* already exists in this folder."
- iCloud/cloud placeholder or other `fs` error → "Couldn't rename the file on disk
  (<reason>). Nothing was changed."

Never a silent toast; the rename is all-or-nothing.

**UI:** a `⋯` menu on each library row (`Library.tsx`) → **Rename**, reusing the existing
`NameDialog` component (pre-filled with the base name).

---

## Feature 3 — Delete (DocGit and/or drive, user's choice)

**Behaviour:** `⋯` menu on a library row → **Delete** opens a modal naming the document,
with one checkbox: **"Also move the original file to the Trash"** (default **off**).
- Always: remove from DocGit — delete the document row (cascade branches/commits/blobs via
  FK) and stop the watcher.
- If checked: also `shell.trashItem(path)` — **Trash, not permanent delete**, so it stays
  recoverable from Finder.

**New store method `deleteDocument(documentId)`** — `DELETE FROM documents WHERE id = ?`
with FK cascade; assert the row exists.

**Service `deleteDocument(documentId, { trashFile })`** — ordered so a failed Trash never
leaves DocGit in a half-deleted state:
1. If `trashFile`: `await shell.trashItem(path)` **first**; if it fails (e.g. file locked),
   surface the error and abort with the document still fully tracked (watcher intact).
2. Stop and dispose the watcher for the document.
3. `store.deleteDocument(documentId)`; `onChanged` (or library refresh).

**Flag harder — destructive state:** when the Trash box is checked, the modal flips to a
clearly destructive style and the confirm button reads **"Remove & move file to Trash"**
(vs **"Remove from DocGit"** when unchecked). If the document's `shared` flag is set, show
a caveat line: "This file is in a shared cloud folder — trashing it may remove it for
others too."

---

## Feature 4 — Branch reason (suggested chips + free text)

**Schema:** add `reason TEXT` to `branches` via an `ALTER TABLE` migration following the
existing pattern (the `forked_from_commit_id` / `synced_upstream_commit_id` additions).
`createBranch(documentId, name, fromCommitId, color?, reason?)` gains the optional
`reason`. New store method `setBranchReason(branchId, reason)` for later edits.

**Create dialog (`BranchDialog` in `DocumentView.tsx`):** quick-pick chips —
**Translation · Client revision · Experiment · Draft · Backup** — tapping a chip fills the
free-text box, which stays editable. The reason is optional. `Main` never carries a reason.
(The "Translation" preset is a deliberate first step toward the deferred translation-branch
language tagging in the backlog.)

**Display:** the reason renders as a subtle subtitle beside/under the branch name in the
dock list and as a label/tooltip in the branch tree (`BranchGraph` /
`HorizontalBranchGraph` in `packages/ui`). Editable later from the `Branch ⋯` menu (see
Feature 5).

---

## Feature 5 — Simplify the Details dock panel

The current Details panel stacks three rename-ish controls (version Rename, Rename branch)
and a raw `#6366f1` colour dropdown, which reads as clutter. Target layout:

```
┌ Details ──────────────────────────────────┐
│ Jun 14, 2026 · 9:18 PM   [AUTO-SAVED]   ⋯  │  ⋯ → "Rename this version"
│                                            │
│ ● Main                                     │  colour dot + name (reason subtitle if any)
│ Edited by Gibril B                         │
│                                            │
│ [ Open in Word ]   [ Branch from here ]    │  the two real actions stand out
│ Mark as sent…                              │  demoted to a quiet text link
│                                            │
│ Branch ⋯                                   │  one menu: Rename · Reason · Colour · Archive
└────────────────────────────────────────────┘
```

Changes:
- **Version-rename** moves from a visible button into the header `⋯`.
- The whole `BRANCH "MAIN"` admin row (Rename branch + colour) **collapses into a single
  `Branch ⋯` menu**: Rename · Reason · Colour · Archive.
- **Replace the hex dropdown with colour swatches** inside `Branch ⋯` — no hex code shown.
- **`Mark as sent…` demoted** to a text link so *Open in Word* and *Branch from here* are
  the clear primary actions.
- **Branch reason** appears as a subtitle under the branch name and is edited from
  `Branch ⋯` (no new top-level button).

Document-level **Rename** and **Delete** (Features 2–3) live on the **library row `⋯`
menu**, not in this panel, keeping Details focused on the current version/branch.

---

## Testing

- **core:** unit tests for `renameDocument` (id stable, path+name updated, extension
  preserved) and `deleteDocument` (cascade); `createBranch`/`setBranchReason` persist and
  return `reason`; migration adds the column idempotently.
- **service:** rename rollback on DB failure (file renamed back); delete with/without
  `trashFile`; addPaths idempotency + extension filtering. Mock `fs`/`shell`.
- **desktop smoke:** extend the headless `DOCGIT_SMOKE` flow to add via path, rename a
  doc, create a branch with a reason, and delete a doc (DocGit-only) without errors.

## Build order

1. Feature 5 (panel simplification) + Feature 4 (branch reason) — UI groundwork and the
   `Branch ⋯` menu the reason edit lives in.
2. Feature 1 (drag-and-drop add) — low risk, self-contained.
3. Feature 2 (rename on disk) — highest risk; lands with full error-flagging.
4. Feature 3 (delete) — depends on the library-row `⋯` menu introduced with rename.
