import { Fragment, useMemo, useState } from 'react';
import { blockText } from '@docgit/core/model';
import type { Change, DocDiff, WordSpan } from '@docgit/core/diff';

/**
 * GitHub-PR-style side-by-side diff: old version left, new version right.
 * Content changes are primary; formatting changes live in a collapsible
 * section at the bottom. Long unchanged runs collapse to a single row.
 */

export interface DiffViewProps {
  diff: DocDiff;
  oldLabel: string;
  newLabel: string;
}

const CONTEXT = 1; // unchanged paragraphs kept visible around each change

type DiffRow =
  | { kind: 'change'; change: Change; key: string }
  | { kind: 'collapsed'; changes: Change[]; key: string };

export function DiffView({ diff, oldLabel, newLabel }: DiffViewProps) {
  const { changes, summary } = diff;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showFormatting, setShowFormatting] = useState(false);

  const rows = useMemo(() => buildRows(changes, expanded), [changes, expanded]);
  const formattingChanges = useMemo(() => changes.filter((c) => c.formatting), [changes]);

  return (
    <div className="dg-diff">
      <header className="dg-diff-summary">
        <span className="dg-chip dg-chip-added">+{summary.added} added</span>
        <span className="dg-chip dg-chip-removed">−{summary.removed} removed</span>
        <span className="dg-chip dg-chip-modified">{summary.modified} modified</span>
        {summary.moved > 0 && <span className="dg-chip dg-chip-moved">{summary.moved} moved</span>}
        <span className="dg-chip dg-chip-quiet">{summary.unchanged} unchanged</span>
      </header>

      <div className="dg-diff-columns" aria-hidden>
        <div className="dg-diff-col-label">{oldLabel}</div>
        <div className="dg-diff-col-label">{newLabel}</div>
      </div>

      <div className="dg-diff-body">
        {rows.map((row) =>
          row.kind === 'collapsed' ? (
            <button
              key={row.key}
              type="button"
              className="dg-diff-collapsed"
              onClick={() => setExpanded((prev) => new Set(prev).add(row.key))}
            >
              ⋯ {row.changes.length} unchanged paragraph{row.changes.length > 1 ? 's' : ''} — click to show
            </button>
          ) : (
            <DiffRowView key={row.key} change={row.change} />
          ),
        )}
      </div>

      {formattingChanges.length > 0 && (
        <section className="dg-diff-formatting">
          <button type="button" className="dg-diff-formatting-toggle" onClick={() => setShowFormatting((v) => !v)}>
            {showFormatting ? '▾' : '▸'} Formatting changes ({formattingChanges.length})
          </button>
          {showFormatting && (
            <ul>
              {formattingChanges.map((change, i) => (
                <li key={i}>
                  <span className="dg-diff-formatting-text">“{truncate(blockText(change.newBlock ?? change.oldBlock!), 60)}”</span>
                  {change.formatting!.fromStyle !== undefined || change.formatting!.toStyle !== undefined ? (
                    <span>
                      {' '}
                      style: {change.formatting!.fromStyle ?? 'default'} → {change.formatting!.toStyle ?? 'default'}
                    </span>
                  ) : null}
                  {change.formatting!.numberingChanged ? <span> list numbering changed</span> : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

function buildRows(changes: Change[], expanded: Set<string>): DiffRow[] {
  const rows: DiffRow[] = [];
  let i = 0;
  while (i < changes.length) {
    const change = changes[i]!;
    if (change.type !== 'unchanged') {
      rows.push({ kind: 'change', change, key: `c${i}` });
      i++;
      continue;
    }
    let j = i;
    while (j < changes.length && changes[j]!.type === 'unchanged') j++;
    const run = changes.slice(i, j);
    const key = `u${i}-${j}`;
    if (run.length <= CONTEXT * 2 + 1 || expanded.has(key)) {
      run.forEach((c, k) => rows.push({ kind: 'change', change: c, key: `c${i + k}` }));
    } else {
      run.slice(0, CONTEXT).forEach((c, k) => rows.push({ kind: 'change', change: c, key: `c${i + k}` }));
      rows.push({ kind: 'collapsed', changes: run.slice(CONTEXT, run.length - CONTEXT), key });
      run
        .slice(run.length - CONTEXT)
        .forEach((c, k) => rows.push({ kind: 'change', change: c, key: `c${j - CONTEXT + k}` }));
    }
    i = j;
  }
  return rows;
}

function DiffRowView({ change }: { change: Change }) {
  const oldText = change.oldBlock ? blockText(change.oldBlock) : null;
  const newText = change.newBlock ? blockText(change.newBlock) : null;

  switch (change.type) {
    case 'unchanged':
      return (
        <div className="dg-diff-row">
          <div className="dg-cell">{oldText}</div>
          <div className="dg-cell">{newText}</div>
        </div>
      );
    case 'added':
      return (
        <div className="dg-diff-row">
          <div className="dg-cell dg-cell-empty" />
          <div className="dg-cell dg-cell-added">{newText}</div>
        </div>
      );
    case 'removed':
      return (
        <div className="dg-diff-row">
          <div className="dg-cell dg-cell-removed">{oldText}</div>
          <div className="dg-cell dg-cell-empty" />
        </div>
      );
    case 'moved':
      return (
        <div className="dg-diff-row">
          <div className="dg-cell dg-cell-moved">
            <span className="dg-moved-tag">moved from ¶{(change.oldIndex ?? 0) + 1}</span>
            {oldText}
          </div>
          <div className="dg-cell dg-cell-moved">
            <span className="dg-moved-tag">now ¶{(change.newIndex ?? 0) + 1}</span>
            {newText}
          </div>
        </div>
      );
    case 'modified':
      return (
        <div className="dg-diff-row">
          <div className="dg-cell dg-cell-mod-old">{renderSpans(change.spans, 'old')}</div>
          <div className="dg-cell dg-cell-mod-new">{renderSpans(change.spans, 'new')}</div>
        </div>
      );
  }
}

function renderSpans(spans: WordSpan[] | undefined, side: 'old' | 'new') {
  if (!spans) return null;
  return (
    <Fragment>
      {spans
        .filter((s) => (side === 'old' ? s.kind !== 'added' : s.kind !== 'removed'))
        .map((s, i) =>
          s.kind === 'same' ? (
            <Fragment key={i}>{s.text}</Fragment>
          ) : (
            <mark key={i} className={s.kind === 'added' ? 'dg-mark-added' : 'dg-mark-removed'}>
              {s.text}
            </mark>
          ),
        )}
    </Fragment>
  );
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
