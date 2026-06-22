import { describe, expect, it } from 'vitest';
import { canonicalJson, type SpreadsheetModel } from '../src/index.js';

describe('canonicalJson', () => {
  it('is stable regardless of object key insertion order', () => {
    // Same cells, inserted in different order — must content-address identically.
    const a: SpreadsheetModel = {
      kind: 'spreadsheet',
      sheets: [{ name: 'Sheet1', cells: { A1: { v: '1' }, B2: { v: '2' } } }],
    };
    const b: SpreadsheetModel = {
      kind: 'spreadsheet',
      sheets: [{ name: 'Sheet1', cells: { B2: { v: '2' }, A1: { v: '1' } } }],
    };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('still distinguishes genuinely different content', () => {
    const a: SpreadsheetModel = { kind: 'spreadsheet', sheets: [{ name: 'S', cells: { A1: { v: '1' } } }] };
    const b: SpreadsheetModel = { kind: 'spreadsheet', sheets: [{ name: 'S', cells: { A1: { v: '2' } } }] };
    expect(canonicalJson(a)).not.toBe(canonicalJson(b));
  });

  it('preserves array order (sheets/blocks are ordered, not sorted)', () => {
    const a: SpreadsheetModel = {
      kind: 'spreadsheet',
      sheets: [
        { name: 'First', cells: {} },
        { name: 'Second', cells: {} },
      ],
    };
    const b: SpreadsheetModel = {
      kind: 'spreadsheet',
      sheets: [
        { name: 'Second', cells: {} },
        { name: 'First', cells: {} },
      ],
    };
    expect(canonicalJson(a)).not.toBe(canonicalJson(b));
  });
});
