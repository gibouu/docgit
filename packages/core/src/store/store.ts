import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { canonicalJson, type DocModel } from '../model/types.js';

/**
 * Content-addressed snapshot store, modeled on git's object database but
 * backed by a single SQLite file (local-first; an optional sync server can
 * replicate it later).
 *
 * - `objects` holds immutable blobs keyed by SHA-256: both the original file
 *   bytes and the normalized model JSON of every snapshot.
 * - `commits` form a parent chain per document (a tree once branching lands
 *   in Milestone 2 — the schema already permits multiple children).
 */

export interface CommitRow {
  id: string;
  documentId: string;
  parentId: string | null;
  modelHash: string;
  fileHash: string;
  message: string | null;
  author: string | null;
  createdAt: string;
}

export interface CommitResult {
  commit: CommitRow;
  /** false when the document content was identical to the current head (no-op). */
  created: boolean;
}

function sha256(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export class SnapshotStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(resolve(dbPath)), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id         TEXT PRIMARY KEY,
        path       TEXT NOT NULL UNIQUE,
        name       TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS objects (
        hash TEXT PRIMARY KEY,
        data BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS commits (
        id          TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES documents(id),
        parent_id   TEXT REFERENCES commits(id),
        model_hash  TEXT NOT NULL REFERENCES objects(hash),
        file_hash   TEXT NOT NULL REFERENCES objects(hash),
        message     TEXT,
        author      TEXT,
        created_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_commits_document ON commits(document_id, created_at);
    `);
  }

  close(): void {
    this.db.close();
  }

  /**
   * Snapshot a document. Stores file bytes and normalized model as
   * content-addressed objects and appends a commit to the document's chain.
   * If the normalized content is identical to the current head, this is a
   * no-op and the head commit is returned with `created: false`.
   */
  commit(
    filePath: string,
    fileBytes: Uint8Array,
    model: DocModel,
    opts: { message?: string; author?: string } = {},
  ): CommitResult {
    const docId = this.getOrCreateDocument(filePath);
    const head = this.head(docId);
    const modelJson = canonicalJson(model);
    const modelHash = sha256(modelJson);

    if (head && head.modelHash === modelHash) {
      return { commit: head, created: false };
    }

    const fileHash = sha256(fileBytes);
    const createdAt = new Date().toISOString();
    const id = sha256(
      JSON.stringify([docId, head?.id ?? null, modelHash, fileHash, opts.message ?? null, createdAt]),
    );

    const insert = this.db.transaction(() => {
      this.putObject(modelHash, Buffer.from(modelJson, 'utf8'));
      this.putObject(fileHash, Buffer.from(fileBytes));
      this.db
        .prepare(
          `INSERT INTO commits (id, document_id, parent_id, model_hash, file_hash, message, author, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, docId, head?.id ?? null, modelHash, fileHash, opts.message ?? null, opts.author ?? null, createdAt);
    });
    insert();

    return { commit: this.getCommit(id), created: true };
  }

  /** Commit history for a document, newest first. */
  log(filePath: string): CommitRow[] {
    const doc = this.db
      .prepare('SELECT id FROM documents WHERE path = ?')
      .get(resolve(filePath)) as { id: string } | undefined;
    if (!doc) return [];
    return (
      this.db
        .prepare('SELECT * FROM commits WHERE document_id = ? ORDER BY created_at DESC, rowid DESC')
        .all(doc.id) as RawCommit[]
    ).map(rowToCommit);
  }

  /** Resolve a (possibly abbreviated) commit id. Throws if ambiguous or unknown. */
  resolve(ref: string): CommitRow {
    const rows = this.db
      .prepare('SELECT * FROM commits WHERE id LIKE ? LIMIT 2')
      .all(`${ref}%`) as RawCommit[];
    if (rows.length === 0) throw new Error(`No commit matches "${ref}"`);
    if (rows.length > 1) throw new Error(`Commit ref "${ref}" is ambiguous`);
    return rowToCommit(rows[0]!);
  }

  getCommit(id: string): CommitRow {
    const row = this.db.prepare('SELECT * FROM commits WHERE id = ?').get(id) as RawCommit | undefined;
    if (!row) throw new Error(`No commit ${id}`);
    return rowToCommit(row);
  }

  getModel(commit: CommitRow): DocModel {
    const data = this.getObject(commit.modelHash);
    return JSON.parse(Buffer.from(data).toString('utf8')) as DocModel;
  }

  getFileBytes(commit: CommitRow): Uint8Array {
    return this.getObject(commit.fileHash);
  }

  private getObject(hash: string): Uint8Array {
    const row = this.db.prepare('SELECT data FROM objects WHERE hash = ?').get(hash) as
      | { data: Buffer }
      | undefined;
    if (!row) throw new Error(`Missing object ${hash}`);
    return row.data;
  }

  private putObject(hash: string, data: Buffer): void {
    this.db.prepare('INSERT OR IGNORE INTO objects (hash, data) VALUES (?, ?)').run(hash, data);
  }

  private getOrCreateDocument(filePath: string): string {
    const path = resolve(filePath);
    const existing = this.db.prepare('SELECT id FROM documents WHERE path = ?').get(path) as
      | { id: string }
      | undefined;
    if (existing) return existing.id;
    const id = sha256(path).slice(0, 16);
    const name = path.split('/').pop() ?? path;
    this.db
      .prepare('INSERT INTO documents (id, path, name, created_at) VALUES (?, ?, ?, ?)')
      .run(id, path, name, new Date().toISOString());
    return id;
  }

  private head(documentId: string): CommitRow | undefined {
    const row = this.db
      .prepare('SELECT * FROM commits WHERE document_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
      .get(documentId) as RawCommit | undefined;
    return row ? rowToCommit(row) : undefined;
  }
}

interface RawCommit {
  id: string;
  document_id: string;
  parent_id: string | null;
  model_hash: string;
  file_hash: string;
  message: string | null;
  author: string | null;
  created_at: string;
}

function rowToCommit(row: RawCommit): CommitRow {
  return {
    id: row.id,
    documentId: row.document_id,
    parentId: row.parent_id,
    modelHash: row.model_hash,
    fileHash: row.file_hash,
    message: row.message,
    author: row.author,
    createdAt: row.created_at,
  };
}
