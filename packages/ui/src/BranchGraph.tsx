import { useMemo } from 'react';
import type { BranchRow, CommitRow, SendRow } from '@docgit/core';

/**
 * The version tree: a git-graph-style visualization rendered as SVG lanes
 * (one per branch, colored) with labeled nodes. Reads like a timeline: the
 * first version at the top, newest at the bottom, branches forking downward
 * while Main continues as a straight vertical line. Selection is controlled
 * by the parent — up to two nodes for comparison.
 */

export interface BranchGraphProps {
  branches: BranchRow[];
  commits: CommitRow[];
  sends: SendRow[];
  currentBranchId: string;
  selectedIds: string[];
  onSelect: (commit: CommitRow, additive: boolean) => void;
  showArchived?: boolean;
}

const LANE_W = 26;
const ROW_H = 60;
const NODE_R = 6.5;
const PAD_TOP = 30;
const PAD_LEFT = 22;

interface Row {
  commit: CommitRow;
  lane: number;
  y: number;
  color: string;
  branch: BranchRow;
  /** Every branch whose tip is this commit — includes branches just forked here. */
  headOf: BranchRow[];
  sends: SendRow[];
}

export function BranchGraph(props: BranchGraphProps) {
  const { branches, commits, sends, currentBranchId, selectedIds, onSelect, showArchived = false } = props;

  const layout = useMemo(() => {
    const visibleBranches = branches.filter((b) => showArchived || !b.archived);
    const laneByBranch = new Map<string, number>();
    visibleBranches.forEach((b, i) => laneByBranch.set(b.id, i));
    const branchById = new Map(branches.map((b) => [b.id, b]));
    const sendsByCommit = new Map<string, SendRow[]>();
    for (const send of sends) {
      const list = sendsByCommit.get(send.commitId) ?? [];
      list.push(send);
      sendsByCommit.set(send.commitId, list);
    }

    const headsByCommit = new Map<string, BranchRow[]>();
    for (const branch of visibleBranches) {
      if (!branch.headCommitId) continue;
      const list = headsByCommit.get(branch.headCommitId) ?? [];
      list.push(branch);
      headsByCommit.set(branch.headCommitId, list);
    }

    // Oldest first: time flows top → bottom, like reading a timeline.
    const ordered = commits
      .filter((c) => laneByBranch.has(c.branchId))
      .slice()
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));

    const rows: Row[] = ordered.map((commit, i) => {
      const branch = branchById.get(commit.branchId)!;
      return {
        commit,
        lane: laneByBranch.get(commit.branchId)!,
        y: PAD_TOP + i * ROW_H,
        color: branch.color,
        branch,
        headOf: headsByCommit.get(commit.id) ?? [],
        sends: sendsByCommit.get(commit.id) ?? [],
      };
    });

    const rowById = new Map(rows.map((r) => [r.commit.id, r]));
    const laneCount = Math.max(1, visibleBranches.length);
    return { rows, rowById, laneCount };
  }, [branches, commits, sends, showArchived]);

  const { rows, rowById, laneCount } = layout;
  const graphW = PAD_LEFT + laneCount * LANE_W + 10;
  const height = PAD_TOP + rows.length * ROW_H + 10;
  const laneX = (lane: number) => PAD_LEFT + lane * LANE_W;

  if (rows.length === 0) {
    return <div className="dg-graph-empty">No versions yet — save the document to create the first one.</div>;
  }

  return (
    <div className="dg-graph" style={{ height }}>
      <svg className="dg-graph-svg" width={graphW} height={height} aria-hidden>
        {/* parent links first, under the nodes */}
        {rows.map((row) => {
          const parent = row.commit.parentId ? rowById.get(row.commit.parentId) : undefined;
          if (!parent) return null;
          const x1 = laneX(row.lane);
          const y1 = row.y;
          const x2 = laneX(parent.lane);
          const y2 = parent.y;
          const midY = (y1 + y2) / 2;
          const d =
            x1 === x2
              ? `M ${x1} ${y1} L ${x2} ${y2}`
              : `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;
          return <path key={row.commit.id} d={d} className="dg-graph-edge" style={{ stroke: row.color }} />;
        })}
        {rows.map((row) => {
          const selected = selectedIds.includes(row.commit.id);
          const isTip = row.headOf.length > 0;
          return (
            <g key={row.commit.id}>
              {selected && (
                <circle cx={laneX(row.lane)} cy={row.y} r={NODE_R + 5} className="dg-graph-halo" style={{ stroke: row.color }} />
              )}
              <circle
                cx={laneX(row.lane)}
                cy={row.y}
                r={NODE_R}
                className="dg-graph-node"
                style={{ fill: isTip ? row.color : 'var(--dg-paper, #faf7f2)', stroke: row.color }}
              />
            </g>
          );
        })}
      </svg>

      <div className="dg-graph-labels" style={{ left: graphW }}>
        {rows.map((row) => {
          const selected = selectedIds.includes(row.commit.id);
          return (
            <button
              key={row.commit.id}
              type="button"
              className={`dg-graph-row${selected ? ' is-selected' : ''}`}
              style={{ top: row.y - ROW_H / 2, height: ROW_H, ['--dg-row-accent' as string]: row.color }}
              onClick={(e) => onSelect(row.commit, e.metaKey || e.shiftKey)}
            >
              <span className="dg-graph-row-main">
                <span className="dg-graph-message">{row.commit.message ?? 'Saved version'}</span>
                {row.headOf.map((branch) => (
                  <span
                    key={branch.id}
                    className={`dg-branch-pill${branch.id === currentBranchId ? ' is-current' : ''}`}
                    style={{ ['--dg-pill' as string]: branch.color }}
                  >
                    {branch.name}
                    {branch.archived ? ' · archived' : ''}
                  </span>
                ))}
              </span>
              <span className="dg-graph-row-meta">
                <span className="dg-graph-time">{formatWhen(row.commit.createdAt)}</span>
                {row.commit.author && <span className="dg-graph-author">{row.commit.author}</span>}
                {row.sends.map((send) => (
                  <span key={send.id} className="dg-send-badge" title={`Sent to ${send.recipient}${send.channel ? ` via ${send.channel}` : ''} on ${formatWhen(send.sentAt)}`}>
                    ✉ {send.recipient}
                  </span>
                ))}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  const now = Date.now();
  const minutes = Math.round((now - date.getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} d ago`;
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
