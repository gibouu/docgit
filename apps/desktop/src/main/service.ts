import {
  diffModels,
  extractAuthor,
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
import { shell } from 'electron';
import chokidar, { type FSWatcher } from 'chokidar';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { appendLog } from './log.js';

export type CloudProvider = 'iCloud Drive' | 'OneDrive' | 'Dropbox' | 'Google Drive';

export interface CloudStatus {
  /** Set when the file lives in a cloud-synced folder (possibly shared with others). */
  provider: CloudProvider | null;
  /** Sibling conflict copies ("Contract 2.docx", "Contract (1).docx") the sync service created. */
  conflictCopies: string[];
}

/** Cloud-synced locations on macOS: iCloud's Mobile Documents and the FileProvider mounts. */
export function detectCloudProvider(path: string): CloudProvider | null {
  if (path.includes('/Library/Mobile Documents/')) return 'iCloud Drive';
  if (path.includes('/Library/CloudStorage/OneDrive')) return 'OneDrive';
  if (path.includes('/Library/CloudStorage/Dropbox') || /\/Dropbox\//.test(path)) return 'Dropbox';
  if (path.includes('/Library/CloudStorage/GoogleDrive')) return 'Google Drive';
  return null;
}

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
  private logPath: string;

  constructor(
    dbPath: string,
    private onChanged: (documentId: string) => void,
  ) {
    this.store = new SnapshotStore(dbPath);
    this.logPath = join(dirname(dbPath), 'activity.log');
    this.log(`startup — tracking ${this.store.listDocuments().length} document(s)`);
    for (const doc of this.store.listDocuments()) {
      if (isRemoteKey(doc.path)) this.startPoller(doc.id);
      else this.watch(doc);
    }
  }

  /**
   * Append a timestamped line to activity.log in the data directory. This is
   * the diagnostic trail for "my save didn't show up" reports — it records
   * every watcher event, commit outcome, and file write.
   */
  private log(message: string): void {
    appendLog(this.logPath, message);
  }

  /** Flush pending writes to the main DB file so an on-disk backup is complete. */
  checkpoint(): void {
    this.store.checkpoint();
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

  /** Mark a document shared (or not) and set the name to attribute this user's own edits to. */
  setSharing(documentId: string, shared: boolean, myName: string | null): DocumentRow {
    const doc = this.store.setSharing(documentId, shared, myName);
    this.onChanged(documentId);
    return doc;
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

  /**
   * Readable content of a version for the preview pane. DocGit can't render a
   * pixel-perfect Office visual, so this returns the extracted text/structure
   * of the snapshot — paragraphs for Word, cells per sheet for spreadsheets,
   * shape text per slide for decks.
   */
  versionPreview(commitId: string): { kind: string; lines: string[] } {
    const model = this.store.getModel(this.store.getCommit(commitId));
    if (model.kind === 'spreadsheet') {
      const lines: string[] = [];
      for (const sheet of model.sheets) {
        lines.push(`▦ ${sheet.name}`);
        for (const [ref, cell] of Object.entries(sheet.cells)) {
          lines.push(`  ${ref}: ${cell.v}${cell.f ? `   ${cell.f}` : ''}`);
        }
      }
      return { kind: 'spreadsheet', lines };
    }
    if (model.kind === 'slides') {
      const lines: string[] = [];
      model.slides.forEach((slide, i) => {
        lines.push(`◻ Slide ${i + 1}`);
        for (const shape of slide.shapes) lines.push(`  ${shape.text.replace(/\n/g, ' / ')}`);
      });
      return { kind: 'slides', lines };
    }
    const lines = model.blocks.map((b) =>
      b.type === 'paragraph' ? b.text : b.rows.map((r) => r.join(' | ')).join('\n'),
    );
    return { kind: 'text', lines };
  }

  /** Cloud-sync situation for a document: provider + any conflict copies next to it. */
  cloudStatus(documentId: string): CloudStatus {
    const doc = this.store.getDocument(documentId);
    if (isRemoteKey(doc.path)) return { provider: null, conflictCopies: [] };
    return { provider: detectCloudProvider(doc.path), conflictCopies: this.findConflictCopies(doc.path) };
  }

  /** Track a document by explicit path (e.g. adopting a conflict copy). */
  addDocumentByPath(path: string): DocumentRow {
    return this.addDocument(path);
  }

  /** Track several files at once (drag-and-drop). Returns the resulting documents. */
  addDocuments(paths: string[]): DocumentRow[] {
    return paths.map((p) => this.addDocument(p));
  }

  /**
   * Remove a document from DocGit, optionally moving the real file to the Trash.
   * Ordered so a failed Trash never leaves DocGit half-deleted: the file is
   * trashed FIRST, so if that throws the document stays fully tracked + watched.
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
      // The DB write failed; try to roll the file back so disk matches the record
      // DocGit still holds. If the rollback ALSO fails (double fault), the file is
      // stranded at newPath — re-watch it there so the document is never left
      // unwatched, then surface the original error. (See TECH-NOTES.)
      try {
        renameSync(newPath, doc.path);
        this.watch(doc);
      } catch {
        this.watch(existsSync(newPath) ? { ...doc, path: newPath } : doc);
      }
      throw err;
    }
    this.watch(updated);
    this.onChanged(documentId);
    return updated;
  }

  /**
   * Sync services resolve concurrent edits by dropping a renamed copy next
   * to the original — "Contract 2.docx" (iCloud), "Contract (1).docx"
   * (OneDrive/Drive). Those may hold someone else's latest work.
   */
  private findConflictCopies(path: string): string[] {
    const dir = dirname(path);
    const name = basename(path);
    const ext = extname(name);
    const base = name.slice(0, name.length - ext.length);
    const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`^${escaped}(?: \\d+| \\(\\d+\\))${ext.replace('.', '\\.')}$`, 'i');
    try {
      return readdirSync(dir)
        .filter((entry) => pattern.test(entry))
        .map((entry) => join(dir, entry));
    } catch {
      return [];
    }
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
    this.log(`ACTION restoreVersion ${commitId.slice(0, 8)}`);
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

  /** Switch the working branch and sync the file on disk to that branch's latest version. */
  switchBranch(documentId: string, branchId: string): BranchRow {
    this.log(`ACTION switchBranch → ${branchId.slice(0, 8)}`);
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
    this.writeFileAtomic(doc.path, bytes);
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
      this.writeFileAtomic(doc.path, bytes);
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
    } catch (err) {
      this.log(`commit SKIP unreadable ${basename(path)} (${(err as Error).message})`);
      return undefined; // transient: editor mid-save or file temporarily gone
    }
    let model;
    try {
      model = parseDocument(path, bytes);
    } catch (err) {
      this.log(`commit SKIP unparseable ${basename(path)} (${bytes.length} bytes; ${(err as Error).message})`);
      return undefined; // not a parseable document right now (partial write)
    }
    // Who edited it: read the name the Office app embedded in the file. This
    // works across collaborators because it travels inside the document.
    const author = extractAuthor(bytes) ?? undefined;
    const result = this.store.commit(path, bytes, model, {
      ...(message !== undefined ? { message } : {}),
      ...(coalesceWindowMs !== undefined ? { coalesceWindowMs } : {}),
      ...(author ? { author } : {}),
    });
    this.log(
      `commit ${basename(path)} → ${result.created ? 'CAPTURED' : 'no-change'} ` +
        `head=${result.commit.id.slice(0, 8)} branch=${result.commit.branchId.slice(0, 8)} ` +
        `content=${result.commit.modelHash.slice(0, 8)} author="${result.commit.author ?? ''}" msg="${result.commit.message ?? ''}"`,
    );
    return result;
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
    this.log(`WRITE-TO-DISK ${basename(doc.path)} ← version ${commitId.slice(0, 8)} content=${commit.modelHash.slice(0, 8)}`);
    this.writeFileAtomic(doc.path, this.store.getFileBytes(commit));
  }

  /**
   * Write a document back to disk crash-safely: stage the bytes in a sibling
   * temp file, then rename it over the target. A rename within one directory is
   * atomic, so a reader (or a crash) sees either the whole old file or the whole
   * new one — never a half-written, corrupt document. This mirrors how Word
   * itself saves (temp + rename), which is why the directory watcher already
   * copes with it; the temp's name doesn't match the watched file, so it never
   * triggers a spurious auto-commit.
   */
  private writeFileAtomic(filePath: string, data: Uint8Array): void {
    const tmp = join(dirname(filePath), `.${basename(filePath)}.docgit-${randomUUID().slice(0, 8)}.tmp`);
    try {
      writeFileSync(tmp, data);
      renameSync(tmp, filePath);
    } catch (err) {
      try {
        if (existsSync(tmp)) unlinkSync(tmp);
      } catch {
        // best-effort temp cleanup; surface the original write error
      }
      throw err;
    }
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
    const onEvent = (event: string) => (path: string) => {
      if (basename(path) !== name) return;
      this.log(`watcher ${event} ${name}`);
      this.autoCommit(doc);
    };
    watcher.on('add', onEvent('add'));
    watcher.on('change', onEvent('change'));
    watcher.on('error', (err) => this.log(`watcher ERROR ${name}: ${String(err)}`));
    this.watchers.set(doc.id, watcher);
    this.watchersReady.push(new Promise((resolve) => watcher.once('ready', resolve)));
    this.log(`watching ${name} in ${dir}`);
  }

  private unwatch(documentId: string): void {
    const w = this.watchers.get(documentId);
    if (w) {
      void w.close();
      this.watchers.delete(documentId);
    }
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
