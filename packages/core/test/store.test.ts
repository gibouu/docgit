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

  it('round-trips the normalized model and original bytes', () => {
    const bytes = docxFromParagraphs(['hello', 'world']);
    const model = parseDocx(bytes);
    const { commit } = store.commit(docPath, bytes, model);
    expect(store.getModel(commit)).toEqual(model);
    expect(Buffer.from(store.getFileBytes(commit))).toEqual(Buffer.from(bytes));
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
});
