import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseDocx, SnapshotStore } from '../src/index.js';
import { docxFromParagraphs } from './helpers/makeDocx.js';

describe('SnapshotStore', () => {
  let dir: string;
  let store: SnapshotStore;
  const docPath = '/Users/test/contract.docx';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'docgit-test-'));
    store = new SnapshotStore(join(dir, 'docgit.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const snapshot = (texts: string[], message?: string) => {
    const bytes = docxFromParagraphs(texts);
    return store.commit(docPath, bytes, parseDocx(bytes), { message });
  };

  it('creates commits chained by parent', () => {
    const first = snapshot(['v1'], 'initial');
    const second = snapshot(['v1', 'v2'], 'add v2');
    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(first.commit.parentId).toBeNull();
    expect(second.commit.parentId).toBe(first.commit.id);
  });

  it('is a no-op when content is unchanged', () => {
    const first = snapshot(['same'], 'initial');
    const again = snapshot(['same'], 'should not exist');
    expect(again.created).toBe(false);
    expect(again.commit.id).toBe(first.commit.id);
    expect(store.log(docPath)).toHaveLength(1);
  });

  it('round-trips the normalized model and reconstructs the file content-identical', () => {
    const bytes = docxFromParagraphs(['hello', 'world']);
    const model = parseDocx(bytes);
    const { commit } = store.commit(docPath, bytes, model);
    expect(store.getModel(commit)).toEqual(model);
    // OOXML is stored part-wise, so the reconstructed container is
    // content-identical (re-parses to the same model), not byte-identical.
    expect(parseDocx(store.getFileBytes(commit))).toEqual(model);
  });

  it('deduplicates identical objects across documents (content-addressed)', () => {
    const bytes = docxFromParagraphs(['shared content']);
    const model = parseDocx(bytes);
    const a = store.commit('/Users/test/a.docx', bytes, model);
    const b = store.commit('/Users/test/b.docx', bytes, model);
    expect(a.commit.modelHash).toBe(b.commit.modelHash);
    expect(a.commit.fileHash).toBe(b.commit.fileHash);
    expect(a.commit.id).not.toBe(b.commit.id);
  });

  it('lists history newest first and resolves abbreviated refs', () => {
    const first = snapshot(['v1'], 'one');
    const second = snapshot(['v2'], 'two');
    const log = store.log(docPath);
    expect(log.map((c) => c.message)).toEqual(['two', 'one']);
    expect(store.resolve(second.commit.id.slice(0, 8)).id).toBe(second.commit.id);
    expect(store.resolve(first.commit.id.slice(0, 8)).id).toBe(first.commit.id);
    expect(() => store.resolve('ffffffff')).toThrow(/No commit/);
  });

  it('renames a document path and display name without changing its id', () => {
    const doc = store.addDocument('/Users/test/old.docx');
    const updated = store.renameDocumentPath(doc.id, '/Users/test/new.docx', 'new.docx');
    expect(updated.id).toBe(doc.id); // id (and FK references) stay stable
    expect(updated.path).toBe('/Users/test/new.docx');
    expect(updated.name).toBe('new.docx');
    // Branches/commits still resolve against the same id.
    expect(store.listBranches(doc.id)).toHaveLength(1);
  });

  it('deletes a document and all its branches/commits', () => {
    const doc = store.addDocument('/Users/test/gone.docx');
    store.deleteDocument(doc.id);
    expect(() => store.getDocument(doc.id)).toThrow();
    expect(store.listDocuments().some((d) => d.id === doc.id)).toBe(false);
  });

  it('reclaims unreferenced object blobs when a document is deleted', () => {
    const bytes = docxFromParagraphs(['unique confidential content']);
    store.commit('/Users/test/secret.docx', bytes, parseDocx(bytes));
    expect(store.storageBytes()).toBeGreaterThan(0);
    store.deleteDocument(store.getDocumentByPath('/Users/test/secret.docx')!.id);
    // Nothing else references those blobs — the bytes are actually gone.
    expect(store.storageBytes()).toBe(0);
  });

  it('keeps blobs that another document still references on delete', () => {
    const bytes = docxFromParagraphs(['shared content']);
    store.commit('/Users/test/a.docx', bytes, parseDocx(bytes));
    store.commit('/Users/test/b.docx', bytes, parseDocx(bytes));
    const before = store.storageBytes();
    store.deleteDocument(store.getDocumentByPath('/Users/test/a.docx')!.id);
    expect(store.storageBytes()).toBe(before); // b still references the shared blobs
    const b = store.getDocumentByPath('/Users/test/b.docx')!;
    const head = store.getCommit(store.getBranch(b.currentBranchId).headCommitId!);
    expect(parseDocx(store.getFileBytes(head))).toEqual(parseDocx(bytes)); // b still reconstructs
  });
});

describe('SnapshotStore transactions', () => {
  let dir: string;
  let store: SnapshotStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'docgit-tx-'));
    store = new SnapshotStore(join(dir, 'docgit.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // tx() is private; reach it (and the raw connection) by name for a direct
  // unit test of the re-entrancy guard, the property the 5 call sites rely on.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const tx = (fn: () => void) => (store as any).tx(fn) as void;
  const setName = (id: string, name: string) =>
    (store as any).db.prepare('UPDATE documents SET name = ? WHERE id = ?').run(name, id);
  /* eslint-enable @typescript-eslint/no-explicit-any */

  it('re-entrant tx commits nested work with the outer transaction (no nested BEGIN)', () => {
    const doc = store.addDocument('/Users/test/tx.docx');
    expect(() =>
      tx(() => {
        setName(doc.id, 'outer');
        tx(() => setName(doc.id, 'inner')); // joins the outer tx, does not re-BEGIN
      }),
    ).not.toThrow();
    expect(store.getDocument(doc.id).name).toBe('inner');
  });

  it('rolls back the whole unit when nested work throws', () => {
    const doc = store.addDocument('/Users/test/tx.docx');
    const original = store.getDocument(doc.id).name;
    expect(() =>
      tx(() => {
        setName(doc.id, 'changed');
        tx(() => {
          throw new Error('boom');
        });
      }),
    ).toThrow('boom');
    expect(store.getDocument(doc.id).name).toBe(original); // outer write rolled back too
  });
});
