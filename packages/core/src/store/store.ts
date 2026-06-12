import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { canonicalJson, type DocModel } from '../model/types.js';

/**
 * Content-addressed snapshot store, modeled on git's object database but
 * backed by a single SQLite file (local-first; an optional sync server can
 * replicate it later). Uses the Node built-in sqlite driver so the same
 * build runs under system Node and Electron with no native-ABI rebuilds.
 *
 * - `objects` holds immutable blobs keyed by SHA-256: both the original file
 *   bytes and the normalized model JSON of every snapshot.
 * - `commits` form a tree per document; `branches` are named, colored heads
 *   into that tree, and each document tracks its current branch.
 * - `sends` tag a specific commit as having been sent to a recipient.
 */

export interface DocumentRow {
  id: string;
  path: string;
  name: string;
  currentBranchId: string;
  createdAt: string;
}

export interface DocumentSummary extends DocumentRow {
  versionCount: number;
  lastVersionAt: string | null;
  branchCount: number;
}

export interface BranchRow {
  id: string;
  documentId: string;
  name: string;
  color: string;
  headCommitId: string | null;
  archived: boolean;
  position: number;
  createdAt: string;
}

export interface CommitRow {
  id: string;
  documentId: string;
  branchId: string;
  parentId: string | null;
  modelHash: string;
  fileHash: string;
  message: string | null;
  author: string | null;
  createdAt: string;
}

export interface SendRow {
  id: number;
  commitId: string;
  recipient: string;
  channel: string | null;
  note: string | null;
  sentAt: string;
}

export interface DocumentGraph {
  document: DocumentRow;
  branches: BranchRow[];
  commits: CommitRow[];
  sends: SendRow[];
}

export interface CommitResult {
  commit: CommitRow;
  /** false when the content was identical to the current branch head (no-op). */
  created: boolean;
}

export interface LinkRow {
  id: string;
  /** The text document carrying the linked value. */
  docDocumentId: string;
  /** The workbook the value comes from. */
  sourceDocumentId: string;
  sheet: string;
  cellRef: string;
  /** Serialized ValueFormat. */
  format: string;
  lastValue: string | null;
  lastSourceCommitId: string | null;
  createdAt: string;
}

const BRANCH_COLORS = [
  '#6366f1', '#10b981', '#f59e0b', '#ec4899',
  '#06b6d4', '#8b5cf6', '#ef4444', '#84cc16',
];

function sha256(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function nowIso(): string {
  return new Date().toISOString();
}

export class SnapshotStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(resolve(dbPath)), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id                TEXT PRIMARY KEY,
        path              TEXT NOT NULL UNIQUE,
        name              TEXT NOT NULL,
        current_branch_id TEXT,
        created_at        TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS branches (
        id             TEXT PRIMARY KEY,
        document_id    TEXT NOT NULL REFERENCES documents(id),
        name           TEXT NOT NULL,
        color          TEXT NOT NULL,
        head_commit_id TEXT,
        archived       INTEGER NOT NULL DEFAULT 0,
        position       INTEGER NOT NULL,
        created_at     TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS objects (
        hash TEXT PRIMARY KEY,
        data BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS commits (
        id          TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES documents(id),
        branch_id   TEXT NOT NULL REFERENCES branches(id),
        parent_id   TEXT REFERENCES commits(id),
        model_hash  TEXT NOT NULL REFERENCES objects(hash),
        file_hash   TEXT NOT NULL REFERENCES objects(hash),
        message     TEXT,
        author      TEXT,
        created_at  TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sends (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        commit_id TEXT NOT NULL REFERENCES commits(id),
        recipient TEXT NOT NULL,
        channel   TEXT,
        note      TEXT,
        sent_at   TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS links (
        id                     TEXT PRIMARY KEY,
        doc_document_id       TEXT NOT NULL REFERENCES documents(id),
        source_document_id    TEXT NOT NULL REFERENCES documents(id),
        sheet                 TEXT NOT NULL,
        cell_ref              TEXT NOT NULL,
        format                TEXT NOT NULL,
        last_value            TEXT,
        last_source_commit_id TEXT,
        created_at            TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_links_doc ON links(doc_document_id);
      CREATE INDEX IF NOT EXISTS idx_links_source ON links(source_document_id);
      CREATE INDEX IF NOT EXISTS idx_commits_document ON commits(document_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_branches_document ON branches(document_id, position);
      CREATE INDEX IF NOT EXISTS idx_sends_commit ON sends(commit_id);
      PRAGMA user_version = 2;
    `);
  }

  close(): void {
    this.db.close();
  }

  // ── Documents ──────────────────────────────────────────────────────────

  /** Register a document for tracking (idempotent). Creates its Main branch. */
  addDocument(filePath: string): DocumentRow {
    const path = resolve(filePath);
    const existing = this.db.prepare('SELECT * FROM documents WHERE path = ?').get(path) as
      | RawDocument
      | undefined;
    if (existing) return rowToDocument(existing);

    const docId = sha256(path).slice(0, 16);
    const branchId = sha256(`${docId}:main:${nowIso()}`).slice(0, 16);
    const name = path.split('/').pop() ?? path;
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare('INSERT INTO documents (id, path, name, current_branch_id, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(docId, path, name, branchId, nowIso());
      this.db
        .prepare(
          'INSERT INTO branches (id, document_id, name, color, head_commit_id, archived, position, created_at) VALUES (?, ?, ?, ?, NULL, 0, 0, ?)',
        )
        .run(branchId, docId, 'Main', BRANCH_COLORS[0]!, nowIso());
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return this.getDocument(docId);
  }

  getDocument(id: string): DocumentRow {
    const row = this.db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as RawDocument | undefined;
    if (!row) throw new Error(`No document ${id}`);
    return rowToDocument(row);
  }

  getDocumentByPath(filePath: string): DocumentRow | undefined {
    const row = this.db.prepare('SELECT * FROM documents WHERE path = ?').get(resolve(filePath)) as
      | RawDocument
      | undefined;
    return row ? rowToDocument(row) : undefined;
  }

  listDocuments(): DocumentSummary[] {
    const rows = this.db
      .prepare(
        `SELECT d.*,
                (SELECT COUNT(*) FROM commits c WHERE c.document_id = d.id) AS version_count,
                (SELECT MAX(c.created_at) FROM commits c WHERE c.document_id = d.id) AS last_version_at,
                (SELECT COUNT(*) FROM branches b WHERE b.document_id = d.id AND b.archived = 0) AS branch_count
         FROM documents d ORDER BY d.created_at`,
      )
      .all() as unknown as (RawDocument & { version_count: number; last_version_at: string | null; branch_count: number })[];
    return rows.map((row) => ({
      ...rowToDocument(row),
      versionCount: Number(row.version_count),
      lastVersionAt: row.last_version_at,
      branchCount: Number(row.branch_count),
    }));
  }

  // ── Commits ────────────────────────────────────────────────────────────

  /**
   * Snapshot a document onto its current branch. Content identical to the
   * branch head is a no-op (`created: false`).
   *
   * With `coalesceWindowMs`, a burst of saves merges into one rolling
   * version: if the branch head has the same message, is younger than the
   * window, and nothing observable depends on it (no sends, no children, no
   * branch forked there), the head is *replaced* instead of extended — so a
   * Word work session yields one version, not one per ⌘S.
   */
  commit(
    filePath: string,
    fileBytes: Uint8Array,
    model: DocModel,
    opts: { message?: string; author?: string; coalesceWindowMs?: number } = {},
  ): CommitResult {
    const doc = this.addDocument(filePath);
    const branch = this.getBranch(doc.currentBranchId);
    const modelJson = canonicalJson(model);
    const modelHash = sha256(modelJson);

    const head = branch.headCommitId ? this.getCommit(branch.headCommitId) : undefined;
    if (head && head.modelHash === modelHash) {
      return { commit: head, created: false };
    }

    const fileHash = sha256(fileBytes);
    const payload = {
      modelHash,
      modelJson,
      fileHash,
      fileBytes,
      message: opts.message ?? null,
      author: opts.author ?? null,
    };

    if (
      head &&
      opts.coalesceWindowMs !== undefined &&
      this.canCoalesce(head, payload.message, opts.coalesceWindowMs)
    ) {
      return { commit: this.replaceCommit(head, payload), created: true };
    }

    return {
      commit: this.insertCommit(doc.id, branch.id, head?.id ?? null, payload),
      created: true,
    };
  }

  /** A head can be coalesced only when nothing observable depends on it. */
  private canCoalesce(head: CommitRow, message: string | null, windowMs: number): boolean {
    if (head.message !== message) return false;
    if (Date.now() - Date.parse(head.createdAt) > windowMs) return false;
    const sends = this.db.prepare('SELECT COUNT(*) AS n FROM sends WHERE commit_id = ?').get(head.id) as { n: number };
    if (Number(sends.n) > 0) return false;
    const children = this.db.prepare('SELECT COUNT(*) AS n FROM commits WHERE parent_id = ?').get(head.id) as { n: number };
    if (Number(children.n) > 0) return false;
    const forks = this.db
      .prepare('SELECT COUNT(*) AS n FROM branches WHERE head_commit_id = ? AND id != ?')
      .get(head.id, head.branchId) as { n: number };
    return Number(forks.n) === 0;
  }

  /** Swap the branch head for a fresh commit with the same parent — the coalesce primitive. */
  private replaceCommit(
    head: CommitRow,
    data: {
      modelHash: string;
      fileHash: string;
      modelJson: string;
      fileBytes: Uint8Array;
      message: string | null;
      author: string | null;
    },
  ): CommitRow {
    const createdAt = nowIso();
    const id = sha256(
      JSON.stringify([head.documentId, head.branchId, head.parentId, data.modelHash, data.fileHash, data.message, createdAt]),
    );
    this.db.exec('BEGIN');
    try {
      this.putObject(data.modelHash, Buffer.from(data.modelJson, 'utf8'));
      this.putObject(data.fileHash, Buffer.from(data.fileBytes));
      this.db
        .prepare(
          `INSERT INTO commits (id, document_id, branch_id, parent_id, model_hash, file_hash, message, author, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, head.documentId, head.branchId, head.parentId, data.modelHash, data.fileHash, data.message, data.author, createdAt);
      this.db.prepare('UPDATE branches SET head_commit_id = ? WHERE id = ?').run(id, head.branchId);
      this.db.prepare('DELETE FROM commits WHERE id = ?').run(head.id);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return this.getCommit(id);
  }

  /**
   * Re-commit the content of an old version onto the current branch
   * ("restore"). Object blobs are reused — only a new commit row is created.
   */
  restoreVersion(documentId: string, commitId: string, message?: string): CommitResult {
    const doc = this.getDocument(documentId);
    const source = this.getCommit(commitId);
    const branch = this.getBranch(doc.currentBranchId);
    const head = branch.headCommitId ? this.getCommit(branch.headCommitId) : undefined;
    if (head && head.modelHash === source.modelHash) {
      return { commit: head, created: false };
    }
    return {
      commit: this.insertCommit(doc.id, branch.id, head?.id ?? null, {
        modelHash: source.modelHash,
        fileHash: source.fileHash,
        message: message ?? `Restored version from ${source.createdAt.slice(0, 10)}`,
        author: null,
      }),
      created: true,
    };
  }

  private insertCommit(
    documentId: string,
    branchId: string,
    parentId: string | null,
    data: {
      modelHash: string;
      fileHash: string;
      modelJson?: string;
      fileBytes?: Uint8Array;
      message: string | null;
      author: string | null;
    },
  ): CommitRow {
    const createdAt = nowIso();
    const id = sha256(JSON.stringify([documentId, branchId, parentId, data.modelHash, data.fileHash, data.message, createdAt]));
    this.db.exec('BEGIN');
    try {
      if (data.modelJson !== undefined) this.putObject(data.modelHash, Buffer.from(data.modelJson, 'utf8'));
      if (data.fileBytes !== undefined) this.putObject(data.fileHash, Buffer.from(data.fileBytes));
      this.db
        .prepare(
          `INSERT INTO commits (id, document_id, branch_id, parent_id, model_hash, file_hash, message, author, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, documentId, branchId, parentId, data.modelHash, data.fileHash, data.message, data.author, createdAt);
      this.db.prepare('UPDATE branches SET head_commit_id = ? WHERE id = ?').run(id, branchId);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return this.getCommit(id);
  }

  /** Commit history for a document across all branches, newest first. */
  log(filePath: string): CommitRow[] {
    const doc = this.getDocumentByPath(filePath);
    if (!doc) return [];
    return (
      this.db
        .prepare('SELECT * FROM commits WHERE document_id = ? ORDER BY created_at DESC, rowid DESC')
        .all(doc.id) as unknown as RawCommit[]
    ).map(rowToCommit);
  }

  /** Resolve a (possibly abbreviated) commit id. Throws if ambiguous or unknown. */
  resolve(ref: string): CommitRow {
    const rows = this.db.prepare('SELECT * FROM commits WHERE id LIKE ? LIMIT 2').all(`${ref}%`) as unknown as RawCommit[];
    if (rows.length === 0) throw new Error(`No commit matches "${ref}"`);
    if (rows.length > 1) throw new Error(`Commit ref "${ref}" is ambiguous`);
    return rowToCommit(rows[0]!);
  }

  getCommit(id: string): CommitRow {
    const row = this.db.prepare('SELECT * FROM commits WHERE id = ?').get(id) as RawCommit | undefined;
    if (!row) throw new Error(`No commit ${id}`);
    return rowToCommit(row);
  }

  /** Rename a version. A renamed auto-save stops matching 'Saved', which also pins it against coalescing. */
  setCommitMessage(commitId: string, message: string): CommitRow {
    this.getCommit(commitId); // validate
    this.db.prepare('UPDATE commits SET message = ? WHERE id = ?').run(message, commitId);
    return this.getCommit(commitId);
  }

  getModel(commit: CommitRow): DocModel {
    return JSON.parse(Buffer.from(this.getObject(commit.modelHash)).toString('utf8')) as DocModel;
  }

  getFileBytes(commit: CommitRow): Uint8Array {
    return this.getObject(commit.fileHash);
  }

  /**
   * How far a commit's own branch has advanced past it: the number of commits
   * between the branch head and this commit. 0 means it is the head; null
   * means the commit is no longer reachable from its branch head.
   */
  divergence(commitId: string): number | null {
    const commit = this.getCommit(commitId);
    const branch = this.getBranch(commit.branchId);
    let cursor = branch.headCommitId;
    let count = 0;
    while (cursor) {
      if (cursor === commitId) return count;
      const row = this.db.prepare('SELECT parent_id FROM commits WHERE id = ?').get(cursor) as
        | { parent_id: string | null }
        | undefined;
      if (!row) return null;
      cursor = row.parent_id;
      count++;
    }
    return null;
  }

  // ── Branches ───────────────────────────────────────────────────────────

  getBranch(id: string): BranchRow {
    const row = this.db.prepare('SELECT * FROM branches WHERE id = ?').get(id) as RawBranch | undefined;
    if (!row) throw new Error(`No branch ${id}`);
    return rowToBranch(row);
  }

  listBranches(documentId: string): BranchRow[] {
    return (
      this.db.prepare('SELECT * FROM branches WHERE document_id = ? ORDER BY position').all(documentId) as unknown as RawBranch[]
    ).map(rowToBranch);
  }

  /** Branch off any commit; the new branch becomes the document's current branch. */
  createBranch(documentId: string, name: string, fromCommitId: string, color?: string): BranchRow {
    const doc = this.getDocument(documentId);
    const from = this.getCommit(fromCommitId);
    if (from.documentId !== doc.id) throw new Error('Cannot branch from another document');
    const siblings = this.listBranches(documentId);
    const position = siblings.length === 0 ? 0 : Math.max(...siblings.map((b) => b.position)) + 1;
    const id = sha256(`${documentId}:${name}:${nowIso()}`).slice(0, 16);
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          'INSERT INTO branches (id, document_id, name, color, head_commit_id, archived, position, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)',
        )
        .run(id, documentId, name, color ?? BRANCH_COLORS[position % BRANCH_COLORS.length]!, fromCommitId, position, nowIso());
      this.db.prepare('UPDATE documents SET current_branch_id = ? WHERE id = ?').run(id, documentId);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return this.getBranch(id);
  }

  /** Make a branch current. The caller is responsible for syncing the file on disk to the branch head. */
  switchBranch(documentId: string, branchId: string): BranchRow {
    const branch = this.getBranch(branchId);
    if (branch.documentId !== documentId) throw new Error('Branch belongs to another document');
    this.db.prepare('UPDATE documents SET current_branch_id = ? WHERE id = ?').run(branchId, documentId);
    return branch;
  }

  renameBranch(branchId: string, name: string): BranchRow {
    this.db.prepare('UPDATE branches SET name = ? WHERE id = ?').run(name, branchId);
    return this.getBranch(branchId);
  }

  setBranchColor(branchId: string, color: string): BranchRow {
    this.db.prepare('UPDATE branches SET color = ? WHERE id = ?').run(color, branchId);
    return this.getBranch(branchId);
  }

  setBranchArchived(branchId: string, archived: boolean): BranchRow {
    const branch = this.getBranch(branchId);
    const doc = this.getDocument(branch.documentId);
    if (archived && doc.currentBranchId === branchId) {
      throw new Error('Cannot archive the current branch');
    }
    this.db.prepare('UPDATE branches SET archived = ? WHERE id = ?').run(archived ? 1 : 0, branchId);
    return this.getBranch(branchId);
  }

  // ── Sends ──────────────────────────────────────────────────────────────

  markSent(
    commitId: string,
    info: { recipient: string; channel?: string; note?: string; sentAt?: string },
  ): SendRow {
    this.getCommit(commitId); // validate
    const result = this.db
      .prepare('INSERT INTO sends (commit_id, recipient, channel, note, sent_at) VALUES (?, ?, ?, ?, ?)')
      .run(commitId, info.recipient, info.channel ?? null, info.note ?? null, info.sentAt ?? nowIso());
    const row = this.db.prepare('SELECT * FROM sends WHERE id = ?').get(Number(result.lastInsertRowid)) as unknown as RawSend;
    return rowToSend(row);
  }

  sendsForDocument(documentId: string): SendRow[] {
    return (
      this.db
        .prepare(
          'SELECT s.* FROM sends s JOIN commits c ON c.id = s.commit_id WHERE c.document_id = ? ORDER BY s.sent_at',
        )
        .all(documentId) as unknown as RawSend[]
    ).map(rowToSend);
  }

  // ── Links ──────────────────────────────────────────────────────────────

  /** `link.id` must match the tag written into the document — it is the join key for refreshes. */
  createLink(link: Omit<LinkRow, 'createdAt'>): LinkRow {
    const { id } = link;
    this.db
      .prepare(
        `INSERT INTO links (id, doc_document_id, source_document_id, sheet, cell_ref, format, last_value, last_source_commit_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, link.docDocumentId, link.sourceDocumentId, link.sheet, link.cellRef, link.format, link.lastValue, link.lastSourceCommitId, nowIso());
    return this.getLink(id);
  }

  getLink(id: string): LinkRow {
    const row = this.db.prepare('SELECT * FROM links WHERE id = ?').get(id) as unknown as RawLink | undefined;
    if (!row) throw new Error(`No link ${id}`);
    return rowToLink(row);
  }

  linksForDocument(docDocumentId: string): LinkRow[] {
    return (
      this.db.prepare('SELECT * FROM links WHERE doc_document_id = ? ORDER BY created_at').all(docDocumentId) as unknown as RawLink[]
    ).map(rowToLink);
  }

  linksFromSource(sourceDocumentId: string): LinkRow[] {
    return (
      this.db.prepare('SELECT * FROM links WHERE source_document_id = ? ORDER BY created_at').all(sourceDocumentId) as unknown as RawLink[]
    ).map(rowToLink);
  }

  updateLinkValue(id: string, value: string, sourceCommitId: string): LinkRow {
    this.db.prepare('UPDATE links SET last_value = ?, last_source_commit_id = ? WHERE id = ?').run(value, sourceCommitId, id);
    return this.getLink(id);
  }

  deleteLink(id: string): void {
    this.db.prepare('DELETE FROM links WHERE id = ?').run(id);
  }

  // ── Graph ──────────────────────────────────────────────────────────────

  /** Everything the tree view needs in one call. */
  graph(documentId: string): DocumentGraph {
    const document = this.getDocument(documentId);
    return {
      document,
      branches: this.listBranches(documentId),
      commits: (
        this.db
          .prepare('SELECT * FROM commits WHERE document_id = ? ORDER BY created_at, rowid')
          .all(documentId) as unknown as RawCommit[]
      ).map(rowToCommit),
      sends: this.sendsForDocument(documentId),
    };
  }

  // ── Objects ────────────────────────────────────────────────────────────

  private getObject(hash: string): Uint8Array {
    const row = this.db.prepare('SELECT data FROM objects WHERE hash = ?').get(hash) as
      | { data: Uint8Array }
      | undefined;
    if (!row) throw new Error(`Missing object ${hash}`);
    return row.data;
  }

  private putObject(hash: string, data: Buffer): void {
    this.db.prepare('INSERT OR IGNORE INTO objects (hash, data) VALUES (?, ?)').run(hash, data);
  }
}

// ── Row mapping ──────────────────────────────────────────────────────────

interface RawDocument {
  id: string;
  path: string;
  name: string;
  current_branch_id: string;
  created_at: string;
}

interface RawBranch {
  id: string;
  document_id: string;
  name: string;
  color: string;
  head_commit_id: string | null;
  archived: number;
  position: number;
  created_at: string;
}

interface RawCommit {
  id: string;
  document_id: string;
  branch_id: string;
  parent_id: string | null;
  model_hash: string;
  file_hash: string;
  message: string | null;
  author: string | null;
  created_at: string;
}

interface RawSend {
  id: number;
  commit_id: string;
  recipient: string;
  channel: string | null;
  note: string | null;
  sent_at: string;
}

interface RawLink {
  id: string;
  doc_document_id: string;
  source_document_id: string;
  sheet: string;
  cell_ref: string;
  format: string;
  last_value: string | null;
  last_source_commit_id: string | null;
  created_at: string;
}

function rowToLink(row: RawLink): LinkRow {
  return {
    id: row.id,
    docDocumentId: row.doc_document_id,
    sourceDocumentId: row.source_document_id,
    sheet: row.sheet,
    cellRef: row.cell_ref,
    format: row.format,
    lastValue: row.last_value,
    lastSourceCommitId: row.last_source_commit_id,
    createdAt: row.created_at,
  };
}

function rowToDocument(row: RawDocument): DocumentRow {
  return {
    id: row.id,
    path: row.path,
    name: row.name,
    currentBranchId: row.current_branch_id,
    createdAt: row.created_at,
  };
}

function rowToBranch(row: RawBranch): BranchRow {
  return {
    id: row.id,
    documentId: row.document_id,
    name: row.name,
    color: row.color,
    headCommitId: row.head_commit_id,
    archived: row.archived !== 0,
    position: Number(row.position),
    createdAt: row.created_at,
  };
}

function rowToCommit(row: RawCommit): CommitRow {
  return {
    id: row.id,
    documentId: row.document_id,
    branchId: row.branch_id,
    parentId: row.parent_id,
    modelHash: row.model_hash,
    fileHash: row.file_hash,
    message: row.message,
    author: row.author,
    createdAt: row.created_at,
  };
}

function rowToSend(row: RawSend): SendRow {
  return {
    id: Number(row.id),
    commitId: row.commit_id,
    recipient: row.recipient,
    channel: row.channel,
    note: row.note,
    sentAt: row.sent_at,
  };
}
