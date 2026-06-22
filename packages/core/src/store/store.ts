import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { unzipSync, zipSync } from 'fflate';
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
  /** Marked as shared with other people (drives author attribution UI). */
  shared: boolean;
  /** The display name to attribute this user's own edits to, when the file has no embedded editor. */
  myName: string | null;
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
  /** The commit this branch forked from (null for trunk / pre-v3 branches). */
  forkedFromCommitId: string | null;
  /** Upstream commit this branch last declared itself caught up with. */
  syncedUpstreamCommitId: string | null;
  /** Optional human reason this branch exists (e.g. "Translation"). */
  reason: string | null;
}

/** How far a branch trails the branch it forked from. */
export interface UpstreamStatus {
  upstreamBranchId: string;
  upstreamBranchName: string;
  /** Commits on the upstream branch since the fork (or last catch-up). */
  behind: number;
  /** Base for "what changed upstream" diffs. */
  baseCommitId: string;
  upstreamHeadCommitId: string;
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

/**
 * Split an OOXML file (a zip: .docx/.xlsx/.pptx) into its internal parts, in
 * archive order, each as its raw decompressed bytes. Returns null for anything
 * that is not a zip (a .grist SQLite snapshot, a plain binary), so the caller
 * falls back to storing the whole file. Storing parts decompressed makes dedup
 * robust to re-compression differences.
 */
function decomposeOoxml(bytes: Uint8Array): { path: string; bytes: Uint8Array }[] | null {
  // Local file header magic "PK\x03\x04" (or the empty-archive "PK\x05\x06").
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return null;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    return null; // looked like a zip but wasn't a valid one
  }
  return Object.keys(entries).map((path) => ({ path, bytes: entries[path]! }));
}

/** Remote documents are keyed by opaque URLs, never resolved against the fs. */
export function isRemoteKey(path: string): boolean {
  return /^[a-z][a-z0-9+]*:\/\//i.test(path);
}

export interface RemoteRow {
  documentId: string;
  kind: string;
  baseUrl: string;
  remoteDocId: string;
  apiKey: string | null;
}

interface RawRemote {
  document_id: string;
  kind: string;
  base_url: string;
  remote_doc_id: string;
  api_key: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

export class SnapshotStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(resolve(dbPath)), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    // Write-ahead log: readers never block the single writer.
    this.db.exec('PRAGMA journal_mode = WAL');
    // If another process/connection holds the write lock, wait up to 5s for it
    // instead of failing immediately with SQLITE_BUSY ("database is locked").
    this.db.exec('PRAGMA busy_timeout = 5000');
    // NORMAL is the recommended durability level under WAL: crash-safe, and a
    // power-loss only risks the most recent transaction — meaningfully faster
    // than the FULL default because each commit no longer fsyncs.
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.migrate();
    this.backfillBranchStarts();
  }

  /**
   * One-time fix for branches created before branches got their own starting
   * commit: any branch whose head still belongs to another branch (no commit
   * of its own) gets a starting commit forked from that head. Makes such
   * branches visible as their own line and stops their label from being drawn
   * on top of the parent's node. Idempotent — branches with their own commits
   * are skipped.
   */
  private backfillBranchStarts(): void {
    const branches = this.db
      .prepare('SELECT id, document_id, name, head_commit_id FROM branches WHERE head_commit_id IS NOT NULL')
      .all() as unknown as { id: string; document_id: string; name: string; head_commit_id: string }[];
    for (const b of branches) {
      const own = this.db.prepare('SELECT COUNT(*) AS n FROM commits WHERE branch_id = ?').get(b.id) as { n: number };
      if (Number(own.n) > 0) continue;
      const from = this.getCommit(b.head_commit_id);
      this.insertCommit(b.document_id, b.id, from.id, {
        modelHash: from.modelHash,
        fileHash: from.fileHash,
        // Name-free: the branch's name lives only on the branch itself, so
        // renaming the branch never leaves a stale name on this commit.
        message: 'Branch created',
        author: null,
        createdAt: from.createdAt, // sit right next to the fork point, not "now"
      });
    }
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
        -- No FK to objects(hash): OOXML files resolve via the file_parts
        -- manifest, so file_hash is a content key, not always an object hash.
        file_hash   TEXT NOT NULL,
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
      CREATE TABLE IF NOT EXISTS file_parts (
        manifest_hash TEXT NOT NULL,      -- == commits.file_hash (sha256 of the original file)
        part_path     TEXT NOT NULL,      -- zip entry name, e.g. "word/media/image1.png"
        part_hash     TEXT NOT NULL REFERENCES objects(hash),  -- sha256 of the part's decompressed bytes
        ordinal       INTEGER NOT NULL,   -- original entry order, for a stable re-zip
        PRIMARY KEY (manifest_hash, part_path)
      );
      CREATE INDEX IF NOT EXISTS idx_file_parts_manifest ON file_parts(manifest_hash);
    `);
    // Columns added after v2 shipped — idempotent ALTERs for existing stores.
    this.ensureColumn('branches', 'forked_from_commit_id TEXT');
    this.ensureColumn('branches', 'synced_upstream_commit_id TEXT');
    this.ensureColumn('documents', 'shared INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('documents', 'my_name TEXT');
    this.ensureColumn('branches', 'reason TEXT');
    // Existing DBs baked a commits.file_hash → objects(hash) FK that the part
    // store breaks (OOXML file_hash now keys a manifest, not a whole-file blob).
    // Rebuild the table to drop just that FK — only when it's actually present,
    // so new DBs (already correct) are untouched.
    if (this.commitsHasFileHashFk()) this.rebuildCommitsWithoutFileHashFk();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS remotes (
        document_id   TEXT PRIMARY KEY REFERENCES documents(id),
        kind          TEXT NOT NULL,
        base_url      TEXT NOT NULL,
        remote_doc_id TEXT NOT NULL,
        api_key       TEXT
      );
      PRAGMA user_version = 5;
      CREATE INDEX IF NOT EXISTS idx_commits_document ON commits(document_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_branches_document ON branches(document_id, position);
      CREATE INDEX IF NOT EXISTS idx_sends_commit ON sends(commit_id);
    `);
    // One-time cleanup: earlier branch-start commits baked the branch name into
    // their message ('Started "X"'), which went stale on rename. Make them
    // name-free so a branch's name lives only on the branch.
    this.db.exec(`UPDATE commits SET message = 'Branch created' WHERE message LIKE 'Started %'`);
  }

  private ensureColumn(table: string, ddl: string): void {
    try {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    } catch {
      // column already exists
    }
  }

  private commitsHasFileHashFk(): boolean {
    const fks = this.db.prepare('PRAGMA foreign_key_list(commits)').all() as unknown as {
      table: string;
      from: string;
    }[];
    return fks.some((fk) => fk.from === 'file_hash' && fk.table === 'objects');
  }

  /** Rebuild commits to drop only the file_hash→objects FK (keep all others). */
  private rebuildCommitsWithoutFileHashFk(): void {
    this.db.exec('PRAGMA foreign_keys = OFF');
    this.db.exec('BEGIN');
    try {
      this.db.exec(`
        CREATE TABLE commits_new (
          id          TEXT PRIMARY KEY,
          document_id TEXT NOT NULL REFERENCES documents(id),
          branch_id   TEXT NOT NULL REFERENCES branches(id),
          parent_id   TEXT REFERENCES commits(id),
          model_hash  TEXT NOT NULL REFERENCES objects(hash),
          file_hash   TEXT NOT NULL,
          message     TEXT,
          author      TEXT,
          created_at  TEXT NOT NULL
        );
        INSERT INTO commits_new (id, document_id, branch_id, parent_id, model_hash, file_hash, message, author, created_at)
          SELECT id, document_id, branch_id, parent_id, model_hash, file_hash, message, author, created_at FROM commits;
        DROP TABLE commits;
        ALTER TABLE commits_new RENAME TO commits;
      `);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    this.db.exec('PRAGMA foreign_keys = ON');
  }

  private inTransaction = false;

  /**
   * Run `fn` inside a single SQLite transaction (atomic: all writes land or
   * none do). Re-entrant: if a `tx()` is already open on this connection, the
   * inner call simply joins it rather than issuing a second `BEGIN` (SQLite has
   * no nested transactions), so composing transactional methods is safe.
   */
  private tx<T>(fn: () => T): T {
    if (this.inTransaction) return fn();
    this.db.exec('BEGIN');
    this.inTransaction = true;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    } finally {
      this.inTransaction = false;
    }
  }

  /** Total bytes held in the object store (powers a "storage used" figure). */
  storageBytes(): number {
    const row = this.db.prepare('SELECT COALESCE(SUM(LENGTH(data)), 0) AS n FROM objects').get() as { n: number };
    return Number(row.n);
  }

  /** Flush the WAL into the main database file (so a file copy is a complete backup). */
  checkpoint(): void {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  close(): void {
    this.db.close();
  }

  // ── Documents ──────────────────────────────────────────────────────────

  /**
   * Register a document for tracking (idempotent). Creates its Main branch.
   * Keys are absolute file paths, or opaque URLs for remote documents
   * (e.g. grist://host/docId).
   */
  addDocument(filePath: string, displayName?: string): DocumentRow {
    const path = isRemoteKey(filePath) ? filePath : resolve(filePath);
    const existing = this.db.prepare('SELECT * FROM documents WHERE path = ?').get(path) as
      | RawDocument
      | undefined;
    if (existing) return rowToDocument(existing);

    const docId = sha256(path).slice(0, 16);
    const branchId = sha256(`${docId}:main:${nowIso()}`).slice(0, 16);
    const name = displayName ?? path.split('/').pop() ?? path;
    this.tx(() => {
      this.db
        .prepare('INSERT INTO documents (id, path, name, current_branch_id, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(docId, path, name, branchId, nowIso());
      this.db
        .prepare(
          'INSERT INTO branches (id, document_id, name, color, head_commit_id, archived, position, created_at) VALUES (?, ?, ?, ?, NULL, 0, 0, ?)',
        )
        .run(branchId, docId, 'Main', BRANCH_COLORS[0]!, nowIso());
    });
    return this.getDocument(docId);
  }

  getDocument(id: string): DocumentRow {
    const row = this.db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as RawDocument | undefined;
    if (!row) throw new Error(`No document ${id}`);
    return rowToDocument(row);
  }

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

  /** Permanently remove a document and all its DocGit history. The file on disk is untouched. */
  deleteDocument(documentId: string): void {
    this.tx(() => {
      this.db
        .prepare('DELETE FROM sends WHERE commit_id IN (SELECT id FROM commits WHERE document_id = ?)')
        .run(documentId);
      this.db.prepare('DELETE FROM links WHERE doc_document_id = ? OR source_document_id = ?').run(documentId, documentId);
      this.db.prepare('DELETE FROM commits WHERE document_id = ?').run(documentId);
      this.db.prepare('DELETE FROM branches WHERE document_id = ?').run(documentId);
      this.db.prepare('DELETE FROM remotes WHERE document_id = ?').run(documentId);
      this.db.prepare('DELETE FROM documents WHERE id = ?').run(documentId);
    });
  }

  getDocumentByPath(filePath: string): DocumentRow | undefined {
    const path = isRemoteKey(filePath) ? filePath : resolve(filePath);
    const row = this.db.prepare('SELECT * FROM documents WHERE path = ?').get(path) as RawDocument | undefined;
    return row ? rowToDocument(row) : undefined;
  }

  /** Record whether a document is shared and the name to attribute this user's own edits to. */
  setSharing(documentId: string, shared: boolean, myName: string | null): DocumentRow {
    this.db.prepare('UPDATE documents SET shared = ?, my_name = ? WHERE id = ?').run(shared ? 1 : 0, myName, documentId);
    return this.getDocument(documentId);
  }

  // ── Remote connections ─────────────────────────────────────────────────

  setRemote(documentId: string, remote: { kind: string; baseUrl: string; remoteDocId: string; apiKey?: string }): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO remotes (document_id, kind, base_url, remote_doc_id, api_key) VALUES (?, ?, ?, ?, ?)',
      )
      .run(documentId, remote.kind, remote.baseUrl, remote.remoteDocId, remote.apiKey ?? null);
  }

  getRemote(documentId: string): RemoteRow | undefined {
    const row = this.db.prepare('SELECT * FROM remotes WHERE document_id = ?').get(documentId) as
      | RawRemote
      | undefined;
    if (!row) return undefined;
    return {
      documentId: row.document_id,
      kind: row.kind,
      baseUrl: row.base_url,
      remoteDocId: row.remote_doc_id,
      apiKey: row.api_key,
    };
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
    // One transaction for the whole snapshot: registering a never-seen document
    // and writing its first commit are now atomic (the nested addDocument /
    // insertCommit / replaceCommit calls join this tx via the re-entrancy
    // guard), so a crash can never leave a document row with no commit.
    return this.tx(() => {
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
        // Prefer the editor embedded in the file; fall back to this user's own
        // display name on a shared document.
        author: opts.author ?? (doc.shared ? doc.myName : null),
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
    });
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
      .prepare(
        `SELECT COUNT(*) AS n FROM branches
         WHERE (head_commit_id = ? AND id != ?) OR forked_from_commit_id = ? OR synced_upstream_commit_id = ?`,
      )
      .get(head.id, head.branchId, head.id, head.id) as { n: number };
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
    this.tx(() => {
      this.putObject(data.modelHash, Buffer.from(data.modelJson, 'utf8'));
      this.storeFileBytes(data.fileHash, data.fileBytes);
      this.db
        .prepare(
          `INSERT INTO commits (id, document_id, branch_id, parent_id, model_hash, file_hash, message, author, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, head.documentId, head.branchId, head.parentId, data.modelHash, data.fileHash, data.message, data.author, createdAt);
      this.db.prepare('UPDATE branches SET head_commit_id = ? WHERE id = ?').run(id, head.branchId);
      this.db.prepare('DELETE FROM commits WHERE id = ?').run(head.id);
    });
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
      createdAt?: string;
    },
  ): CommitRow {
    const createdAt = data.createdAt ?? nowIso();
    const id = sha256(JSON.stringify([documentId, branchId, parentId, data.modelHash, data.fileHash, data.message, createdAt]));
    this.tx(() => {
      if (data.modelJson !== undefined) this.putObject(data.modelHash, Buffer.from(data.modelJson, 'utf8'));
      if (data.fileBytes !== undefined) this.storeFileBytes(data.fileHash, data.fileBytes);
      this.db
        .prepare(
          `INSERT INTO commits (id, document_id, branch_id, parent_id, model_hash, file_hash, message, author, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, documentId, branchId, parentId, data.modelHash, data.fileHash, data.message, data.author, createdAt);
      this.db.prepare('UPDATE branches SET head_commit_id = ? WHERE id = ?').run(id, branchId);
    });
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
    const parts = this.db
      .prepare('SELECT part_path, part_hash FROM file_parts WHERE manifest_hash = ? ORDER BY ordinal')
      .all(commit.fileHash) as unknown as { part_path: string; part_hash: string }[];
    if (parts.length === 0) {
      return this.getObject(commit.fileHash); // legacy whole-file blob (or non-OOXML)
    }
    // Reconstruct the OOXML container from its parts. Content-identical, not
    // byte-identical (fflate can't reproduce Office's exact bytes) — nothing in
    // DocGit depends on byte-identity, and live-links already ships re-zipped
    // files, so this is proven-safe.
    const files: Record<string, Uint8Array> = {};
    for (const part of parts) files[part.part_path] = this.getObject(part.part_hash);
    return zipSync(files);
  }

  /**
   * Persist a commit's file bytes. OOXML files are exploded into parts stored
   * once each (content-addressed) plus a manifest keyed by the file hash; the
   * whole-file blob is deliberately NOT stored — that is where the space goes.
   * Non-OOXML files fall back to a single whole-file blob (legacy path).
   */
  private storeFileBytes(fileHash: string, fileBytes: Uint8Array): void {
    const parts = decomposeOoxml(fileBytes);
    // No parts (non-OOXML, or a degenerate zip with zero entries) → store the
    // whole file as one blob. Storing nothing would leave getFileBytes with no
    // manifest AND no blob to fall back to — an unreadable version.
    if (!parts || parts.length === 0) {
      this.putObject(fileHash, Buffer.from(fileBytes));
      return;
    }
    parts.forEach((part, ordinal) => {
      const partHash = sha256(part.bytes);
      this.putObject(partHash, Buffer.from(part.bytes));
      this.db
        .prepare('INSERT OR IGNORE INTO file_parts (manifest_hash, part_path, part_hash, ordinal) VALUES (?, ?, ?, ?)')
        .run(fileHash, part.path, partHash, ordinal);
    });
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
  createBranch(documentId: string, name: string, fromCommitId: string, color?: string, reason?: string): BranchRow {
    const doc = this.getDocument(documentId);
    const from = this.getCommit(fromCommitId);
    if (from.documentId !== doc.id) throw new Error('Cannot branch from another document');
    const siblings = this.listBranches(documentId);
    const position = siblings.length === 0 ? 0 : Math.max(...siblings.map((b) => b.position)) + 1;
    const id = sha256(`${documentId}:${name}:${nowIso()}`).slice(0, 16);
    // Branch row + its starting commit land atomically: insertCommit joins this
    // transaction (the tx() re-entrancy guard) rather than opening its own, so a
    // failure can never leave a branch without its head commit.
    this.tx(() => {
      this.db
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
      this.db.prepare('UPDATE documents SET current_branch_id = ? WHERE id = ?').run(id, documentId);
      // Give the new branch its own starting commit (same content as the fork
      // point, reusing the existing object blobs) so it appears immediately as
      // its own line in the tree and has a head that belongs to it — not to the
      // parent branch. Without this a fresh branch is invisible and ambiguous.
      this.insertCommit(documentId, id, fromCommitId, {
        modelHash: from.modelHash,
        fileHash: from.fileHash,
        // Name-free (see backfillBranchStarts): the branch's name is the single
        // source of truth, so renaming never strands an old name on a commit.
        message: 'Branch created',
        author: null,
      });
    });
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

  setBranchReason(branchId: string, reason: string): BranchRow {
    this.db.prepare('UPDATE branches SET reason = ? WHERE id = ?').run(reason.trim() || null, branchId);
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

  /**
   * How far a branch trails its upstream (the branch it forked from), counted
   * from its last catch-up point. Null for the trunk, pre-v3 branches, or
   * when the base is no longer reachable from the upstream head.
   */
  upstreamStatus(branchId: string): UpstreamStatus | null {
    const branch = this.getBranch(branchId);
    if (!branch.forkedFromCommitId) return null;
    const fork = this.getCommit(branch.forkedFromCommitId);
    if (fork.branchId === branchId) return null; // forked from itself somehow — no upstream
    const upstream = this.getBranch(fork.branchId);
    if (!upstream.headCommitId) return null;

    const base = branch.syncedUpstreamCommitId ?? branch.forkedFromCommitId;
    let cursor: string | null = upstream.headCommitId;
    let behind = 0;
    while (cursor) {
      if (cursor === base) {
        return {
          upstreamBranchId: upstream.id,
          upstreamBranchName: upstream.name,
          behind,
          baseCommitId: base,
          upstreamHeadCommitId: upstream.headCommitId,
        };
      }
      const row = this.db.prepare('SELECT parent_id FROM commits WHERE id = ?').get(cursor) as
        | { parent_id: string | null }
        | undefined;
      cursor = row?.parent_id ?? null;
      behind++;
    }
    return null; // base unreachable — history diverged in a way we can't count
  }

  /** Declare a branch caught up with its upstream's current head. */
  markSyncedWithUpstream(branchId: string): BranchRow {
    const status = this.upstreamStatus(branchId);
    if (status) {
      this.db
        .prepare('UPDATE branches SET synced_upstream_commit_id = ? WHERE id = ?')
        .run(status.upstreamHeadCommitId, branchId);
    }
    return this.getBranch(branchId);
  }

  // ── Sends ──────────────────────────────────────────────────────────────

  /** Everyone anything was ever sent to, most recent first. */
  recipients(): { recipient: string; sendCount: number; lastSentAt: string }[] {
    const rows = this.db
      .prepare(
        'SELECT recipient, COUNT(*) AS n, MAX(sent_at) AS last FROM sends GROUP BY recipient ORDER BY last DESC',
      )
      .all() as unknown as { recipient: string; n: number; last: string }[];
    return rows.map((r) => ({ recipient: r.recipient, sendCount: Number(r.n), lastSentAt: r.last }));
  }

  /** Every version ever sent to one recipient, across all documents. */
  sendsToRecipient(recipient: string): (SendRow & { documentId: string; documentName: string; commitMessage: string | null })[] {
    const rows = this.db
      .prepare(
        `SELECT s.*, c.document_id, c.message AS commit_message, d.name AS document_name
         FROM sends s
         JOIN commits c ON c.id = s.commit_id
         JOIN documents d ON d.id = c.document_id
         WHERE s.recipient = ?
         ORDER BY s.sent_at DESC`,
      )
      .all(recipient) as unknown as (RawSend & { document_id: string; commit_message: string | null; document_name: string })[];
    return rows.map((row) => ({
      ...rowToSend(row),
      documentId: row.document_id,
      documentName: row.document_name,
      commitMessage: row.commit_message,
    }));
  }

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
  shared: number;
  my_name: string | null;
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
  forked_from_commit_id: string | null;
  synced_upstream_commit_id: string | null;
  reason: string | null;
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
    shared: row.shared !== 0,
    myName: row.my_name ?? null,
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
    forkedFromCommitId: row.forked_from_commit_id ?? null,
    syncedUpstreamCommitId: row.synced_upstream_commit_id ?? null,
    reason: row.reason ?? null,
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
