import { strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { diffModels, parseDocument, parseXlsx } from '../src/index.js';
import { makeXlsx, type FixtureSheet } from './helpers/makeXlsx.js';

const sheet = (cells: FixtureSheet['cells'], name = 'Sheet1'): FixtureSheet => ({ name, cells });

describe('Excel adapter — parseXlsx', () => {
  it('parses values, shared strings and numbers', () => {
    const model = parseXlsx(makeXlsx([sheet({ A1: 'Revenue', B1: 1200, A2: 'Costs', B2: 800 })]));
    expect(model.kind).toBe('spreadsheet');
    expect(model.sheets).toHaveLength(1);
    expect(model.sheets[0]!.cells).toEqual({
      A1: { v: 'Revenue' },
      B1: { v: '1200' },
      A2: { v: 'Costs' },
      B2: { v: '800' },
    });
  });

  it('parses formulas with cached values', () => {
    const model = parseXlsx(makeXlsx([sheet({ B1: 100, B2: 50, B3: { f: 'SUM(B1:B2)', v: 150 } })]));
    expect(model.sheets[0]!.cells['B3']).toEqual({ v: '150', f: '=SUM(B1:B2)' });
  });

  it('parses multiple named sheets in order', () => {
    const model = parseXlsx(makeXlsx([sheet({ A1: 'one' }, 'Summary'), sheet({ A1: 'two' }, 'Détail 2026')]));
    expect(model.sheets.map((s) => s.name)).toEqual(['Summary', 'Détail 2026']);
    expect(model.sheets[1]!.cells['A1']).toEqual({ v: 'two' });
  });

  it('rejects non-xlsx zips', () => {
    expect(() => parseXlsx(new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)]))).toThrow(/workbook/);
  });

  it('parseDocument dispatches by extension', () => {
    const bytes = makeXlsx([sheet({ A1: 'x' })]);
    expect(parseDocument('/tmp/forecast.xlsx', bytes).kind).toBe('spreadsheet');
    expect(() => parseDocument('/tmp/notes.txt', bytes)).toThrow(/Unsupported/);
  });
});

describe('spreadsheet diff', () => {
  const modelOf = (cells: FixtureSheet['cells']) => parseXlsx(makeXlsx([sheet(cells)]));

  it('reports value changes cell by cell', () => {
    const diff = diffModels(modelOf({ A1: 'Price', B1: 100 }), modelOf({ A1: 'Price', B1: 120 }));
    if (diff.kind !== 'spreadsheet') throw new Error('expected spreadsheet diff');
    expect(diff.summary).toMatchObject({ cellsModified: 1, cellsAdded: 0, cellsRemoved: 0, cellsUnchanged: 1 });
    expect(diff.cellChanges[0]).toMatchObject({
      sheet: 'Sheet1',
      ref: 'B1',
      type: 'modified',
      oldValue: { v: '100' },
      newValue: { v: '120' },
      formulaChanged: false,
    });
  });

  it('distinguishes formula changes from value changes', () => {
    const diff = diffModels(
      modelOf({ B3: { f: 'SUM(B1:B2)', v: 150 } }),
      modelOf({ B3: { f: 'SUM(B1:B2)*1.2', v: 180 } }),
    );
    if (diff.kind !== 'spreadsheet') throw new Error('expected spreadsheet diff');
    expect(diff.summary.formulasChanged).toBe(1);
    expect(diff.cellChanges[0]).toMatchObject({ ref: 'B3', formulaChanged: true });

    // Same formula, recalculated value (e.g. an input changed elsewhere).
    const valueOnly = diffModels(
      modelOf({ B3: { f: 'SUM(B1:B2)', v: 150 } }),
      modelOf({ B3: { f: 'SUM(B1:B2)', v: 175 } }),
    );
    if (valueOnly.kind !== 'spreadsheet') throw new Error('expected spreadsheet diff');
    expect(valueOnly.summary.formulasChanged).toBe(0);
    expect(valueOnly.cellChanges[0]).toMatchObject({ ref: 'B3', type: 'modified', formulaChanged: false });
  });

  it('reports added and removed cells in row-major order', () => {
    const diff = diffModels(modelOf({ A1: 'keep', C5: 'gone' }), modelOf({ A1: 'keep', B2: 'new', A3: 'also new' }));
    if (diff.kind !== 'spreadsheet') throw new Error('expected spreadsheet diff');
    expect(diff.summary).toMatchObject({ cellsAdded: 2, cellsRemoved: 1, cellsModified: 0 });
    expect(diff.cellChanges.map((c) => c.ref)).toEqual(['B2', 'A3', 'C5']);
  });

  it('reports whole sheets added and removed', () => {
    const oldModel = parseXlsx(makeXlsx([sheet({ A1: 'main' }, 'Summary'), sheet({ A1: 'old' }, 'Archive')]));
    const newModel = parseXlsx(makeXlsx([sheet({ A1: 'main' }, 'Summary'), sheet({ A1: 'fresh', A2: 'data' }, 'Q3')]));
    const diff = diffModels(oldModel, newModel);
    if (diff.kind !== 'spreadsheet') throw new Error('expected spreadsheet diff');
    expect(diff.summary.sheetsAdded).toEqual(['Q3']);
    expect(diff.summary.sheetsRemoved).toEqual(['Archive']);
    expect(diff.summary.cellsAdded).toBe(2);
    expect(diff.summary.cellsRemoved).toBe(1);
  });

  it('refuses to diff a spreadsheet against a text document', () => {
    const text = { kind: 'text' as const, blocks: [] };
    expect(() => diffModels(text, modelOf({ A1: 'x' }))).toThrow(/different kinds/);
  });

  it('throws on a referenced worksheet whose part is missing (#104)', () => {
    const files = unzipSync(makeXlsx([{ name: 'S', cells: { A1: 'x' } }]));
    delete files['xl/worksheets/sheet1.xml']; // corrupt: rel points at a missing part
    expect(() => parseXlsx(zipSync(files))).toThrow(/worksheet part/i);
  });

  it('throws on a malformed worksheet root (#104)', () => {
    const files = unzipSync(makeXlsx([{ name: 'S', cells: { A1: 'x' } }]));
    files['xl/worksheets/sheet1.xml'] = strToU8('<?xml version="1.0"?><notAWorksheet/>');
    expect(() => parseXlsx(zipSync(files))).toThrow(/malformed worksheet/i);
  });

  it('infers cell addresses when @r is omitted (#73)', () => {
    const model = parseXlsx(
      makeXlsx([{ name: 'S', cells: {}, rawRows: '<row r="2"><c><v>10</v></c><c><v>20</v></c></row>' }]),
    );
    expect(model.sheets[0]!.cells).toMatchObject({ A2: { v: '10' }, B2: { v: '20' } });
  });

  it('preserves shared formulas on dependent cells (#98)', () => {
    const model = parseXlsx(
      makeXlsx([
        {
          name: 'S',
          cells: {},
          rawRows:
            '<row r="1"><c r="A1"><f t="shared" ref="A1:A2" si="0">B1+1</f><v>2</v></c></row>' +
            '<row r="2"><c r="A2"><f t="shared" si="0"/><v>3</v></c></row>',
        },
      ]),
    );
    expect(model.sheets[0]!.cells.A1).toMatchObject({ f: '=B1+1' });
    expect(model.sheets[0]!.cells.A2?.f).toBe('=B1+1'); // dependent kept its formula, not a plain value
  });

  it('emits cells of a wholly-added sheet in row-major order (#109)', () => {
    const before = { kind: 'spreadsheet' as const, sheets: [] };
    const after = {
      kind: 'spreadsheet' as const,
      sheets: [{ name: 'New', cells: { B2: { v: '4' }, A1: { v: '1' }, A2: { v: '3' }, B1: { v: '2' } } }],
    };
    const diff = diffModels(before, after);
    if (diff.kind !== 'spreadsheet') throw new Error('expected a spreadsheet diff');
    expect(diff.cellChanges.filter((c) => c.sheet === 'New').map((c) => c.ref)).toEqual(['A1', 'B1', 'A2', 'B2']);
  });
});
