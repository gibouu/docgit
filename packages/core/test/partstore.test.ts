import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { strToU8, zipSync } from 'fflate';
import { SnapshotStore, parseDocx, parsePptx, parseXlsx } from '../src/index.js';
import { makeDocx } from './helpers/makeDocx.js';
import { makeXlsx } from './helpers/makeXlsx.js';
import { makePptx } from './helpers/makePptx.js';

/** A .docx with an embedded media part whose bytes are incompressible. */
function docxWithMedia(image: Uint8Array, text: string): Uint8Array {
  return zipSync({
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="png" ContentType="image/png"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
    '_rels/.rels': strToU8(
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ),
    'word/document.xml': strToU8(
      `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p></w:body></w:document>`,
    ),
    'word/media/image1.png': image,
  });
}

// Deterministic but genuinely high-entropy bytes (a chained SHA-256 stream) so
// the whole-file blob can't be compressed away — otherwise the legacy path
// would shrink it and hide the dedup win.
function incompressible(n: number): Uint8Array {
  const out = Buffer.alloc(n);
  let written = 0;
  let block = 0;
  while (written < n) {
    const chunk = createHash('sha256').update(`docgit-${block++}`).digest();
    chunk.copy(out, written);
    written += chunk.length;
  }
  return new Uint8Array(out.subarray(0, n));
}

describe('part-level object store (#25)', () => {
  let dir: string;
  let store: SnapshotStore;
  const docPath = '/Users/test/deck.docx';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'docgit-parts-'));
    store = new SnapshotStore(join(dir, 'docgit.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports total stored object bytes', () => {
    expect(store.storageBytes()).toBe(0);
    const bytes = makeDocx('<w:p><w:r><w:t>hi</w:t></w:r></w:p>');
    store.commit(docPath, bytes, parseDocx(bytes));
    expect(store.storageBytes()).toBeGreaterThan(0);
  });

  it('stores embedded media once across edits, not per version (the #25 win)', () => {
    const image = incompressible(200_000);
    const v1 = docxWithMedia(image, 'First draft of the proposal.');
    const v2 = docxWithMedia(image, 'Second draft — same picture, different words entirely.');

    store.commit(docPath, v1, parseDocx(v1));
    const afterV1 = store.storageBytes();
    store.commit(docPath, v2, parseDocx(v2));
    const growth = store.storageBytes() - afterV1;

    // Only the changed text part + model are new; the 200 KB image is reused.
    expect(growth).toBeLessThan(image.length / 4);
  });

  it('reconstructs a .docx content-identical (re-parses to the same model)', () => {
    const bytes = makeDocx('<w:p><w:r><w:t>hello world</w:t></w:r></w:p>');
    const model = parseDocx(bytes);
    const { commit } = store.commit(docPath, bytes, model);
    expect(parseDocx(store.getFileBytes(commit))).toEqual(model);
  });

  it('reconstructs a .xlsx content-identical', () => {
    const bytes = makeXlsx([{ name: 'Sheet1', cells: { A1: 'Revenue', B1: 1200 } }]);
    const model = parseXlsx(bytes);
    const { commit } = store.commit('/Users/test/book.xlsx', bytes, model);
    expect(parseXlsx(store.getFileBytes(commit))).toEqual(model);
  });

  it('reconstructs a .pptx content-identical', () => {
    const bytes = makePptx([{ shapes: [{ name: 'Title', text: 'Quarterly review' }] }]);
    const model = parsePptx(bytes);
    const { commit } = store.commit('/Users/test/slides.pptx', bytes, model);
    expect(parsePptx(store.getFileBytes(commit))).toEqual(model);
  });

  it('stores a non-OOXML file as a whole blob and round-trips byte-for-byte', () => {
    const bytes = new Uint8Array([0xff, 0x00, 0x01, 0x02, 0x03, 0x10, 0x20]); // not a zip
    const model = parseDocx(makeDocx('<w:p/>')); // any valid model; bytes drive the path
    const { commit } = store.commit('/Users/test/raw.bin', bytes, model);
    expect(Buffer.from(store.getFileBytes(commit))).toEqual(Buffer.from(bytes));
  });

  it('stores an OOXML file that decomposes to zero parts (empty zip) as a whole blob', () => {
    // A valid zip with no entries: decomposeOoxml returns [] (non-null but
    // empty). It must NOT vanish — store the whole file so it can be read back.
    const empty = zipSync({});
    const model = parseDocx(makeDocx('<w:p/>'));
    const { commit } = store.commit('/Users/test/empty.docx', empty, model);
    expect(Buffer.from(store.getFileBytes(commit))).toEqual(Buffer.from(empty));
  });

  it('migrates a legacy DB (drops the file_hash FK) and still reads old whole-file blobs', () => {
    // Hand-build a pre-#25 store: commits.file_hash carries the objects(hash) FK,
    // and an OOXML file is stored as ONE whole-file blob (the old representation).
    const dbPath = join(dir, 'legacy.db');
    const docx = makeDocx('<w:p><w:r><w:t>legacy contract</w:t></w:r></w:p>');
    const fileHash = createHash('sha256').update(docx).digest('hex');
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE documents (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, current_branch_id TEXT, created_at TEXT NOT NULL);
      CREATE TABLE branches (id TEXT PRIMARY KEY, document_id TEXT NOT NULL, name TEXT NOT NULL, color TEXT NOT NULL, head_commit_id TEXT, archived INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE objects (hash TEXT PRIMARY KEY, data BLOB NOT NULL);
      CREATE TABLE commits (id TEXT PRIMARY KEY, document_id TEXT NOT NULL, branch_id TEXT NOT NULL, parent_id TEXT, model_hash TEXT NOT NULL, file_hash TEXT NOT NULL REFERENCES objects(hash), message TEXT, author TEXT, created_at TEXT NOT NULL);
      PRAGMA user_version = 4;
    `);
    raw.prepare('INSERT INTO objects VALUES (?, ?)').run(fileHash, Buffer.from(docx));
    raw.prepare('INSERT INTO objects VALUES (?, ?)').run('model0', Buffer.from('{}'));
    raw.prepare('INSERT INTO documents VALUES (?, ?, ?, ?, ?)').run('doc0', '/legacy/c.docx', 'c.docx', 'br0', 't');
    raw
      .prepare('INSERT INTO branches (id, document_id, name, color, head_commit_id, archived, position, created_at) VALUES (?, ?, ?, ?, ?, 0, 0, ?)')
      .run('br0', 'doc0', 'Main', '#6366f1', 'c0', 't');
    raw
      .prepare('INSERT INTO commits (id, document_id, branch_id, parent_id, model_hash, file_hash, message, author, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('c0', 'doc0', 'br0', null, 'model0', fileHash, 'legacy', null, 't');
    raw.close();

    const migrated = new SnapshotStore(dbPath);
    try {
      // FK is gone, and the legacy whole-file blob still reconstructs.
      expect((migrated as unknown as { commitsHasFileHashFk(): boolean }).commitsHasFileHashFk()).toBe(false);
      expect(parseDocx(migrated.getFileBytes(migrated.getCommit('c0')))).toEqual(parseDocx(docx));
    } finally {
      migrated.close();
    }
  });
});
