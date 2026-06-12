import type { CellValue, SpreadsheetModel } from '../model/types.js';

/**
 * Cell-level spreadsheet diff: sheets are matched by name, cells by
 * reference. Formula changes are tracked separately from value changes —
 * "the number moved" and "the calculation changed" are different events for
 * someone auditing a workbook.
 *
 * Known MVP limit: inserting a row shifts every cell below it, which reads
 * as many modified cells. Row-shift detection is future work.
 */

export interface CellChange {
  sheet: string;
  ref: string;
  type: 'added' | 'removed' | 'modified';
  oldValue?: CellValue;
  newValue?: CellValue;
  /** The formula itself changed (not just its computed value). */
  formulaChanged: boolean;
}

export interface SpreadsheetDiffSummary {
  cellsAdded: number;
  cellsRemoved: number;
  cellsModified: number;
  formulasChanged: number;
  sheetsAdded: string[];
  sheetsRemoved: string[];
  cellsUnchanged: number;
}

export interface SpreadsheetDiff {
  kind: 'spreadsheet';
  cellChanges: CellChange[];
  summary: SpreadsheetDiffSummary;
}

export function diffSpreadsheetModels(oldModel: SpreadsheetModel, newModel: SpreadsheetModel): SpreadsheetDiff {
  const oldSheets = new Map(oldModel.sheets.map((s) => [s.name, s]));
  const newSheets = new Map(newModel.sheets.map((s) => [s.name, s]));

  const summary: SpreadsheetDiffSummary = {
    cellsAdded: 0,
    cellsRemoved: 0,
    cellsModified: 0,
    formulasChanged: 0,
    sheetsAdded: [...newSheets.keys()].filter((n) => !oldSheets.has(n)),
    sheetsRemoved: [...oldSheets.keys()].filter((n) => !newSheets.has(n)),
    cellsUnchanged: 0,
  };

  const cellChanges: CellChange[] = [];

  for (const [name, newSheet] of newSheets) {
    const oldSheet = oldSheets.get(name);
    if (!oldSheet) {
      // Whole sheet added: every cell is an addition.
      for (const [ref, value] of Object.entries(newSheet.cells)) {
        cellChanges.push({ sheet: name, ref, type: 'added', newValue: value, formulaChanged: !!value.f });
        summary.cellsAdded++;
        if (value.f) summary.formulasChanged++;
      }
      continue;
    }
    const refs = new Set([...Object.keys(oldSheet.cells), ...Object.keys(newSheet.cells)]);
    for (const ref of sortRefs(refs)) {
      const oldCell = oldSheet.cells[ref];
      const newCell = newSheet.cells[ref];
      if (oldCell && !newCell) {
        cellChanges.push({ sheet: name, ref, type: 'removed', oldValue: oldCell, formulaChanged: !!oldCell.f });
        summary.cellsRemoved++;
        if (oldCell.f) summary.formulasChanged++;
      } else if (!oldCell && newCell) {
        cellChanges.push({ sheet: name, ref, type: 'added', newValue: newCell, formulaChanged: !!newCell.f });
        summary.cellsAdded++;
        if (newCell.f) summary.formulasChanged++;
      } else if (oldCell && newCell) {
        const valueChanged = oldCell.v !== newCell.v;
        const formulaChanged = (oldCell.f ?? '') !== (newCell.f ?? '');
        if (valueChanged || formulaChanged) {
          cellChanges.push({ sheet: name, ref, type: 'modified', oldValue: oldCell, newValue: newCell, formulaChanged });
          summary.cellsModified++;
          if (formulaChanged) summary.formulasChanged++;
        } else {
          summary.cellsUnchanged++;
        }
      }
    }
  }

  for (const name of summary.sheetsRemoved) {
    for (const [ref, value] of Object.entries(oldSheets.get(name)!.cells)) {
      cellChanges.push({ sheet: name, ref, type: 'removed', oldValue: value, formulaChanged: !!value.f });
      summary.cellsRemoved++;
      if (value.f) summary.formulasChanged++;
    }
  }

  return { kind: 'spreadsheet', cellChanges, summary };
}

/** Sort "A1"-style refs row-major (A1, B1, A2…) so diffs read top to bottom. */
function sortRefs(refs: Set<string>): string[] {
  return [...refs].sort((a, b) => {
    const [ca, ra] = splitRef(a);
    const [cb, rb] = splitRef(b);
    return ra - rb || ca.length - cb.length || ca.localeCompare(cb) || a.localeCompare(b);
  });
}

function splitRef(ref: string): [string, number] {
  const match = /^([A-Z]+)(\d+)$/i.exec(ref);
  return match ? [match[1]!.toUpperCase(), Number(match[2])] : [ref, 0];
}
