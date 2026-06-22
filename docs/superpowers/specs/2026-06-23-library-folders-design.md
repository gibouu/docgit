# Library folders — design (#52)

Date: 2026-06-23
Status: Scope model decided (single workspace root). Foundational slice building now; mutation slices follow.
Issue: #52 (deferred from `2026-06-14-library-branch-ux-design.md`)

## Decision (locked)

**Folder-scope model: a single workspace root.** DocGit has one root folder; the
library shows the real folder tree under it. Documents tracked from outside the
root appear under an **"Other locations"** group (flat). This is the cleanest
mental model and bounds the data model — folders are *derived from document
paths relative to the root*, not a separate entity.

## Data model

- New setting `workspaceRoot: string | null` (in `settings.json`). Null = no root
  set → the library is the flat list it is today (back-compat).
- A folder is **not** stored; it is the path-prefix of a tracked document
  relative to the root. The folder tree is **computed** from the tracked docs'
  paths → no schema change, no folder rows to keep in sync.
- A doc whose resolved path is not under the root → "Other locations".

## Staged slices

1. **Foundational (this PR) — read-only folder view.**
   - `workspaceRoot` setting + get/set IPC (set via a directory picker).
   - Pure `buildFolderTree(paths, root)` in `@docgit/core` (subpath-exported so
     the renderer doesn't pull `node:sqlite`), unit-tested: groups paths into a
     nested folder tree relative to root; out-of-root paths bucket to a sentinel
     "other" group; deterministic ordering.
   - Library renders a collapsible folder tree when a root is set (docs grouped
     by folder), plus an "Other locations" group; flat list when no root.
   - Acceptance covered: *"Library shows folders reflecting real disk structure"*
     and *"out-of-root files handled gracefully."*

2. **Create folder (follow-up issue) — `mkdir`.** A "New folder" affordance that
   performs a real `mkdir` under the root. Because folders are derived from doc
   paths, an *empty* folder needs either a tracked placeholder or a small
   "known empty folders" list in settings — decide at build time.

3. **Move doc into folder (follow-up issue) — `fs.rename` + drag-drop.** Reuses
   the shipped rename-on-disk infrastructure (`renameDocumentPath` + fs.rename +
   watcher re-point, stable doc id): moving a doc into a folder physically moves
   the file and keeps its history. Drag a tracked doc between folders, or drop a
   Finder file onto a folder to track-and-move. The riskiest part (real file
   moves) — gets its own tested PR.

## fs-mutation safety (slices 2–3)

- Real disk ops only ever go through the same guarded path as document rename:
  validate the destination stays under the root, reject path separators / `..`
  (cf. #82), atomic where possible, and re-point the watcher after the move.
- History is preserved because the document id is derived from the *original*
  path but is the stable PK; only `path` changes (as in `renameDocumentPath`).
