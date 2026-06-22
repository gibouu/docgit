import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { BranchRow, CommitRow } from '@docgit/core';
import { BranchGraph } from '../src/index.js';

const commit = (id: string, branchId: string, parentId: string | null, message: string): CommitRow => ({
  id,
  documentId: 'd',
  branchId,
  parentId,
  modelHash: 'm',
  fileHash: 'f',
  message,
  author: null,
  createdAt: '2026-01-01T00:00:00Z',
});

const branch = (id: string, name: string, headCommitId: string, reason: string | null = null): BranchRow => ({
  id,
  documentId: 'd',
  name,
  color: '#6366f1',
  headCommitId,
  archived: false,
  position: 0,
  createdAt: '2026-01-01T00:00:00Z',
  forkedFromCommitId: null,
  syncedUpstreamCommitId: null,
  reason,
});

const renderGraph = (overrides: Partial<Parameters<typeof BranchGraph>[0]> = {}) =>
  render(
    <BranchGraph
      branches={[branch('main', 'Main', 'c1')]}
      commits={[commit('c1', 'main', null, 'First version')]}
      sends={[]}
      currentBranchId="main"
      selectedIds={[]}
      onSelect={() => {}}
      onSelectBranch={() => {}}
      {...overrides}
    />,
  );

describe('BranchGraph', () => {
  it('renders a version message and its branch pill', () => {
    renderGraph();
    expect(screen.getByText('First version')).toBeTruthy();
    expect(screen.getByText('Main')).toBeTruthy();
  });

  it('selects a branch when its pill is clicked', () => {
    const onSelectBranch = vi.fn();
    renderGraph({ onSelectBranch });
    fireEvent.click(screen.getByText('Main'));
    expect(onSelectBranch).toHaveBeenCalledWith('main');
  });

  it('activates a branch pill from the keyboard (#69)', () => {
    const onSelectBranch = vi.fn();
    renderGraph({ onSelectBranch });
    fireEvent.keyDown(screen.getByText('Main'), { key: 'Enter' });
    expect(onSelectBranch).toHaveBeenCalledWith('main');
  });

  it('surfaces a branch reason on the pill for AT (#113)', () => {
    renderGraph({ branches: [branch('main', 'Main', 'c1', 'Translation')] });
    expect(screen.getByLabelText(/Translation/)).toBeTruthy();
  });
});
