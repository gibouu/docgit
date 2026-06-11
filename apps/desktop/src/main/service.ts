import {
  diffModels,
  parseDocx,
  SnapshotStore,
  type BranchRow,
  type CommitResult,
  type DocDiff,
  type DocumentGraph,
  type DocumentRow,
  type DocumentSummary,
  type SendRow,
} from '@docgit/core';
import chokidar, { type FSWatcher } from 'chokidar';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

/**
 * Main-process façade over the core engine. Owns the snapshot store and a
 * file watcher per tracked document, so saving in Word (or any editor)
 * automatically becomes a new version. All mutations notify the renderer
 * through `onChanged`.
 */
/**
 * Auto-saves within this window collapse into one rolling "Saved" version,
 * so a Word editing session reads as one version in the tree — not one node
 * per ⌘S. Versions with sends, forks, or children are never coalesced.
 */
const AUTOSAVE_COALESCE_MS = 15 * 60_000;

export class DocumentService {
  private store: SnapshotStore;
  private watchers = new Map<string, FSWatcher>();
  private watchersReady: Promise<void>[] = [];

  constructor(
    dbPath: string,
    private onChanged: (documentId: string) => void,
  ) {
    this.store = new SnapshotStore(dbPath);
    for (const doc of this.store.listDocuments()) this.watch(doc);
  }

  dispose(): void {
    for (const watcher of this.watchers.values()) void watcher.close();
    this.watchers.clear();
    this.store.close();
  }

  // ── Documents ──────────────────────────────────────────────────────────

  listDocuments(): DocumentSummary[] {
    return this.store.listDocuments();
  }

  /** Track a document and snapshot its current content as the first version. */
  addDocument(path: string): DocumentRow {
    const doc = this.store.addDocument(path);
    this.commitPath(doc.path, 'Added to DocGit');
    this.watch(doc);
    this.onChanged(doc.id);
    return doc;
  }

  getGraph(documentId: string): DocumentGraph {
    return this.store.graph(documentId);
  }

  documentPath(documentId: string): string {
    return this.store.getDocument(documentId).path;
  }

  // ── Versions ───────────────────────────────────────────────────────────

  saveVersion(documentId: string, message?: string): CommitResult {
    const doc = this.store.getDocument(documentId);
    const result = this.commitPath(doc.path, message);
    if (result?.created) this.onChanged(documentId);
    return result!;
  }

  diff(fromCommitId: string, toCommitId: string): DocDiff {
    const from = this.store.getCommit(fromCommitId);
    const to = this.store.getCommit(toCommitId);
    return diffModels(this.store.getModel(from), this.store.getModel(to));
  }

  commitLabel(commitId: string): string {
    const commit = this.store.getCommit(commitId);
    const when = new Date(commit.createdAt).toLocaleString();
    return commit.message ? `${commit.message} — ${when}` : when;
  }

  divergence(commitId: string): number | null {
    return this.store.divergence(commitId);
  }

  /**
   * Restore an old version: its content becomes a new version on the current
   * branch AND is written back to the file on disk.
   */
  restoreVersion(documentId: string, commitId: string): CommitResult {
    this.snapshotDiskBeforeOverwrite(documentId);
    const result = this.store.restoreVersion(documentId, commitId);
    if (result.created) {
      this.writeFileFromCommit(documentId, result.commit.id);
      this.onChanged(documentId);
    }
    return result;
  }

  /** Materialize an old version as a temp copy for read-only viewing. Returns the temp path. */
  exportVersion(commitId: string): string {
    const commit = this.store.getCommit(commitId);
    const doc = this.store.getDocument(commit.documentId);
    const dir = join(tmpdir(), 'docgit-versions');
    mkdirSync(dir, { recursive: true });
    const stamp = commit.createdAt.slice(0, 16).replace(/[:T]/g, '-');
    const base = doc.name.replace(/\.docx$/i, '');
    const path = join(dir, `${base} (version ${stamp}).docx`);
    writeFileSync(path, this.store.getFileBytes(commit));
    return path;
  }

  // ── Branches ───────────────────────────────────────────────────────────

  createBranch(documentId: string, name: string, fromCommitId: string): BranchRow {
    this.snapshotDiskBeforeOverwrite(documentId);
    const branch = this.store.createBranch(documentId, name, fromCommitId);
    this.writeFileFromCommit(documentId, fromCommitId);
    this.onChanged(documentId);
    return branch;
  }

  /** Switch the working branch and sync the file on disk to that branch's latest version. */
  switchBranch(documentId: string, branchId: string): BranchRow {
    this.snapshotDiskBeforeOverwrite(documentId);
    const branch = this.store.switchBranch(documentId, branchId);
    if (branch.headCommitId) this.writeFileFromCommit(documentId, branch.headCommitId);
    this.onChanged(documentId);
    return branch;
  }

  renameBranch(documentId: string, branchId: string, name: string): BranchRow {
    const branch = this.store.renameBranch(branchId, name);
    this.onChanged(documentId);
    return branch;
  }

  setBranchColor(documentId: string, branchId: string, color: string): BranchRow {
    const branch = this.store.setBranchColor(branchId, color);
    this.onChanged(documentId);
    return branch;
  }

  setBranchArchived(documentId: string, branchId: string, archived: boolean): BranchRow {
    const branch = this.store.setBranchArchived(branchId, archived);
    this.onChanged(documentId);
    return branch;
  }

  // ── Sends ──────────────────────────────────────────────────────────────

  markSent(documentId: string, commitId: string, info: { recipient: string; channel?: string; note?: string }): SendRow {
    const send = this.store.markSent(commitId, info);
    this.onChanged(documentId);
    return send;
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private commitPath(path: string, message?: string, coalesceWindowMs?: number): CommitResult | undefined {
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch {
      return undefined; // transient: editor mid-save or file temporarily gone
    }
    try {
      const model = parseDocx(bytes);
      return this.store.commit(path, bytes, model, {
        ...(message !== undefined ? { message } : {}),
        ...(coalesceWindowMs !== undefined ? { coalesceWindowMs } : {}),
      });
    } catch {
      return undefined; // not a parseable docx right now (partial write) — skip
    }
  }

  /**
   * Last line of defense before the app overwrites the file on disk: commit
   * whatever the file currently contains onto the branch being left. If the
   * watcher already captured it this is a content-identical no-op — but if
   * any save slipped past the watcher, it is rescued here instead of being
   * destroyed by the overwrite.
   */
  private snapshotDiskBeforeOverwrite(documentId: string): void {
    const doc = this.store.getDocument(documentId);
    this.commitPath(doc.path, 'Saved', AUTOSAVE_COALESCE_MS);
  }

  private writeFileFromCommit(documentId: string, commitId: string): void {
    const doc = this.store.getDocument(documentId);
    const commit = this.store.getCommit(commitId);
    writeFileSync(doc.path, this.store.getFileBytes(commit));
  }

  private watch(doc: DocumentRow): void {
    if (this.watchers.has(doc.id)) return;
    // Watch the parent directory, not the file: Word saves atomically
    // (temp file + rename over the original), which permanently detaches any
    // watcher bound to the file's inode. A directory watch survives the swap.
    const dir = dirname(doc.path);
    const name = basename(doc.path);
    const watcher = chokidar.watch(dir, {
      ignoreInitial: true,
      depth: 0,
      // Only our document is interesting; skip sibling files entirely.
      ignored: (path) => path !== dir && basename(path) !== name,
      // Poll mtimes instead of trusting FSEvents: Word's multi-step save and
      // iCloud-synced folders (Desktop/Documents) can swallow native events.
      usePolling: true,
      interval: 1000,
      // Wait for the write to settle before snapshotting.
      awaitWriteFinish: { stabilityThreshold: 700, pollInterval: 120 },
    });
    const onEvent = (path: string) => {
      if (basename(path) === name) this.autoCommit(doc);
    };
    watcher.on('add', onEvent);
    watcher.on('change', onEvent);
    this.watchers.set(doc.id, watcher);
    this.watchersReady.push(new Promise((resolve) => watcher.once('ready', resolve)));
  }

  /** Resolves once all watchers finished their initial scan — saves before this can be missed. */
  whenWatchersReady(): Promise<void> {
    return Promise.all(this.watchersReady).then(() => undefined);
  }

  private autoCommit(doc: DocumentRow): void {
    const result = this.commitPath(doc.path, 'Saved', AUTOSAVE_COALESCE_MS);
    if (result?.created) this.onChanged(doc.id);
  }
}
