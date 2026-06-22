import { describe, expect, it } from 'vitest';
import { buildFolderTree } from '../src/index.js';

describe('buildFolderTree (#52)', () => {
  it('groups docs into a folder tree relative to the workspace root', () => {
    const tree = buildFolderTree(
      ['/work/contracts/acme.docx', '/work/contracts/2026/beta.docx', '/work/plan.xlsx'],
      '/work',
    );
    expect(tree.root.docPaths).toEqual(['/work/plan.xlsx']); // directly in root
    const contracts = tree.root.folders.find((f) => f.name === 'contracts')!;
    expect(contracts.path).toBe('/work/contracts');
    expect(contracts.docPaths).toEqual(['/work/contracts/acme.docx']);
    expect(contracts.folders.find((f) => f.name === '2026')!.docPaths).toEqual(['/work/contracts/2026/beta.docx']);
  });

  it('buckets out-of-root docs into otherLocations', () => {
    const tree = buildFolderTree(['/work/a.docx', '/elsewhere/b.docx'], '/work');
    expect(tree.root.docPaths).toEqual(['/work/a.docx']);
    expect(tree.otherLocations).toEqual(['/elsewhere/b.docx']);
  });

  it('does not treat a sibling prefix as inside the root', () => {
    // "/work-archive" must not count as under "/work".
    const tree = buildFolderTree(['/work-archive/c.docx'], '/work');
    expect(tree.root.docPaths).toEqual([]);
    expect(tree.otherLocations).toEqual(['/work-archive/c.docx']);
  });

  it('handles a trailing slash on the root and sorts deterministically', () => {
    const tree = buildFolderTree(['/work/b.docx', '/work/a.docx'], '/work/');
    expect(tree.root.docPaths).toEqual(['/work/a.docx', '/work/b.docx']);
  });

  it('shows explicitly-created folders even when empty (#52)', () => {
    const tree = buildFolderTree(['/work/a.docx'], '/work', ['/work/empty-folder', '/work/contracts/2027']);
    const names = tree.root.folders.map((f) => f.name).sort();
    expect(names).toEqual(['contracts', 'empty-folder']);
    expect(tree.root.folders.find((f) => f.name === 'empty-folder')!.docPaths).toEqual([]);
    expect(tree.root.folders.find((f) => f.name === 'contracts')!.folders.find((f) => f.name === '2027')).toBeTruthy();
  });

  it('with no root, everything is other locations', () => {
    const tree = buildFolderTree(['/x/a.docx', '/y/b.docx'], '');
    expect(tree.root.folders).toEqual([]);
    expect(tree.otherLocations).toEqual(['/x/a.docx', '/y/b.docx']);
  });
});
