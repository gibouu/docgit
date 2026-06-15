# Library & Branch UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add drag-to-add, on-disk rename, choose-your-scope delete, and branch-reason labels to DocGit, and declutter the Details dock panel.

**Architecture:** Five independent vertical slices, each its own PR. Every data-mutating slice follows the established chain: store method (`packages/core/src/store/store.ts`) → service wrapper that calls `onChanged` (`apps/desktop/src/main/service.ts`) → `ipcMain.handle` (`apps/desktop/src/main/index.ts`) → preload bridge + `DocgitApi` type (`apps/desktop/src/preload/index.ts`, `api.d.ts`) → renderer. Core logic is unit-tested with vitest; the desktop app is verified by `pnpm --filter @docgit/desktop smoke` + typecheck + manual run (no renderer unit harness exists).

**Tech Stack:** pnpm monorepo, TypeScript, `node:sqlite` (`DatabaseSync`), Electron + electron-vite + React, vitest, chokidar.

**Spec:** `docs/superpowers/specs/2026-06-14-library-branch-ux-design.md`

**Repo rules:** No signatures/AI footers on commits, PRs, or issues. Update `docs/TECH-NOTES.md` when a slice ships a known limit. Root verification: `pnpm build && pnpm typecheck && pnpm test && pnpm --filter @docgit/desktop smoke`.

**PR order (each merges to `main` independently):**
- **PR A — Branch reason** (data + create dialog + display)
- **PR B — Drag-and-drop to add**
- **PR C — Rename document on disk**
- **PR D — Delete document** (DocGit and/or Trash) — depends on the library-row `⋯` menu introduced in PR C
- **PR E — Details panel simplification** (houses later reason editing; pure UI polish, done last)

Branch names: `feat/branch-reason`, `feat/drag-add`, `feat/doc-rename`, `feat/doc-delete`, `feat/details-panel-cleanup`.

---

## PR A — Branch reason

**Files:**
- Modify: `packages/core/src/store/store.ts` (schema migration, `BranchRow`, `RawBranch`, `rowToBranch`, `createBranch`, new `setBranchReason`)
- Modify: `packages/core/test/branching.test.ts` (new tests)
- Modify: `apps/desktop/src/main/service.ts` (`createBranch` passes reason; new `setBranchReason`)
- Modify: `apps/desktop/src/main/index.ts` (`branch:create` gains reason; new `branch:reason`)
- Modify: `apps/desktop/src/preload/index.ts` + `apps/desktop/src/preload/api.d.ts`
- Modify: `apps/desktop/src/renderer/src/views/DocumentView.tsx` (BranchDialog chips + reason field; reason display in dock list)
- Modify: `packages/ui/src/BranchGraph.tsx` + `packages/ui/src/HorizontalBranchGraph.tsx` (reason tooltip/label) — only if branches carry a reason

### Task A1: Schema migration — add `reason` column

- [ ] **Step 1: Write the failing test**

Add to `packages/core/test/branching.test.ts`:

```ts
it('persists an optional reason on a branch', () => {
  const base = snapshot(['v1'], 'base').commit;
  const doc = store.getDocument(base.documentId);
  const branch = store.createBranch(doc.id, 'FR translation', base.id, undefined, 'Translation');
  expect(branch.reason).toBe('Translation');
  // Reason is optional and defaults to null.
  const plain = store.createBranch(doc.id, 'Experiment', base.id);
  expect(plain.reason).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @docgit/core test -- branching`
Expected: FAIL — `createBranch` does not accept a 5th arg / `reason` undefined on `BranchRow`.

- [ ] **Step 3: Implement**

In `packages/core/src/store/store.ts`:

1. Add to the post-v2 ALTER block (after line 247, beside `my_name`):
```ts
    this.ensureColumn('branches', 'reason TEXT');
```

2. Extend `BranchRow` (after `syncedUpstreamCommitId`, ~line 50):
```ts
  /** Optional human reason this branch exists (e.g. "Translation"). */
  reason: string | null;
```

3. Extend `RawBranch` (after `synced_upstream_commit_id`, ~line 885):
```ts
  reason: string | null;
```

4. Extend `rowToBranch` (~line 958, after `syncedUpstreamCommitId`):
```ts
    reason: row.reason ?? null,
```

5. Change `createBranch` signature + INSERT (~line 616). New signature:
```ts
  createBranch(documentId: string, name: string, fromCommitId: string, color?: string, reason?: string): BranchRow {
```
Update the INSERT column list and values to include `reason`:
```ts
        .prepare(
          `INSERT INTO branches (id, document_id, name, color, head_commit_id, archived, position, created_at, forked_from_commit_id, synced_upstream_commit_id, reason)
           VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          documentId,
          name,
          color ?? BRANCH_COLORS[position % BRANCH_COLORS.length]!,
          fromCommitId,
          position,
          nowIso(),
          fromCommitId,
          fromCommitId,
          reason ?? null,
        );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @docgit/core test -- branching`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/store/store.ts packages/core/test/branching.test.ts
git commit -m "core: add optional reason field to branches"
```

### Task A2: `setBranchReason` store method

- [ ] **Step 1: Write the failing test**

Add to `packages/core/test/branching.test.ts`:

```ts
it('updates a branch reason after creation', () => {
  const base = snapshot(['v1'], 'base').commit;
  const doc = store.getDocument(base.documentId);
  const branch = store.createBranch(doc.id, 'Variant', base.id);
  const updated = store.setBranchReason(branch.id, 'Client revision');
  expect(updated.reason).toBe('Client revision');
  expect(store.setBranchReason(branch.id, '').reason).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @docgit/core test -- branching`
Expected: FAIL — `setBranchReason` is not a function.

- [ ] **Step 3: Implement**

In `store.ts`, after `setBranchColor` (~line 678):
```ts
  setBranchReason(branchId: string, reason: string): BranchRow {
    this.db.prepare('UPDATE branches SET reason = ? WHERE id = ?').run(reason.trim() || null, branchId);
    return this.getBranch(branchId);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @docgit/core test -- branching`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/store/store.ts packages/core/test/branching.test.ts
git commit -m "core: setBranchReason to edit a branch reason"
```

### Task A3: Service + IPC + preload wiring

- [ ] **Step 1: Service** — in `apps/desktop/src/main/service.ts`, change `createBranch` (~line 352) to accept and forward `reason`, and add `setBranchReason`:

```ts
  createBranch(documentId: string, name: string, fromCommitId: string, reason?: string): BranchRow {
    this.log(`ACTION createBranch "${name}" from ${fromCommitId.slice(0, 8)}${reason ? ` (${reason})` : ''}`);
    this.snapshotDiskBeforeOverwrite(documentId);
    const branch = this.store.createBranch(documentId, name, fromCommitId, undefined, reason);
    this.writeFileFromCommit(documentId, fromCommitId);
    this.onChanged(documentId);
    return branch;
  }

  setBranchReason(documentId: string, branchId: string, reason: string): BranchRow {
    const branch = this.store.setBranchReason(branchId, reason);
    this.onChanged(documentId);
    return branch;
  }
```

- [ ] **Step 2: IPC** — in `apps/desktop/src/main/index.ts`, update `branch:create` (line 110) and add `branch:reason` (after `branch:color`, line 121):

```ts
  ipcMain.handle('branch:create', (_e, documentId: string, name: string, fromCommitId: string, reason?: string) =>
    svc.createBranch(documentId, name, fromCommitId, reason),
  );
  ipcMain.handle('branch:reason', (_e, documentId: string, branchId: string, reason: string) =>
    svc.setBranchReason(documentId, branchId, reason),
  );
```

- [ ] **Step 3: Preload** — in `apps/desktop/src/preload/index.ts`, update `createBranch` (line 23) and add `setBranchReason`:

```ts
  createBranch: (documentId: string, name: string, fromCommitId: string, reason?: string) =>
    ipcRenderer.invoke('branch:create', documentId, name, fromCommitId, reason),
  setBranchReason: (documentId: string, branchId: string, reason: string) =>
    ipcRenderer.invoke('branch:reason', documentId, branchId, reason),
```

- [ ] **Step 4: Type** — in `apps/desktop/src/preload/api.d.ts`, update line 70 and add the new method:

```ts
  createBranch(documentId: string, name: string, fromCommitId: string, reason?: string): Promise<BranchRow>;
  setBranchReason(documentId: string, branchId: string, reason: string): Promise<BranchRow>;
```

- [ ] **Step 5: Verify + commit**

Run: `pnpm typecheck`
Expected: PASS.
```bash
git add apps/desktop/src/main/service.ts apps/desktop/src/main/index.ts apps/desktop/src/preload/index.ts apps/desktop/src/preload/api.d.ts
git commit -m "desktop: wire branch reason through service/IPC/preload"
```

### Task A4: BranchDialog — suggested chips + reason field

**File:** `apps/desktop/src/renderer/src/views/DocumentView.tsx` — locate `function BranchDialog` (~line 784).

- [ ] **Step 1: Read** the current `BranchDialog` to see its props (it currently takes a name and an `onCreate`/`onClose` that calls `window.docgit.createBranch`). Note the exact prop names before editing.

- [ ] **Step 2: Implement** — add a reason state, a chips row, and a free-text reason input, and pass `reason` to the create call. Inside `BranchDialog`:

```tsx
const REASON_PRESETS = ['Translation', 'Client revision', 'Experiment', 'Draft', 'Backup'];
// ...inside the component:
const [reason, setReason] = useState('');
```

In the dialog body, below the name input and above the actions:

```tsx
<div className="branch-reason-presets">
  {REASON_PRESETS.map((p) => (
    <button
      type="button"
      key={p}
      className={`chip${reason === p ? ' is-active' : ''}`}
      onClick={() => setReason(p)}
    >
      {p}
    </button>
  ))}
</div>
<input
  className="input"
  placeholder="Why this branch? (optional)"
  value={reason}
  onChange={(e) => setReason(e.target.value)}
/>
```

Update the create call to pass `reason.trim() || undefined` as the new 4th argument to whatever handler creates the branch (the parent's `createBranch(doc.id, name, fromCommitId, reason.trim() || undefined)`).

- [ ] **Step 3: Style** — in the renderer stylesheet (find where `.chip` / `.filter-chip` live, e.g. `apps/desktop/src/renderer/src/styles.css` or equivalent), add a small `.branch-reason-presets { display: flex; gap: 6px; flex-wrap: wrap; margin: 8px 0; }` and a `.chip` pill style consistent with `.filter-chip`. Reuse existing chip styling if present.

- [ ] **Step 4: Display reason in the dock list** — in the dock branch list (DocumentView ~line 244-274), render the reason as a subtitle when present:

```tsx
{branch.reason && <span className="branch-reason">{branch.reason}</span>}
```
Style `.branch-reason { font-size: 0.78em; opacity: 0.6; }`.

- [ ] **Step 5: Verify**

Run: `pnpm typecheck && pnpm --filter @docgit/desktop smoke`
Expected: PASS (smoke unaffected; typecheck clean).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer
git commit -m "desktop: branch reason chips + free text in create dialog, shown in dock"
```

### Task A5: Smoke coverage for reason

- [ ] **Step 1: Extend smoke** — in `apps/desktop/src/main/index.ts` `runSmokeTest` (~line 207, where `createBranch` is called), assert reason round-trips:

```ts
const branch = svc.createBranch(doc.id, 'Client B variant', graph.commits[0]!.id, 'Client revision');
if (branch.reason !== 'Client revision') throw new Error('branch reason not persisted');
```

- [ ] **Step 2: Run**

Run: `pnpm --filter @docgit/desktop smoke`
Expected: PASS (prints smoke OK, exits 0).

- [ ] **Step 3: Commit + open PR**

```bash
git add apps/desktop/src/main/index.ts
git commit -m "smoke: assert branch reason round-trips"
gh pr create --title "Branch reason: suggested chips + free text" --body "Closes part of the library/branch UX design. Adds an optional reason on branches (chips: Translation/Client revision/Experiment/Draft/Backup + free text), shown in the dock. Test Plan: pnpm test, pnpm typecheck, pnpm --filter @docgit/desktop smoke all green; created a branch with a reason and saw it in the dock."
```

---

## PR B — Drag-and-drop to add files

**Files:**
- Modify: `apps/desktop/src/preload/index.ts` + `api.d.ts` (expose `pathForFile`, add `addDocumentByPaths`)
- Modify: `apps/desktop/src/main/index.ts` (new `docs:addPaths` handler)
- Modify: `apps/desktop/src/main/service.ts` (new `addDocuments` returning ids)
- Modify: `apps/desktop/src/renderer/src/views/Library.tsx` (drop zone + overlay)

### Task B1: Service `addDocuments(paths)` (idempotent, multi)

- [ ] **Step 1: Implement** — in `service.ts`, after `addDocumentByPath` (~line 205):

```ts
  /** Track several files at once (drag-and-drop). Returns the resulting documents. */
  addDocuments(paths: string[]): DocumentRow[] {
    return paths.map((p) => this.addDocument(p));
  }
```
(`addDocument` is already idempotent via `store.addDocument`.)

- [ ] **Step 2: Verify**

Run: `pnpm typecheck`
Expected: PASS.

### Task B2: IPC + preload (including `webUtils` path resolution)

- [ ] **Step 1: IPC** — in `apps/desktop/src/main/index.ts`, after `docs:addPath` (line 79):

```ts
  ipcMain.handle('docs:addPaths', (_e, paths: string[]) => svc.addDocuments(paths));
```

- [ ] **Step 2: Preload** — in `apps/desktop/src/preload/index.ts`, import `webUtils` and expose a path resolver + the multi-add bridge. Change line 1 import and add to `api`:

```ts
import { contextBridge, ipcRenderer, webUtils } from 'electron';
// ...in api:
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  addDocumentByPaths: (paths: string[]) => ipcRenderer.invoke('docs:addPaths', paths),
```
(`webUtils.getPathForFile` is the supported way to resolve a dropped `File` to an absolute path; `file.path` was removed in modern Electron.)

- [ ] **Step 3: Type** — in `api.d.ts`, add to `DocgitApi`:

```ts
  pathForFile(file: File): string;
  addDocumentByPaths(paths: string[]): Promise<DocumentRow[]>;
```

- [ ] **Step 4: Verify + commit**

Run: `pnpm typecheck`
Expected: PASS.
```bash
git add apps/desktop/src/main apps/desktop/src/preload
git commit -m "desktop: docs:addPaths + webUtils path resolver for drag-and-drop"
```

### Task B3: Library drop zone

**File:** `apps/desktop/src/renderer/src/views/Library.tsx`

- [ ] **Step 1: Implement** — add drag state + handlers to the `Library` component and wire them on the `<main className="library">` element.

After the existing `addDocument` (line 68), add:

```tsx
const SUPPORTED = ['.docx', '.xlsx', '.pptx'];
const [dragOver, setDragOver] = useState(false);

const onDrop = async (e: React.DragEvent) => {
  e.preventDefault();
  setDragOver(false);
  const paths = Array.from(e.dataTransfer.files)
    .map((f) => window.docgit.pathForFile(f))
    .filter((p) => SUPPORTED.some((ext) => p.toLowerCase().endsWith(ext)));
  if (paths.length === 0) return; // silently ignore unsupported drops (toast optional)
  const added = await window.docgit.addDocumentByPaths(paths);
  await onRefresh();
  // Offer attribution for the first cloud-resident add, mirroring addDocument().
  for (const doc of added) {
    const cloud = await window.docgit.cloudStatus(doc.id);
    if (cloud.provider) { setSharePrompt({ docId: doc.id, provider: cloud.provider }); break; }
  }
};
```

Update the `<main>` opening tag (line 71):

```tsx
<main
  className={`library${dragOver ? ' is-dragover' : ''}`}
  onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
  onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false); }}
  onDrop={(e) => void onDrop(e)}
>
```

Add an overlay as the first child inside `<main>`:

```tsx
{dragOver && (
  <div className="library-dropzone">
    <div className="library-dropzone-inner">Drop Word, Excel or PowerPoint files to add</div>
  </div>
)}
```

- [ ] **Step 2: Style** — add to the renderer stylesheet:

```css
.library.is-dragover { outline: 2px dashed var(--accent, #6366f1); outline-offset: -8px; }
.library-dropzone { position: absolute; inset: 0; display: grid; place-items: center;
  background: rgba(255,255,255,0.7); pointer-events: none; z-index: 5; }
.library-dropzone-inner { font-weight: 600; padding: 16px 22px; border-radius: 12px;
  background: var(--paper, #fff); box-shadow: 0 6px 24px rgba(0,0,0,0.12); }
```
Ensure `.library` is `position: relative` for the absolute overlay.

- [ ] **Step 3: Verify**

Run: `pnpm typecheck && pnpm --filter @docgit/desktop smoke`
Expected: PASS.
Manual: `pnpm --filter @docgit/desktop dev`, drag a `.docx` from Finder onto the window → it appears in the library; drag a `.txt` → nothing added.

- [ ] **Step 4: Commit + PR**

```bash
git add apps/desktop/src/renderer
git commit -m "desktop: drag-and-drop Office files onto the library to add them"
gh pr create --title "Drag-and-drop to add documents" --body "Adds Finder drag-and-drop of .docx/.xlsx/.pptx onto the library window (augments the picker). Unsupported files ignored. Test Plan: typecheck + smoke green; manually dragged a Word file in and a .txt (ignored)."
```

---

## PR C — Rename document on disk

**Files:**
- Modify: `packages/core/src/store/store.ts` (new `renameDocumentPath`)
- Modify: `packages/core/test/store.test.ts` (new tests)
- Modify: `apps/desktop/src/main/service.ts` (new `renameDocument` with fs.rename + watcher re-point + rollback; `unwatch` helper)
- Modify: `apps/desktop/src/main/index.ts` (new `docs:rename`)
- Modify: `apps/desktop/src/preload/index.ts` + `api.d.ts`
- Modify: `apps/desktop/src/renderer/src/views/Library.tsx` (row `⋯` menu + rename dialog with inline error)

### Task C1: Store `renameDocumentPath` (keeps id stable)

- [ ] **Step 1: Write the failing test**

Add to `packages/core/test/store.test.ts` (match the existing setup pattern in that file — a temp dir + `SnapshotStore`):

```ts
it('renames a document path and display name without changing its id', () => {
  const doc = store.addDocument('/Users/test/old.docx');
  const updated = store.renameDocumentPath(doc.id, '/Users/test/new.docx', 'new.docx');
  expect(updated.id).toBe(doc.id);           // id (and FK references) stay stable
  expect(updated.path).toBe('/Users/test/new.docx');
  expect(updated.name).toBe('new.docx');
  // Branches/commits still resolve against the same id.
  expect(store.listBranches(doc.id)).toHaveLength(1);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @docgit/core test -- store`
Expected: FAIL — `renameDocumentPath` is not a function.

- [ ] **Step 3: Implement** — in `store.ts`, after `addDocument` (~line 312):

```ts
  /**
   * Point a tracked document at a new on-disk path + display name. The document
   * id is derived from the original path but is the PK referenced by branches
   * and commits, so it is deliberately NOT recomputed — only path/name change.
   * The filesystem move itself is the caller's responsibility (service layer).
   */
  renameDocumentPath(documentId: string, newPath: string, newName: string): DocumentRow {
    const path = resolve(newPath);
    this.db.prepare('UPDATE documents SET path = ?, name = ? WHERE id = ?').run(path, newName, documentId);
    return this.getDocument(documentId);
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @docgit/core test -- store`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/store/store.ts packages/core/test/store.test.ts
git commit -m "core: renameDocumentPath updates path+name, keeps id stable"
```

### Task C2: Service `renameDocument` — fs.rename + watcher + rollback

- [ ] **Step 1: Add an `unwatch` helper** — in `service.ts`, after `watch` (~line 640):

```ts
  private unwatch(documentId: string): void {
    const w = this.watchers.get(documentId);
    if (w) { void w.close(); this.watchers.delete(documentId); }
  }
```

- [ ] **Step 2: Implement `renameDocument`** — in `service.ts`, in the Documents section (after `addDocuments`). It performs the risky fs op first, then DB, rolling the file back if the DB write fails, then re-points the watcher. Map fs errors to friendly, throwable messages:

```ts
  /**
   * Rename a tracked document's base name on disk AND in DocGit so the two never
   * drift. Extension is preserved; the doc id (and its history) is unchanged.
   * Throws a user-facing message on collision or a locked/cloud file.
   */
  renameDocument(documentId: string, newBaseName: string): DocumentRow {
    const doc = this.store.getDocument(documentId);
    if (isRemoteKey(doc.path)) throw new Error('Remote documents cannot be renamed here.');
    const dir = dirname(doc.path);
    const ext = extname(doc.path);
    const base = newBaseName.trim().replace(/\.[^.]+$/, ''); // ignore any extension the user typed
    if (!base) throw new Error('Please enter a name.');
    const newPath = join(dir, `${base}${ext}`);
    if (newPath === doc.path) return doc;
    if (existsSync(newPath)) throw new Error(`A file called “${base}${ext}” already exists in this folder.`);

    this.unwatch(documentId);
    try {
      renameSync(doc.path, newPath); // risky op first
    } catch (err) {
      this.watch(doc); // restore watcher on the original path
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
        throw new Error('Word may have this file open — close it and try again.');
      }
      throw new Error(`Couldn’t rename the file on disk (${code ?? 'unknown error'}). Nothing was changed.`);
    }
    let updated: DocumentRow;
    try {
      updated = this.store.renameDocumentPath(documentId, newPath, `${base}${ext}`);
    } catch (err) {
      renameSync(newPath, doc.path); // roll the file back so disk + DocGit stay consistent
      this.watch(doc);
      throw err;
    }
    this.watch(updated);
    this.onChanged(documentId);
    return updated;
  }
```

Ensure the imports at the top of `service.ts` include `renameSync`, `existsSync`, `extname`, `join`, `dirname` (extend the existing `node:fs` / `node:path` import lines — several are already imported).

- [ ] **Step 3: Verify**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/main/service.ts
git commit -m "desktop: renameDocument — fs.rename + watcher re-point + rollback"
```

### Task C3: IPC + preload for rename

- [ ] **Step 1: IPC** — in `apps/desktop/src/main/index.ts`, after `docs:addPaths`:

```ts
  ipcMain.handle('docs:rename', (_e, documentId: string, newBaseName: string) =>
    svc.renameDocument(documentId, newBaseName),
  );
```

- [ ] **Step 2: Preload** — in `index.ts`:

```ts
  renameDocument: (documentId: string, newBaseName: string) =>
    ipcRenderer.invoke('docs:rename', documentId, newBaseName),
```

- [ ] **Step 3: Type** — in `api.d.ts`:

```ts
  renameDocument(documentId: string, newBaseName: string): Promise<DocumentRow>;
```

- [ ] **Step 4: Verify + commit**

Run: `pnpm typecheck`
Expected: PASS.
```bash
git add apps/desktop/src/main/index.ts apps/desktop/src/preload
git commit -m "desktop: wire docs:rename through IPC/preload"
```

### Task C4: Library row `⋯` menu + rename dialog (inline error)

**File:** `apps/desktop/src/renderer/src/views/Library.tsx`

- [ ] **Step 1: Add a row menu + rename dialog state** to `Library`:

```tsx
const [menuFor, setMenuFor] = useState<string | null>(null);   // doc id whose ⋯ menu is open
const [renaming, setRenaming] = useState<DocumentInfo | null>(null);
```

- [ ] **Step 2: Add a `⋯` button** inside each `<li>` (sibling of the `doc-row` button, so the button's own click doesn't open the doc). Wrap the existing row button + a menu button in a positioned container:

```tsx
<li key={doc.id} className="doc-row-wrap">
  <button type="button" className="doc-row" /* ...existing... */>{/* unchanged */}</button>
  <button type="button" className="doc-row-menu" aria-label="More" onClick={() => setMenuFor(menuFor === doc.id ? null : doc.id)}>⋯</button>
  {menuFor === doc.id && (
    <div className="row-menu" onMouseLeave={() => setMenuFor(null)}>
      <button type="button" onClick={() => { setRenaming(doc); setMenuFor(null); }}>Rename…</button>
      {/* Delete… added in PR D */}
    </div>
  )}
</li>
```

- [ ] **Step 3: Add the rename dialog** component near `SharedDocDialog`, reusing `Modal`, with an inline red error bar that blocks on failure (the "flag harder" requirement):

```tsx
function RenameDocDialog(props: { doc: DocumentInfo; onClose: () => void; onDone: () => Promise<void> }) {
  const ext = props.doc.path.slice(props.doc.path.lastIndexOf('.'));
  const initial = props.doc.name.replace(/\.[^.]+$/, '');
  const [name, setName] = useState(initial);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true); setError('');
    try {
      await window.docgit.renameDocument(props.doc.id, name.trim());
      await props.onDone();
      props.onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^.*Error[^:]*:\s*/, '') : String(err));
      setBusy(false);
    }
  };

  return (
    <Modal title="Rename document" onClose={props.onClose}>
      <p className="modal-hint">This renames the file on your Mac too, so DocGit and Finder always match. The extension ({ext}) stays the same.</p>
      <input autoFocus className="input" value={name} onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) void submit(); }} />
      {error && <p className="modal-error" role="alert">{error}</p>}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={props.onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={busy || !name.trim()} onClick={() => void submit()}>
          {busy ? 'Renaming…' : 'Rename'}
        </button>
      </div>
    </Modal>
  );
}
```

Render it in `Library` near `sharePrompt`:

```tsx
{renaming && <RenameDocDialog doc={renaming} onClose={() => setRenaming(null)} onDone={onRefresh} />}
```

- [ ] **Step 4: Style** — add `.doc-row-wrap { position: relative; }`, a subtle `.doc-row-menu` button at the row's right edge, a `.row-menu` popover (absolute, paper background, shadow), and `.modal-error { color: #b42318; background: #fef3f2; border: 1px solid #fecdca; padding: 8px 10px; border-radius: 8px; }`.

- [ ] **Step 5: Verify**

Run: `pnpm typecheck && pnpm --filter @docgit/desktop smoke`
Expected: PASS.
Manual: rename a tracked doc → file renamed in Finder, library label updates, history preserved; try renaming to a name that already exists → inline red error, nothing changes; open the file in Word then rename → "Word may have this file open" error.

- [ ] **Step 6: Commit + PR**

```bash
git add apps/desktop/src/renderer
git commit -m "desktop: rename a document (disk + DocGit) from the library row menu"
gh pr create --title "Rename documents (disk + DocGit in sync)" --body "Adds a library-row ⋯ menu with Rename. Renames the real file on disk and the DocGit label together, keeping doc id/history stable. Inline blocking errors for name collisions and locked/open files. Adds a TECH-NOTES entry for the iCloud-placeholder edge. Test Plan: core tests + typecheck + smoke green; manually renamed, hit a collision, and renamed with the file open in Word."
```

- [ ] **Step 7: TECH-NOTES** — append to `docs/TECH-NOTES.md` a note that renaming a file that is an un-downloaded iCloud placeholder may fail with a generic fs error, and the rename is all-or-nothing by design. Commit with the PR.

---

## PR D — Delete document (DocGit and/or Trash)

**Files:**
- Modify: `packages/core/src/store/store.ts` (new `deleteDocument`)
- Modify: `packages/core/test/store.test.ts` (new test)
- Modify: `apps/desktop/src/main/service.ts` (new `deleteDocument` with `shell.trashItem`)
- Modify: `apps/desktop/src/main/index.ts` (new `docs:delete`)
- Modify: `apps/desktop/src/preload/index.ts` + `api.d.ts`
- Modify: `apps/desktop/src/renderer/src/views/Library.tsx` (Delete in row menu + confirm modal)

### Task D1: Store `deleteDocument` (cascade)

- [ ] **Step 1: Write the failing test**

Add to `packages/core/test/store.test.ts`:

```ts
it('deletes a document and all its branches/commits', () => {
  const doc = store.addDocument('/Users/test/gone.docx');
  store.deleteDocument(doc.id);
  expect(() => store.getDocument(doc.id)).toThrow();
  expect(store.listDocuments().some((d) => d.id === doc.id)).toBe(false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @docgit/core test -- store`
Expected: FAIL — `deleteDocument` is not a function.

- [ ] **Step 3: Implement** — in `store.ts`, after `renameDocumentPath`. Delete children explicitly (FK order) so it works whether or not `PRAGMA foreign_keys` cascade is on:

```ts
  /** Permanently remove a document and all its DocGit history. The file on disk is untouched. */
  deleteDocument(documentId: string): void {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM sends WHERE commit_id IN (SELECT id FROM commits WHERE document_id = ?)').run(documentId);
      this.db.prepare('DELETE FROM links WHERE doc_document_id = ? OR source_document_id = ?').run(documentId, documentId);
      this.db.prepare('DELETE FROM commits WHERE document_id = ?').run(documentId);
      this.db.prepare('DELETE FROM branches WHERE document_id = ?').run(documentId);
      this.db.prepare('DELETE FROM remotes WHERE document_id = ?').run(documentId);
      this.db.prepare('DELETE FROM documents WHERE id = ?').run(documentId);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @docgit/core test -- store`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/store/store.ts packages/core/test/store.test.ts
git commit -m "core: deleteDocument removes a document and its history"
```

### Task D2: Service `deleteDocument` — Trash-first ordering

- [ ] **Step 1: Implement** — in `service.ts`. Trash the real file FIRST (so a failed Trash leaves the doc fully tracked), then stop watching, then delete from the store. `shell` comes from `electron`:

```ts
  /**
   * Remove a document from DocGit, optionally moving the real file to the Trash.
   * Ordered so a failed Trash never leaves DocGit half-deleted.
   */
  async deleteDocument(documentId: string, opts: { trashFile: boolean }): Promise<void> {
    const doc = this.store.getDocument(documentId);
    if (opts.trashFile && !isRemoteKey(doc.path)) {
      await shell.trashItem(doc.path); // throws if locked/missing → abort with doc intact
    }
    this.unwatch(documentId);
    this.store.deleteDocument(documentId);
    this.onChanged(documentId);
  }
```

Add `shell` to the `electron` import in `service.ts` if not already present (the service may not currently import from `electron`; if importing `shell` here is undesirable, pass a `trash` callback in from `main/index.ts` instead — prefer importing `shell` directly to keep the chain simple).

- [ ] **Step 2: Verify**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/main/service.ts
git commit -m "desktop: deleteDocument with optional move-to-Trash (trash-first ordering)"
```

### Task D3: IPC + preload for delete

- [ ] **Step 1: IPC** — in `main/index.ts`, after `docs:rename`:

```ts
  ipcMain.handle('docs:delete', (_e, documentId: string, opts: { trashFile: boolean }) =>
    svc.deleteDocument(documentId, opts),
  );
```

- [ ] **Step 2: Preload** — in `index.ts`:

```ts
  deleteDocument: (documentId: string, opts: { trashFile: boolean }) =>
    ipcRenderer.invoke('docs:delete', documentId, opts),
```

- [ ] **Step 3: Type** — in `api.d.ts`:

```ts
  deleteDocument(documentId: string, opts: { trashFile: boolean }): Promise<void>;
```

- [ ] **Step 4: Verify + commit**

Run: `pnpm typecheck`
Expected: PASS.
```bash
git add apps/desktop/src/main/index.ts apps/desktop/src/preload
git commit -m "desktop: wire docs:delete through IPC/preload"
```

### Task D4: Delete in row menu + destructive confirm

**File:** `apps/desktop/src/renderer/src/views/Library.tsx`

- [ ] **Step 1: Add Delete to the row menu** (built in PR C). In the `.row-menu`:

```tsx
<button type="button" className="row-menu-danger" onClick={() => { setDeleting(doc); setMenuFor(null); }}>Delete…</button>
```
And state: `const [deleting, setDeleting] = useState<DocumentInfo | null>(null);`

- [ ] **Step 2: Add the confirm dialog** near `RenameDocDialog`. The confirm button relabels and turns destructive when the Trash box is checked; a caveat shows for shared docs:

```tsx
function DeleteDocDialog(props: { doc: DocumentInfo; onClose: () => void; onDone: () => Promise<void> }) {
  const [trashFile, setTrashFile] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setBusy(true); setError('');
    try {
      await window.docgit.deleteDocument(props.doc.id, { trashFile });
      await props.onDone();
      props.onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^.*Error[^:]*:\s*/, '') : String(err));
      setBusy(false);
    }
  };

  return (
    <Modal title={`Remove “${props.doc.name}”?`} onClose={props.onClose}>
      <p className="modal-hint">This removes the document and its DocGit history. By default your file on disk is left alone.</p>
      <label className="modal-check">
        <input type="checkbox" checked={trashFile} onChange={(e) => setTrashFile(e.target.checked)} />
        Also move the original file to the Trash
      </label>
      {trashFile && props.doc.shared && (
        <p className="modal-warn">This file is in a shared cloud folder — trashing it may remove it for others too.</p>
      )}
      {error && <p className="modal-error" role="alert">{error}</p>}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={props.onClose}>Cancel</button>
        <button type="button" className={`btn ${trashFile ? 'btn-danger' : 'btn-primary'}`} disabled={busy} onClick={() => void submit()}>
          {busy ? 'Removing…' : trashFile ? 'Remove & move file to Trash' : 'Remove from DocGit'}
        </button>
      </div>
    </Modal>
  );
}
```

Render in `Library`: `{deleting && <DeleteDocDialog doc={deleting} onClose={() => setDeleting(null)} onDone={onRefresh} />}`

- [ ] **Step 3: Style** — add `.btn-danger { background: #b42318; color: #fff; }`, `.row-menu-danger { color: #b42318; }`, `.modal-warn { color: #b54708; font-size: 0.85em; }`, `.modal-check { display: flex; gap: 8px; align-items: center; margin: 8px 0; }`.

- [ ] **Step 4: Verify**

Run: `pnpm typecheck && pnpm --filter @docgit/desktop smoke`
Expected: PASS.
Manual: delete DocGit-only → row gone, file still on disk; delete with Trash checked → confirm turns red, file moves to Trash and is recoverable.

- [ ] **Step 5: Commit + PR**

```bash
git add apps/desktop/src/renderer
git commit -m "desktop: delete a document — DocGit-only or also move file to Trash"
gh pr create --title "Delete documents (DocGit and/or Trash)" --body "Adds Delete to the library-row menu. Always removes from DocGit; optional, clearly-destructive 'move original to Trash' (recoverable). Test Plan: core tests + typecheck + smoke green; deleted DocGit-only (file kept) and with Trash (file in Trash)."
```

---

## PR E — Details panel simplification

**File:** `apps/desktop/src/renderer/src/views/DocumentView.tsx` (the dock Details tab + branch admin region) + renderer stylesheet.

Pure UI refactor — no new store/IPC. Verified by typecheck + smoke + manual.

### Task E1: Collapse version-rename into a header `⋯`

- [ ] **Step 1: Read** the Details header region (the timestamp + `AUTO-SAVED` chip + `✎ Rename` button) and the branch admin row (`BRANCH "MAIN"` + `Rename branch` + colour dropdown) to note exact handlers (`renameVersion`, `renameBranch`, `setBranchColor`).
- [ ] **Step 2: Implement** — replace the visible version `✎ Rename` button with a small `⋯` button on the header that opens a tiny menu containing "Rename this version" (wired to the existing version-rename dialog). Keep the existing dialog/handler; only the trigger moves.
- [ ] **Step 3: Verify** `pnpm typecheck`. Manual: rename-this-version still works from the header `⋯`.
- [ ] **Step 4: Commit** `git commit -am "desktop: move version-rename into the Details header overflow menu"`

### Task E2: Single `Branch ⋯` menu (Rename · Reason · Colour · Archive)

- [ ] **Step 1: Implement** — replace the `BRANCH "MAIN"` admin row (Rename branch button + raw `#hex` colour `<select>`) with one `Branch ⋯` button opening a menu:
  - **Rename** → existing `renameBranch` dialog.
  - **Reason** → a small dialog calling `window.docgit.setBranchReason(doc.id, branch.id, reason)` (from PR A), prefilled with `branch.reason ?? ''`, offering the same `REASON_PRESETS` chips.
  - **Colour** → a row of swatches from the branch palette (`['#6366f1','#10b981','#f59e0b','#ec4899','#06b6d4','#8b5cf6','#ef4444','#84cc16']`) calling `setBranchColor`; **no hex text shown**.
  - **Archive** → existing `setBranchArchived` (omit/disable for the current branch, matching the store guard).
- [ ] **Step 2: Style** swatches: `.swatch { width: 18px; height: 18px; border-radius: 50%; } .swatch.is-active { outline: 2px solid #111; outline-offset: 2px; }`.
- [ ] **Step 3: Verify** `pnpm typecheck && pnpm --filter @docgit/desktop smoke`. Manual: rename/reason/colour/archive all work from the one menu; no hex code visible.
- [ ] **Step 4: Commit** `git commit -am "desktop: collapse branch admin into one Branch ⋯ menu; swatches not hex"`

### Task E3: Demote "Mark as sent…" and finalize layout

- [ ] **Step 1: Implement** — keep **Open in Word** and **Branch from here** as the two primary buttons; render **Mark as sent…** as a quiet text link (`className="link-action"`) beneath them. Ensure the branch pill in the Details body shows a colour dot + name, with the reason subtitle when present.
- [ ] **Step 2: Style** `.link-action { background: none; border: none; color: var(--accent,#6366f1); cursor: pointer; padding: 4px 0; }`.
- [ ] **Step 3: Verify** `pnpm typecheck && pnpm --filter @docgit/desktop smoke`. Manual: panel matches the spec mockup; all actions reachable.
- [ ] **Step 4: Commit + PR**

```bash
git commit -am "desktop: demote Mark-as-sent to a text link; tidy Details layout"
gh pr create --title "Simplify the Details dock panel" --body "Declutters Details: version-rename into a header ⋯, branch admin collapsed into one Branch ⋯ menu (Rename/Reason/Colour/Archive), hex dropdown replaced with colour swatches, Mark-as-sent demoted to a text link. Matches the design mockup. Test Plan: typecheck + smoke green; exercised every moved control manually."
```

---

## Final verification (after all PRs)

- [ ] Run the full gate at the repo root: `pnpm build && pnpm typecheck && pnpm test && pnpm --filter @docgit/desktop smoke` — all green.
- [ ] `docs/TECH-NOTES.md` updated for the rename iCloud-placeholder edge.
- [ ] Folders remain deferred to issue #52.

---

## Self-Review

**Spec coverage:**
- Drag-and-drop add → PR B ✓
- Rename (disk + DocGit, id stable, extension preserved, blocking errors) → PR C ✓
- Delete (DocGit-only default + Trash opt-in, destructive state, shared caveat, trash-first ordering) → PR D ✓ (matches the corrected ordering in the spec)
- Branch reason (chips + free text, display, later edit) → PR A (create + display) + PR E task E2 (edit) ✓
- Details panel simplification (version-rename into ⋯, Branch ⋯ menu, swatches, demote sent) → PR E ✓
- Folders deferred → issue #52 ✓

**Type consistency:** `renameDocumentPath`/`renameDocument`, `deleteDocument`, `setBranchReason`, `addDocuments`/`addDocumentByPaths`, `pathForFile` are used with identical signatures across store→service→IPC→preload→`DocgitApi`. `createBranch`'s new optional `reason` is 4th arg at the service/preload layer and 5th (after `color`) at the store layer — intentional, since the store keeps `color` as the 4th positional; verified each call site passes `undefined` for color where needed.

**Placeholder scan:** No TBD/TODO. Every code step shows concrete code; renderer steps that touch large existing files (DocumentView, Library) instruct a read-first then give the exact new code and insertion point.
