import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { topologicalCommitOrder } from '@docgit/core/graph';
import type { BranchRow, CommitRow, SendRow } from '@docgit/core';

/**
 * Horizontal version-tree viewer. Time flows left → right; Main is the
 * centre trunk and other branches fan out above and below it, each in its
 * own colour with its name written in-line near its latest version. The
 * canvas pans by dragging (and with the trackpad/wheel), so a document with
 * many branches stays navigable.
 */

export interface HorizontalBranchGraphProps {
  branches: BranchRow[];
  commits: CommitRow[];
  sends: SendRow[];
  currentBranchId: string;
  selectedIds: string[];
  onSelect: (commit: CommitRow, additive: boolean) => void;
  onSelectBranch?: (branchId: string) => void;
  showArchived?: boolean;
}

const COL_W = 76;
const LANE_H = 60;
const NODE_R = 7;
const PAD_X = 56;
const PAD_TOP = 44;
const PAD_BOTTOM = 28;

interface Node {
  commit: CommitRow;
  x: number;
  y: number;
  color: string;
  branch: BranchRow;
  isTip: boolean;
  sends: SendRow[];
}

interface Label {
  branchId: string;
  name: string;
  color: string;
  x: number;
  y: number;
  isCurrent: boolean;
  above: boolean;
  reason: string | null;
}

export function HorizontalBranchGraph(props: HorizontalBranchGraphProps) {
  const { branches, commits, sends, currentBranchId, selectedIds, onSelect, onSelectBranch, showArchived = false } =
    props;
  const scrollRef = useRef<HTMLDivElement>(null);

  const layout = useMemo(() => {
    const visible = branches.filter((b) => showArchived || !b.archived);
    const byId = new Map(visible.map((b) => [b.id, b]));

    // Lane offsets: trunk (first branch) at 0; the rest alternate up/down.
    const offsetByBranch = new Map<string, number>();
    visible.forEach((b, i) => {
      if (i === 0) offsetByBranch.set(b.id, 0);
      else {
        const pair = Math.ceil(i / 2);
        offsetByBranch.set(b.id, (i % 2 === 1 ? -1 : 1) * pair);
      }
    });
    const offsets = [...offsetByBranch.values()];
    const minOff = Math.min(0, ...offsets);
    const maxOff = Math.max(0, ...offsets);
    const yOf = (off: number) => PAD_TOP + (off - minOff) * LANE_H;

    const sendsByCommit = new Map<string, SendRow[]>();
    for (const s of sends) {
      const list = sendsByCommit.get(s.commitId) ?? [];
      list.push(s);
      sendsByCommit.set(s.commitId, list);
    }

    // Ancestry-aware order: a parent never sits right of its child even when
    // timestamps tie or clocks skew (plain timestamp sort can invert them).
    const ordered = topologicalCommitOrder(commits.filter((c) => offsetByBranch.has(c.branchId)));

    const xByCommit = new Map<string, number>();
    const nodes: Node[] = ordered.map((commit, i) => {
      const branch = byId.get(commit.branchId)!;
      const x = PAD_X + i * COL_W;
      const y = yOf(offsetByBranch.get(commit.branchId)!);
      xByCommit.set(commit.id, x);
      return {
        commit,
        x,
        y,
        color: branch.color,
        branch,
        isTip: branch.headCommitId === commit.id,
        sends: sendsByCommit.get(commit.id) ?? [],
      };
    });
    const nodeById = new Map(nodes.map((n) => [n.commit.id, n]));

    const labels: Label[] = [];
    for (const branch of visible) {
      const tip = nodes.filter((n) => n.commit.branchId === branch.id).at(-1);
      if (!tip) continue;
      const above = (offsetByBranch.get(branch.id) ?? 0) <= 0;
      labels.push({
        branchId: branch.id,
        name: branch.name,
        color: branch.color,
        x: tip.x,
        y: tip.y + (above ? -18 : 20),
        isCurrent: branch.id === currentBranchId,
        above,
        reason: branch.reason,
      });
    }

    const width = PAD_X + Math.max(0, nodes.length - 1) * COL_W + PAD_X + 80;
    const height = yOf(maxOff) + PAD_BOTTOM;
    return { nodes, nodeById, labels, width, height };
  }, [branches, commits, sends, currentBranchId, showArchived]);

  const { nodes, nodeById, labels, width, height } = layout;

  // Start scrolled to the newest (right-most) versions.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [width]);

  // Drag-to-pan; suppress the click that would otherwise fire after a drag.
  const drag = useRef<{ x: number; y: number; left: number; top: number; moved: boolean } | null>(null);
  const [panning, setPanning] = useState(false);

  const onPointerDown = (e: React.PointerEvent) => {
    const el = scrollRef.current;
    if (!el) return;
    drag.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const el = scrollRef.current;
    if (!el || !drag.current) return;
    const dx = e.clientX - drag.current.x;
    const dy = e.clientY - drag.current.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) {
      drag.current.moved = true;
      if (!panning) setPanning(true);
    }
    el.scrollLeft = drag.current.left - dx;
    el.scrollTop = drag.current.top - dy;
  };
  const endDrag = () => {
    setPanning(false);
    setTimeout(() => (drag.current = null), 0);
  };

  if (nodes.length === 0) {
    return <div className="dg-hgraph-empty">No versions yet — save the document to create the first one.</div>;
  }

  const edgePath = (from: Node, to: Node) => {
    if (from.y === to.y) return `M ${from.x} ${from.y} L ${to.x} ${to.y}`;
    const mid = (from.x + to.x) / 2;
    return `M ${from.x} ${from.y} C ${mid} ${from.y}, ${mid} ${to.y}, ${to.x} ${to.y}`;
  };

  return (
    <div
      ref={scrollRef}
      className={`dg-hgraph${panning ? ' is-panning' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerLeave={endDrag}
    >
      <svg width={width} height={height} className="dg-hgraph-svg">
        {nodes.map((node) => {
          const parent = node.commit.parentId ? nodeById.get(node.commit.parentId) : undefined;
          if (!parent) return null;
          return (
            <path key={`e-${node.commit.id}`} d={edgePath(parent, node)} className="dg-hgraph-edge" style={{ stroke: node.color }} />
          );
        })}

        {labels.map((label) => (
          <text
            key={`l-${label.branchId}`}
            x={label.x}
            y={label.y}
            className={`dg-hgraph-label${label.isCurrent ? ' is-current' : ''}`}
            style={{ fill: label.color }}
            textAnchor="middle"
            tabIndex={0}
            role="button"
            aria-label={`Branch ${label.name}${label.reason ? `, ${label.reason}` : ''}`}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelectBranch?.(label.branchId);
              }
            }}
            onPointerUp={(e) => {
              e.stopPropagation();
              if (!drag.current?.moved) onSelectBranch?.(label.branchId);
              endDrag(); // propagation stops here, so clear pan state ourselves
            }}
          >
            {label.reason && <title>{`${label.name} — ${label.reason}`}</title>}
            {label.name}
          </text>
        ))}

        {nodes.map((node) => {
          const selected = selectedIds.includes(node.commit.id);
          return (
            <g
              key={node.commit.id}
              className="dg-hgraph-node-g"
              tabIndex={0}
              role="button"
              aria-label={`Version ${node.commit.message ?? 'Saved'}`}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelect(node.commit, e.metaKey || e.shiftKey);
                }
              }}
              onPointerUp={(e) => {
                e.stopPropagation();
                if (!drag.current?.moved) onSelect(node.commit, e.metaKey || e.shiftKey);
                endDrag(); // propagation stops here, so clear pan state ourselves
              }}
            >
              {selected && <circle cx={node.x} cy={node.y} r={NODE_R + 5} className="dg-hgraph-halo" style={{ stroke: node.color }} />}
              <circle
                cx={node.x}
                cy={node.y}
                r={NODE_R}
                className="dg-hgraph-node"
                style={{ fill: node.isTip ? node.color : 'var(--dg-paper-raised, #fffdf9)', stroke: node.color }}
              />
              {node.sends.length > 0 && (
                <text x={node.x} y={node.y - NODE_R - 6} className="dg-hgraph-send" textAnchor="middle">
                  ✉
                </text>
              )}
              <title>{`${node.commit.message ?? 'Saved version'} — ${formatWhen(node.commit.createdAt)}`}</title>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  const minutes = Math.round((Date.now() - date.getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} d ago`;
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

