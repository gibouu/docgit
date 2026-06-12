import { Fragment, useMemo, useState } from 'react';
import { blockText } from '@docgit/core/model';
import type {
  CellChange,
  Change,
  DocDiff,
  ShapeChange,
  SlidesDiff,
  SpreadsheetDiff,
  TextDiff,
  WordSpan,
} from '@docgit/core/diff';

/**
 * GitHub-PR-style side-by-side diff: old version left, new version right.
 * Text documents: content changes primary, formatting collapsible, long
 * unchanged runs collapsed. Spreadsheets: per-sheet changed-cell tables with
 * formula changes distinguished from value changes.
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

export function DiffView(props: DiffViewProps) {
  if (props.diff.kind === 'spreadsheet') {
    return <SpreadsheetDiffView diff={props.diff} oldLabel={props.oldLabel} newLabel={props.newLabel} />;
  }
  if (props.diff.kind === 'slides') {
    return <SlidesDiffView diff={props.diff} oldLabel={props.oldLabel} newLabel={props.newLabel} />;
  }
  return <TextDiffView diff={props.diff} oldLabel={props.oldLabel} newLabel={props.newLabel} />;
}

function TextDiffView({ diff, oldLabel, newLabel }: { diff: TextDiff; oldLabel: string; newLabel: string }) {
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

function SpreadsheetDiffView({ diff, oldLabel, newLabel }: { diff: SpreadsheetDiff; oldLabel: string; newLabel: string }) {
  const { summary, cellChanges } = diff;
  const bySheet = new Map<string, CellChange[]>();
  for (const change of cellChanges) {
    const list = bySheet.get(change.sheet) ?? [];
    list.push(change);
    bySheet.set(change.sheet, list);
  }

  return (
    <div className="dg-diff">
      <header className="dg-diff-summary">
        <span className="dg-chip dg-chip-added">+{summary.cellsAdded} cells</span>
        <span className="dg-chip dg-chip-removed">−{summary.cellsRemoved} cells</span>
        <span className="dg-chip dg-chip-modified">{summary.cellsModified} changed</span>
        <span className="dg-chip dg-chip-formula">ƒ {summary.formulasChanged} formulas</span>
        <span className="dg-chip dg-chip-quiet">{summary.cellsUnchanged} unchanged</span>
      </header>

      {(summary.sheetsAdded.length > 0 || summary.sheetsRemoved.length > 0) && (
        <p className="dg-sheet-events">
          {summary.sheetsAdded.map((name) => (
            <span key={`a${name}`} className="dg-chip dg-chip-added">+ sheet “{name}”</span>
          ))}
          {summary.sheetsRemoved.map((name) => (
            <span key={`r${name}`} className="dg-chip dg-chip-removed">− sheet “{name}”</span>
          ))}
        </p>
      )}

      {cellChanges.length === 0 ? (
        <p className="dg-sheet-empty">No cell changes between these versions.</p>
      ) : (
        [...bySheet.entries()].map(([sheetName, changes]) => (
          <section key={sheetName} className="dg-sheet">
            <h3 className="dg-sheet-name">{sheetName}</h3>
            <div className="dg-cells">
              <div className="dg-cells-head">
                <span>Cell</span>
                <span>{oldLabel}</span>
                <span>{newLabel}</span>
              </div>
              {changes.map((change) => (
                <div key={change.ref} className={`dg-cells-row dg-cells-${change.type}`}>
                  <span className="dg-cell-ref">
                    {change.ref}
                    {change.formulaChanged && <span className="dg-cell-fmark" title="Formula changed"> ƒ</span>}
                  </span>
                  <span className="dg-cell-old">
                    {change.oldValue ? <CellContent value={change.oldValue} /> : <span className="dg-cell-none">—</span>}
                  </span>
                  <span className="dg-cell-new">
                    {change.newValue ? <CellContent value={change.newValue} /> : <span className="dg-cell-none">—</span>}
                  </span>
                </div>
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}

function CellContent({ value }: { value: { v: string; f?: string } }) {
  return (
    <Fragment>
      <span>{value.v}</span>
      {value.f && <code className="dg-cell-formula">{value.f}</code>}
    </Fragment>
  );
}

function SlidesDiffView({ diff, oldLabel, newLabel }: { diff: SlidesDiff; oldLabel: string; newLabel: string }) {
  const { summary, slideChanges } = diff;
  const interesting = slideChanges.filter((c) => c.type !== 'unchanged');

  return (
    <div className="dg-diff">
      <header className="dg-diff-summary">
        <span className="dg-chip dg-chip-added">+{summary.slidesAdded} slides</span>
        <span className="dg-chip dg-chip-removed">−{summary.slidesRemoved} slides</span>
        <span className="dg-chip dg-chip-modified">{summary.slidesModified} edited</span>
        {summary.slidesMoved > 0 && <span className="dg-chip dg-chip-moved">{summary.slidesMoved} moved</span>}
        <span className="dg-chip dg-chip-quiet">{summary.slidesUnchanged} unchanged</span>
      </header>

      <div className="dg-diff-columns" aria-hidden>
        <div className="dg-diff-col-label">{oldLabel}</div>
        <div className="dg-diff-col-label">{newLabel}</div>
      </div>

      {interesting.length === 0 ? (
        <p className="dg-sheet-empty">No slide changes between these versions.</p>
      ) : (
        interesting.map((change) => (
          <section key={change.slideId} className={`dg-slide dg-slide-${change.type}`}>
            <h3 className="dg-slide-head">
              {change.type === 'added' && <span className="dg-chip dg-chip-added">new</span>}
              {change.type === 'removed' && <span className="dg-chip dg-chip-removed">removed</span>}
              {change.type === 'moved' && <span className="dg-chip dg-chip-moved">moved</span>}
              {change.type === 'modified' && <span className="dg-chip dg-chip-modified">edited</span>}
              <span>
                Slide {(change.newIndex ?? change.oldIndex ?? 0) + 1}
                {change.oldIndex !== undefined &&
                  change.newIndex !== undefined &&
                  change.oldIndex !== change.newIndex &&
                  ` (was ${change.oldIndex + 1})`}
              </span>
            </h3>
            {change.shapeChanges.map((shape, i) => (
              <ShapeChangeRow key={`${shape.name}${i}`} shape={shape} />
            ))}
          </section>
        ))
      )}
    </div>
  );
}

function ShapeChangeRow({ shape }: { shape: ShapeChange }) {
  return (
    <div className="dg-diff-row dg-shape-row">
      <div
        className={`dg-cell ${shape.type === 'removed' ? 'dg-cell-removed' : shape.type === 'modified' ? 'dg-cell-mod-old' : 'dg-cell-empty'}`}
      >
        {shape.oldText !== undefined && (
          <>
            <span className="dg-shape-name">{shape.name}</span>
            {shape.spans ? renderSpans(shape.spans, 'old') : shape.oldText}
          </>
        )}
      </div>
      <div
        className={`dg-cell ${shape.type === 'added' ? 'dg-cell-added' : shape.type === 'modified' ? 'dg-cell-mod-new' : 'dg-cell-empty'}`}
      >
        {shape.newText !== undefined && (
          <>
            <span className="dg-shape-name">{shape.name}</span>
            {shape.spans ? renderSpans(shape.spans, 'new') : shape.newText}
          </>
        )}
      </div>
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
