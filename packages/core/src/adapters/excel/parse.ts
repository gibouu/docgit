import { strFromU8 } from 'fflate';
import { safeUnzip } from '../zip.js';
import { XMLParser } from 'fast-xml-parser';
import type { CellValue, SheetModel, SpreadsheetModel } from '../../model/types.js';

/**
 * Excel (.xlsx) adapter — parse side.
 *
 * An .xlsx is a ZIP of OOXML parts: xl/workbook.xml names the sheets,
 * xl/_rels/workbook.xml.rels maps them to worksheet parts, and shared cell
 * text lives in xl/sharedStrings.xml. We reduce each sheet to a sparse
 * ref → {value, formula} map.
 *
 * Known MVP limit: numeric cells keep their raw stored value (dates are
 * Excel serial numbers); number-format-aware rendering comes with the
 * live-links work.
 */

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
});

type XNode = Record<string, unknown>;

function tagOf(node: XNode): string | undefined {
  for (const key of Object.keys(node)) {
    if (key !== ':@' && key !== '#text') return key;
  }
  return undefined;
}

function childrenOf(node: XNode): XNode[] {
  const tag = tagOf(node);
  const kids = tag ? node[tag] : undefined;
  return Array.isArray(kids) ? (kids as XNode[]) : [];
}

function attrsOf(node: XNode): Record<string, string> {
  return (node[':@'] as Record<string, string>) ?? {};
}

function textOf(node: XNode): string {
  let out = '';
  for (const child of childrenOf(node)) {
    if ('#text' in child) out += String(child['#text']);
  }
  return out;
}

function findChild(nodes: XNode[], tag: string): XNode | undefined {
  return nodes.find((n) => tagOf(n) === tag);
}

function findAll(nodes: XNode[], tag: string): XNode[] {
  return nodes.filter((n) => tagOf(n) === tag);
}

/** Collect all descendant <t> text (shared strings may be split into runs). */
function collectT(nodes: XNode[]): string {
  let out = '';
  for (const node of nodes) {
    const tag = tagOf(node);
    if (tag === 't') out += textOf(node);
    else if (tag) out += collectT(childrenOf(node));
  }
  return out;
}

export function parseXlsx(data: Uint8Array): SpreadsheetModel {
  const files = safeUnzip(data);
  const workbookXml = files['xl/workbook.xml'];
  if (!workbookXml) throw new Error('Not a valid .xlsx file: missing xl/workbook.xml');

  const sharedStrings = parseSharedStrings(files['xl/sharedStrings.xml']);
  const relTargets = parseWorkbookRels(files['xl/_rels/workbook.xml.rels']);

  const workbook = parser.parse(strFromU8(workbookXml)) as XNode[];
  const workbookNode = findChild(workbook, 'workbook');
  if (!workbookNode) throw new Error('Invalid xlsx: missing workbook element');
  const sheetsNode = findChild(childrenOf(workbookNode), 'sheets');

  const sheets: SheetModel[] = [];
  for (const sheetNode of findAll(childrenOf(sheetsNode ?? ({} as XNode)), 'sheet')) {
    const attrs = attrsOf(sheetNode);
    const name = attrs['@_name'] ?? `Sheet${sheets.length + 1}`;
    const relId = attrs['@_r:id'];
    const target = relId ? relTargets.get(relId) : undefined;
    const partPath = target ? normalizePartPath(target) : `xl/worksheets/sheet${sheets.length + 1}.xml`;
    const partXml = files[partPath];
    // A referenced worksheet whose part is missing means a corrupt package —
    // fail loudly instead of silently dropping the sheet (which would diff as a
    // deleted sheet and mislead the user).
    if (!partXml) throw new Error(`Corrupt .xlsx: worksheet part for sheet "${name}" is missing (${partPath})`);
    sheets.push({ name, cells: parseWorksheet(partXml, sharedStrings) });
  }

  return { kind: 'spreadsheet', sheets };
}

function normalizePartPath(target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  return `xl/${target}`;
}

function parseWorkbookRels(data: Uint8Array | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!data) return map;
  const root = parser.parse(strFromU8(data)) as XNode[];
  const rels = findChild(root, 'Relationships');
  for (const rel of findAll(childrenOf(rels ?? ({} as XNode)), 'Relationship')) {
    const attrs = attrsOf(rel);
    if (attrs['@_Id'] && attrs['@_Target']) map.set(attrs['@_Id'], attrs['@_Target']);
  }
  return map;
}

function parseSharedStrings(data: Uint8Array | undefined): string[] {
  if (!data) return [];
  const root = parser.parse(strFromU8(data)) as XNode[];
  const sst = findChild(root, 'sst');
  return findAll(childrenOf(sst ?? ({} as XNode)), 'si').map((si) => collectT(childrenOf(si)));
}

/** 0-based column index → "A", "Z", "AA"… */
function columnName(index: number): string {
  let n = index;
  let s = '';
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/** Leading letters of a cell ref → 0-based column index ("B2" → 1). */
function columnIndexOf(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function parseWorksheet(data: Uint8Array, sharedStrings: string[]): Record<string, CellValue> {
  const cells: Record<string, CellValue> = {};
  // Shared formulas: the anchor cell carries the formula text under an si; the
  // dependent cells carry an empty <f t="shared" si="N"/>. Remember each anchor
  // so dependents don't collapse into plain values. (Exact per-cell relative
  // translation is future work; reusing the anchor text preserves the formula
  // and keeps diffs deterministic.)
  const sharedFormulas = new Map<string, string>();
  const root = parser.parse(strFromU8(data)) as XNode[];
  const worksheet = findChild(root, 'worksheet');
  // A malformed worksheet part (no <worksheet> root) is corruption, not an
  // empty sheet — a legitimately-empty sheet still has <worksheet><sheetData/>.
  if (!worksheet) throw new Error('Corrupt .xlsx: malformed worksheet (missing <worksheet> root)');
  const sheetData = findChild(childrenOf(worksheet), 'sheetData');

  for (const row of findAll(childrenOf(sheetData ?? ({} as XNode)), 'row')) {
    const rowNum = attrsOf(row)['@_r'];
    let colIndex = 0; // tracks position for cells that omit @_r
    for (const cell of findAll(childrenOf(row), 'c')) {
      const attrs = attrsOf(cell);
      let ref = attrs['@_r'];
      if (ref) {
        colIndex = columnIndexOf(ref) + 1; // next inferred cell continues after this one
      } else {
        if (rowNum === undefined) continue; // no row number → can't infer an address
        ref = `${columnName(colIndex)}${rowNum}`;
        colIndex += 1;
      }
      const type = attrs['@_t'] ?? 'n';
      const kids = childrenOf(cell);
      const vNode = findChild(kids, 'v');
      const fNode = findChild(kids, 'f');
      const isNode = findChild(kids, 'is');

      let value = '';
      if (type === 's') {
        const idx = Number(vNode ? textOf(vNode) : NaN);
        value = sharedStrings[idx] ?? '';
      } else if (type === 'inlineStr') {
        value = isNode ? collectT(childrenOf(isNode)) : '';
      } else if (type === 'b') {
        value = vNode && textOf(vNode) === '1' ? 'TRUE' : 'FALSE';
      } else {
        value = vNode ? textOf(vNode) : '';
      }

      let formula: string | undefined;
      if (fNode) {
        const fAttrs = attrsOf(fNode);
        const text = textOf(fNode);
        if (fAttrs['@_t'] === 'shared' && fAttrs['@_si'] !== undefined) {
          const si = String(fAttrs['@_si']);
          if (text) {
            formula = `=${text}`;
            sharedFormulas.set(si, formula); // anchor
          } else {
            formula = sharedFormulas.get(si); // dependent → reuse the anchor's formula
          }
        } else if (text) {
          formula = `=${text}`;
        }
      }
      if (value === '' && !formula) continue; // empty cell — keep the model sparse

      const entry: CellValue = { v: value };
      if (formula) entry.f = formula;
      cells[ref] = entry;
    }
  }
  return cells;
}
