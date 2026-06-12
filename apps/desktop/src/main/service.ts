import {
  diffModels,
  findLinkableOccurrences,
  formatValue,
  GristClient,
  insertLinkedValue,
  isRemoteKey,
  parseDocument,
  refreshLinkedValue,
  SnapshotStore,
  type BranchRow,
  type CommitResult,
  type CommitRow,
  type DocDiff,
  type DocumentGraph,
  type DocumentRow,
  type DocumentSummary,
  type LinkableOccurrence,
  type LinkRow,
  type SendRow,
  type UpstreamStatus,
  type ValueFormat,
} from '@docgit/core';
import chokidar, { type FSWatcher } from 'chokidar';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export interface LinkInfo {
  link: LinkRow;
  sourceName: string;
  /** The source workbook has versions newer than what this link last pulled. */
  stale: boolean;
  format: ValueFormat;
}

export interface CreateLinkPayload {
  sourceDocumentId: string;
  sheet: string;
  cellRef: string;
  format: ValueFormat;
  search: string;
  occurrence: number;
}

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

/** Remote (API-backed) documents are polled for changes at this interval. */
const REMOTE_POLL_MS = 15_000;

export type DocumentInfo = DocumentSummary & { remoteKind: string | null };

/** Excel "b14" → "B14"; Grist refs ("Amount:1") are case-sensitive ids — left alone. */
function normalizeCellRef(ref: string): string {
  return /^[A-Za-z]+\d+$/.test(ref) ? ref.toUpperCase() : ref;
}

export class DocumentService {
  private store: SnapshotStore;
  private watchers = new Map<string, FSWatcher>();
  private watchersReady: Promise<void>[] = [];
  private pollers = new Map<string, NodeJS.Timeout>();

  constructor(
    dbPath: string,
    private onChanged: (documentId: string) => void,
  ) {
    this.store = new SnapshotStore(dbPath);
    for (const doc of this.store.listDocuments()) {
      if (isRemoteKey(doc.path)) this.startPoller(doc.id);
      else this.watch(doc);
    }
  }

  dispose(): void {
    for (const watcher of this.watchers.values()) void watcher.close();
    this.watchers.clear();
    for (const poller of this.pollers.values()) clearInterval(poller);
    this.pollers.clear();
    this.store.close();
  }

  // ── Documents ──────────────────────────────────────────────────────────

  listDocuments(): DocumentInfo[] {
    return this.store.listDocuments().map((doc) => ({
      ...doc,
      remoteKind: this.store.getRemote(doc.id)?.kind ?? null,
    }));
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

  /** Where "open" should take the user: the file on disk, or the remote editor. */
  openTarget(documentId: string): { kind: 'file' | 'url'; target: string } {
    const doc = this.store.getDocument(documentId);
    const remote = this.store.getRemote(documentId);
    if (remote) {
      return { kind: 'url', target: `${remote.baseUrl.replace(/\/+$/, '')}/doc/${encodeURIComponent(remote.remoteDocId)}` };
    }
    return { kind: 'file', target: doc.path };
  }

  // ── Remote documents (Grist) ───────────────────────────────────────────

  /** Connect a Grist document: read-only tracking — snapshot, diff, branch view, link source. */
  async addGristDocument(baseUrl: string, remoteDocId: string, apiKey?: string): Promise<DocumentRow> {
    const host = new URL(baseUrl).host;
    const key = `grist://${host}/${remoteDocId}`;
    const doc = this.store.addDocument(key, `${remoteDocId} · Grist`);
    this.store.setRemote(doc.id, { kind: 'grist', baseUrl, remoteDocId, ...(apiKey ? { apiKey } : {}) });
    await this.syncRemote(doc.id);
    this.startPoller(doc.id);
    this.onChanged(doc.id);
    return doc;
  }

  /** Pull the current remote state and version it if it changed. */
  async syncRemote(documentId: string): Promise<CommitResult | undefined> {
    const doc = this.store.getDocument(documentId);
    const remote = this.store.getRemote(documentId);
    if (!remote || remote.kind !== 'grist') return undefined;
    const client = new GristClient({
      baseUrl: remote.baseUrl,
      docId: remote.remoteDocId,
      ...(remote.apiKey ? { apiKey: remote.apiKey } : {}),
    });
    const [model, bytes] = await Promise.all([client.fetchModel(), client.downloadBytes()]);
    // No coalescing for remote syncs: every detected server-side change is a
    // distinct version (unchanged polls are no-ops via content dedupe).
    const result = this.store.commit(doc.path, bytes, model, { message: 'Synced from Grist' });
    if (result.created) {
      this.onChanged(documentId);
      this.propagateFrom(documentId);
    }
    return result;
  }

  private startPoller(documentId: string): void {
    if (this.pollers.has(documentId)) return;
    const poller = setInterval(() => {
      this.syncRemote(documentId).catch(() => {
        // Server unreachable — versioning pauses until it comes back.
      });
    }, REMOTE_POLL_MS);
    this.pollers.set(documentId, poller);
  }

  // ── Versions ───────────────────────────────────────────────────────────

  saveVersion(documentId: string, message?: string): CommitResult {
    const doc = this.store.getDocument(documentId);
    if (isRemoteKey(doc.path)) {
      void this.syncRemote(documentId);
      return { commit: this.headCommit(documentId)!, created: false };
    }
    const result = this.commitPath(doc.path, message);
    if (result?.created) {
      this.onChanged(documentId);
      this.propagateFrom(documentId);
    }
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

  renameVersion(documentId: string, commitId: string, message: string): void {
    this.store.setCommitMessage(commitId, message);
    this.onChanged(documentId);
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
    const remote = this.store.getRemote(commit.documentId);
    const ext = remote?.kind === 'grist' ? '.grist' : doc.name.includes('.') ? doc.name.slice(doc.name.lastIndexOf('.')) : '';
    const base = doc.name.includes('.') && !remote ? doc.name.slice(0, -ext.length) : doc.name;
    const path = join(dir, `${base} (version ${stamp})${ext}`);
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

  /** Upstream status per non-archived branch (translation/variant "behind by N" badges). */
  branchStatuses(documentId: string): { branchId: string; status: UpstreamStatus | null }[] {
    return this.store
      .listBranches(documentId)
      .filter((b) => !b.archived)
      .map((b) => ({ branchId: b.id, status: this.store.upstreamStatus(b.id) }));
  }

  markBranchSynced(documentId: string, branchId: string): BranchRow {
    const branch = this.store.markSyncedWithUpstream(branchId);
    this.onChanged(documentId);
    return branch;
  }

  // ── Live links (Excel → Word inline values) ───────────────────────────

  listWorkbooks(): DocumentSummary[] {
    return this.store
      .listDocuments()
      .filter((d) => d.path.toLowerCase().endsWith('.xlsx') || this.store.getRemote(d.id)?.kind === 'grist');
  }

  workbookSheets(sourceDocumentId: string): string[] {
    const model = this.headModel(sourceDocumentId);
    return model?.kind === 'spreadsheet' ? model.sheets.map((s) => s.name) : [];
  }

  workbookCell(sourceDocumentId: string, sheet: string, cellRef: string): { value: string; formula?: string } | null {
    const model = this.headModel(sourceDocumentId);
    if (model?.kind !== 'spreadsheet') return null;
    const cell = model.sheets.find((s) => s.name === sheet)?.cells[normalizeCellRef(cellRef)];
    return cell ? { value: cell.v, ...(cell.f ? { formula: cell.f } : {}) } : null;
  }

  findOccurrences(documentId: string, search: string): LinkableOccurrence[] {
    const doc = this.store.getDocument(documentId);
    return findLinkableOccurrences(readFileSync(doc.path), search);
  }

  links(documentId: string): LinkInfo[] {
    return this.store.linksForDocument(documentId).map((link) => {
      const source = this.store.getDocument(link.sourceDocumentId);
      const sourceHead = this.headCommit(link.sourceDocumentId);
      return {
        link,
        sourceName: source.name,
        stale: !!sourceHead && link.lastSourceCommitId !== sourceHead.id,
        format: JSON.parse(link.format) as ValueFormat,
      };
    });
  }

  /**
   * Bind a value in the document to a workbook cell: the matched text is
   * replaced by the cell's current (formatted) value inside a tagged content
   * control, and the whole operation is a version.
   */
  createLink(documentId: string, payload: CreateLinkPayload): LinkInfo {
    const doc = this.store.getDocument(documentId);
    const source = this.store.getDocument(payload.sourceDocumentId);
    const sourceHead = this.headCommit(payload.sourceDocumentId);
    if (!sourceHead) throw new Error(`${source.name} has no versions yet`);
    const cell = this.workbookCell(payload.sourceDocumentId, payload.sheet, payload.cellRef);
    if (!cell) throw new Error(`${payload.sheet}!${payload.cellRef} is empty or missing in ${source.name}`);

    const display = formatValue(cell.value, payload.format);
    this.snapshotDiskBeforeOverwrite(documentId);

    const id = randomUUID();
    const bytes = insertLinkedValue(readFileSync(doc.path), payload.search, payload.occurrence, id, display);
    if (!bytes) throw new Error('That text was not found anymore — the document changed. Try again.');
    writeFileSync(doc.path, bytes);
    this.commitPath(doc.path, `Linked ${payload.sheet}!${payload.cellRef} ← ${source.name}`);

    this.store.createLink({
      id,
      docDocumentId: documentId,
      sourceDocumentId: payload.sourceDocumentId,
      sheet: payload.sheet,
      cellRef: normalizeCellRef(payload.cellRef),
      format: JSON.stringify(payload.format),
      lastValue: display,
      lastSourceCommitId: sourceHead.id,
    });
    this.onChanged(documentId);
    return this.links(documentId).find((l) => l.link.id === id)!;
  }

  /**
   * Pull current values from all linked workbooks into the document.
   * Value changes are applied in one pass and recorded as a single version
   * whose message lists every change. Returns the number of values updated.
   */
  refreshLinks(documentId: string): number {
    const doc = this.store.getDocument(documentId);
    const links = this.store.linksForDocument(documentId);
    if (links.length === 0) return 0;

    let bytes: Uint8Array;
    try {
      bytes = readFileSync(doc.path);
    } catch {
      return 0;
    }

    const changes: string[] = [];
    for (const link of links) {
      const sourceHead = this.headCommit(link.sourceDocumentId);
      if (!sourceHead) continue;
      const cell = this.workbookCell(link.sourceDocumentId, link.sheet, link.cellRef);
      if (!cell) continue; // cell deleted in the workbook — leave the document value alone
      const display = formatValue(cell.value, JSON.parse(link.format) as ValueFormat);
      if (display !== link.lastValue) {
        const refreshed = refreshLinkedValue(bytes, link.id, display);
        if (!refreshed) continue; // control deleted in Word — registry row is now inert
        bytes = refreshed.bytes;
        changes.push(`${link.sheet}!${link.cellRef}: ${refreshed.oldValue} → ${display}`);
      }
      this.store.updateLinkValue(link.id, display, sourceHead.id);
    }

    if (changes.length > 0) {
      const sourceNames = [...new Set(links.map((l) => this.store.getDocument(l.sourceDocumentId).name))];
      writeFileSync(doc.path, bytes);
      this.commitPath(doc.path, `Updated from ${sourceNames.join(', ')} — ${changes.join('; ')}`);
    }
    this.onChanged(documentId);
    return changes.length;
  }

  deleteLink(documentId: string, linkId: string): void {
    this.store.deleteLink(linkId);
    this.onChanged(documentId);
  }

  /** After a workbook commits, push its new values into every linked document. */
  private propagateFrom(sourceDocumentId: string): void {
    const targets = new Set(this.store.linksFromSource(sourceDocumentId).map((l) => l.docDocumentId));
    for (const targetId of targets) this.refreshLinks(targetId);
  }

  private headCommit(documentId: string): CommitRow | null {
    const doc = this.store.getDocument(documentId);
    const branch = this.store.getBranch(doc.currentBranchId);
    return branch.headCommitId ? this.store.getCommit(branch.headCommitId) : null;
  }

  private headModel(documentId: string) {
    const head = this.headCommit(documentId);
    return head ? this.store.getModel(head) : null;
  }

  // ── Sends ──────────────────────────────────────────────────────────────

  markSent(documentId: string, commitId: string, info: { recipient: string; channel?: string; note?: string }): SendRow {
    const send = this.store.markSent(commitId, info);
    this.onChanged(documentId);
    return send;
  }

  recipients() {
    return this.store.recipients();
  }

  sendsToRecipient(recipient: string) {
    return this.store.sendsToRecipient(recipient);
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
      const model = parseDocument(path, bytes);
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
    if (isRemoteKey(doc.path)) return; // remote documents are never written back
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
      interval: 300,
      // Wait for the write to settle before snapshotting.
      awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 },
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
    if (result?.created) {
      this.onChanged(doc.id);
      this.propagateFrom(doc.id);
    }
  }
}
