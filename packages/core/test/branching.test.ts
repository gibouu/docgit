import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseDocx, SnapshotStore } from '../src/index.js';
import { docxFromParagraphs } from './helpers/makeDocx.js';

describe('SnapshotStore — branches, sends, restore', () => {
  let dir: string;
  let store: SnapshotStore;
  const docPath = '/Users/test/cv.docx';

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

  it('creates a Main branch on first contact and commits onto it', () => {
    const doc = store.addDocument(docPath);
    const branches = store.listBranches(doc.id);
    expect(branches).toHaveLength(1);
    expect(branches[0]).toMatchObject({ name: 'Main', archived: false, headCommitId: null });
    expect(doc.currentBranchId).toBe(branches[0]!.id);

    const { commit } = snapshot(['v1'], 'first');
    expect(commit.branchId).toBe(branches[0]!.id);
    expect(store.getBranch(branches[0]!.id).headCommitId).toBe(commit.id);
  });

  it('branches from any commit and continues committing on the new branch', () => {
    const base = snapshot(['CV base'], 'base').commit;
    snapshot(['CV base', 'extra main work'], 'main grows');

    const doc = store.getDocument(base.documentId);
    const branch = store.createBranch(doc.id, 'CV — Marketing roles', base.id);
    expect(branch.headCommitId).toBe(base.id);
    expect(store.getDocument(doc.id).currentBranchId).toBe(branch.id);

    const onBranch = snapshot(['CV base', 'marketing focus'], 'tailor for marketing').commit;
    expect(onBranch.branchId).toBe(branch.id);
    expect(onBranch.parentId).toBe(base.id);
    // Main is untouched.
    const main = store.listBranches(doc.id).find((b) => b.name === 'Main')!;
    expect(store.getCommit(main.headCommitId!).message).toBe('main grows');
  });

  it('switching branches changes where commits land', () => {
    const base = snapshot(['v1'], 'base').commit;
    const doc = store.getDocument(base.documentId);
    const variant = store.createBranch(doc.id, 'Client B', base.id);
    const main = store.listBranches(doc.id).find((b) => b.name === 'Main')!;

    store.switchBranch(doc.id, main.id);
    const backOnMain = snapshot(['v1', 'main v2'], 'on main').commit;
    expect(backOnMain.branchId).toBe(main.id);
    expect(store.getBranch(variant.id).headCommitId).toBe(base.id);
  });

  it('rename / recolor / archive branches; archiving the current branch is rejected', () => {
    const base = snapshot(['v1']).commit;
    const doc = store.getDocument(base.documentId);
    const branch = store.createBranch(doc.id, 'Draft', base.id);

    expect(store.renameBranch(branch.id, 'French version').name).toBe('French version');
    expect(store.setBranchColor(branch.id, '#ff0000').color).toBe('#ff0000');
    expect(() => store.setBranchArchived(branch.id, true)).toThrow(/current branch/);

    const main = store.listBranches(doc.id).find((b) => b.name === 'Main')!;
    store.switchBranch(doc.id, main.id);
    expect(store.setBranchArchived(branch.id, true).archived).toBe(true);
  });

  it('restore re-commits old content onto the current branch reusing objects', () => {
    const v1 = snapshot(['original wording'], 'v1').commit;
    snapshot(['heavily edited wording'], 'v2');

    const result = store.restoreVersion(v1.documentId, v1.id);
    expect(result.created).toBe(true);
    expect(result.commit.modelHash).toBe(v1.modelHash);
    expect(result.commit.fileHash).toBe(v1.fileHash);
    expect(result.commit.parentId).not.toBe(v1.parentId);
    expect(store.getModel(result.commit)).toEqual(store.getModel(v1));
  });

  it('divergence counts how far the branch head has moved past a commit', () => {
    const v1 = snapshot(['a'], 'v1').commit;
    snapshot(['a', 'b'], 'v2');
    const v3 = snapshot(['a', 'b', 'c'], 'v3').commit;
    expect(store.divergence(v1.id)).toBe(2);
    expect(store.divergence(v3.id)).toBe(0);
  });

  it('tags commits as sent and aggregates sends per document', () => {
    const v1 = snapshot(['CV v1'], 'v1').commit;
    const v2 = snapshot(['CV v2'], 'v2').commit;
    store.markSent(v1.id, { recipient: 'Acme Recruiting', channel: 'email', sentAt: '2026-03-03T10:00:00.000Z' });
    store.markSent(v2.id, { recipient: 'Beta Corp' });

    const sends = store.sendsForDocument(v1.documentId);
    expect(sends).toHaveLength(2);
    expect(sends[0]).toMatchObject({ commitId: v1.id, recipient: 'Acme Recruiting', channel: 'email' });
    expect(sends[1]).toMatchObject({ commitId: v2.id, recipient: 'Beta Corp' });
  });

  it('graph returns document, branches, commits and sends in one call', () => {
    const base = snapshot(['v1'], 'base').commit;
    const doc = store.getDocument(base.documentId);
    store.createBranch(doc.id, 'Variant', base.id);
    const onVariant = snapshot(['v1 variant'], 'variant work').commit;
    store.markSent(onVariant.id, { recipient: 'Client X' });

    const graph = store.graph(doc.id);
    expect(graph.branches.map((b) => b.name)).toEqual(['Main', 'Variant']);
    expect(graph.commits.map((c) => c.message)).toEqual(['base', 'variant work']);
    expect(graph.sends).toHaveLength(1);
    expect(graph.document.currentBranchId).toBe(graph.branches[1]!.id);
  });

  describe('auto-save coalescing', () => {
    const autoSave = (texts: string[], windowMs = 60_000) => {
      const bytes = docxFromParagraphs(texts);
      return store.commit(docPath, bytes, parseDocx(bytes), { message: 'Saved', coalesceWindowMs: windowMs });
    };

    it('merges a burst of saves into one rolling version with the latest content', () => {
      snapshot(['base'], 'Added to DocGit');
      autoSave(['base', 'edit 1']);
      autoSave(['base', 'edit 1', 'edit 2']);
      const result = autoSave(['base', 'final']);

      const log = store.log(docPath);
      expect(log).toHaveLength(2); // base + one coalesced "Saved"
      expect(log[0]!.id).toBe(result.commit.id);
      expect(log[0]!.message).toBe('Saved');
      expect(store.getModel(log[0]!).blocks.map((b) => 'text' in b && b.text)).toEqual(['base', 'final']);
      // chain stays intact: coalesced head still points at base
      expect(log[0]!.parentId).toBe(log[1]!.id);
    });

    it('does not coalesce across different messages (manual saves stay permanent)', () => {
      snapshot(['base'], 'Added to DocGit');
      autoSave(['base', 'work']);
      snapshot(['base', 'work', 'milestone'], 'Sent draft wording to client');
      autoSave(['base', 'work', 'milestone', 'more work']);
      expect(store.log(docPath).map((c) => c.message)).toEqual([
        'Saved',
        'Sent draft wording to client',
        'Saved',
        'Added to DocGit',
      ]);
    });

    it('never coalesces a version that was marked as sent', () => {
      snapshot(['base'], 'Added to DocGit');
      const sent = autoSave(['base', 'v-sent']);
      store.markSent(sent.commit.id, { recipient: 'Acme' });
      autoSave(['base', 'v-after-send']);
      const log = store.log(docPath);
      expect(log).toHaveLength(3);
      expect(log[1]!.id).toBe(sent.commit.id);
    });

    it('never coalesces a version another branch forked from', () => {
      snapshot(['base'], 'Added to DocGit');
      const fork = autoSave(['base', 'fork point']);
      const doc = store.getDocument(fork.commit.documentId);
      store.createBranch(doc.id, 'Variant', fork.commit.id);
      const main = store.listBranches(doc.id).find((b) => b.name === 'Main')!;
      store.switchBranch(doc.id, main.id);
      autoSave(['base', 'after fork']);
      expect(store.log(docPath)).toHaveLength(3);
      expect(store.getCommit(fork.commit.id)).toBeTruthy();
    });

    it('does not coalesce outside the time window', async () => {
      snapshot(['base'], 'Added to DocGit');
      autoSave(['base', 'old session'], 10);
      await new Promise((r) => setTimeout(r, 30));
      autoSave(['base', 'new session'], 10);
      expect(store.log(docPath)).toHaveLength(3);
    });
  });

  describe('translation/variant workflow — upstream status', () => {
    it('reports how far a branch trails the branch it forked from', () => {
      const fork = snapshot(['EN clause one'], 'EN base').commit;
      const doc = store.getDocument(fork.documentId);
      const fr = store.createBranch(doc.id, 'Contract (FR)', fork.id);
      expect(store.upstreamStatus(fr.id)).toMatchObject({ behind: 0, upstreamBranchName: 'Main' });

      // EN moves on while the FR translator works.
      const main = store.listBranches(doc.id).find((b) => b.name === 'Main')!;
      store.switchBranch(doc.id, main.id);
      snapshot(['EN clause one, amended'], 'EN amendment');
      snapshot(['EN clause one, amended', 'EN clause two'], 'EN new clause');

      const status = store.upstreamStatus(fr.id)!;
      expect(status).toMatchObject({ behind: 2, upstreamBranchName: 'Main' });
      expect(status.baseCommitId).toBe(fork.id);
      expect(store.getCommit(status.upstreamHeadCommitId).message).toBe('EN new clause');
    });

    it('marking a branch caught up resets the counter from the new base', () => {
      const fork = snapshot(['v1'], 'base').commit;
      const doc = store.getDocument(fork.documentId);
      const variant = store.createBranch(doc.id, 'Variant', fork.id);
      const main = store.listBranches(doc.id).find((b) => b.name === 'Main')!;
      store.switchBranch(doc.id, main.id);
      snapshot(['v1', 'upstream work'], 'upstream work');

      expect(store.upstreamStatus(variant.id)!.behind).toBe(1);
      store.markSyncedWithUpstream(variant.id);
      expect(store.upstreamStatus(variant.id)!.behind).toBe(0);

      snapshot(['v1', 'upstream work', 'more'], 'more upstream');
      expect(store.upstreamStatus(variant.id)!.behind).toBe(1);
    });

    it('the trunk has no upstream', () => {
      const c = snapshot(['v1']).commit;
      const doc = store.getDocument(c.documentId);
      const main = store.listBranches(doc.id)[0]!;
      expect(store.upstreamStatus(main.id)).toBeNull();
    });

    it('never coalesces away a commit a branch forked from or synced to', () => {
      snapshot(['base'], 'Added to DocGit');
      const bytes = docxFromParagraphs(['base', 'fork here']);
      const fork = store.commit(docPath, bytes, parseDocx(bytes), { message: 'Saved', coalesceWindowMs: 60_000 }).commit;
      const doc = store.getDocument(fork.documentId);
      store.createBranch(doc.id, 'FR', fork.id);
      const main = store.listBranches(doc.id).find((b) => b.name === 'Main')!;
      store.switchBranch(doc.id, main.id);
      // Same 'Saved' message within the window — would coalesce without the guard.
      const bytes2 = docxFromParagraphs(['base', 'fork here', 'after']);
      store.commit(docPath, bytes2, parseDocx(bytes2), { message: 'Saved', coalesceWindowMs: 60_000 });
      expect(store.getCommit(fork.id)).toBeTruthy();
      expect(store.upstreamStatus(store.listBranches(doc.id).find((b) => b.name === 'FR')!.id)!.behind).toBe(1);
    });
  });

  describe('per-recipient send history', () => {
    it('aggregates recipients and lists everything sent to one of them', () => {
      const v1 = snapshot(['CV v1'], 'v1').commit;
      const v2 = snapshot(['CV v2'], 'v2').commit;
      store.markSent(v1.id, { recipient: 'Acme', channel: 'email', sentAt: '2026-03-03T10:00:00.000Z' });
      store.markSent(v2.id, { recipient: 'Acme', channel: 'link', sentAt: '2026-05-01T10:00:00.000Z' });
      store.markSent(v2.id, { recipient: 'Beta Corp', sentAt: '2026-04-01T10:00:00.000Z' });

      const recipients = store.recipients();
      expect(recipients.map((r) => r.recipient)).toEqual(['Acme', 'Beta Corp']);
      expect(recipients[0]).toMatchObject({ sendCount: 2, lastSentAt: '2026-05-01T10:00:00.000Z' });

      const acme = store.sendsToRecipient('Acme');
      expect(acme).toHaveLength(2);
      expect(acme[0]).toMatchObject({ documentName: 'cv.docx', commitMessage: 'v2', channel: 'link' });
      expect(acme[1]).toMatchObject({ commitMessage: 'v1', channel: 'email' });
    });
  });

  it('renames a version, which also pins it against coalescing', () => {
    snapshot(['base'], 'Added to DocGit');
    const bytes1 = docxFromParagraphs(['base', 'work']);
    const auto = store.commit(docPath, bytes1, parseDocx(bytes1), { message: 'Saved', coalesceWindowMs: 60_000 });
    store.setCommitMessage(auto.commit.id, 'Fees v2 negotiated');

    const bytes2 = docxFromParagraphs(['base', 'work', 'more']);
    store.commit(docPath, bytes2, parseDocx(bytes2), { message: 'Saved', coalesceWindowMs: 60_000 });

    const log = store.log(docPath);
    expect(log.map((c) => c.message)).toEqual(['Saved', 'Fees v2 negotiated', 'Added to DocGit']);
  });

  it('listDocuments reports version and branch counts', () => {
    snapshot(['v1']);
    snapshot(['v2']);
    const docs = store.listDocuments();
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ name: 'cv.docx', versionCount: 2, branchCount: 1 });
    expect(docs[0]!.lastVersionAt).toBeTruthy();
  });
});
