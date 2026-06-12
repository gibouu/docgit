import { unzipSync, strFromU8 } from 'fflate';
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
  const files = unzipSync(data);
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
    if (!partXml) continue;
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

function parseWorksheet(data: Uint8Array, sharedStrings: string[]): Record<string, CellValue> {
  const cells: Record<string, CellValue> = {};
  const root = parser.parse(strFromU8(data)) as XNode[];
  const worksheet = findChild(root, 'worksheet');
  const sheetData = findChild(childrenOf(worksheet ?? ({} as XNode)), 'sheetData');

  for (const row of findAll(childrenOf(sheetData ?? ({} as XNode)), 'row')) {
    for (const cell of findAll(childrenOf(row), 'c')) {
      const attrs = attrsOf(cell);
      const ref = attrs['@_r'];
      if (!ref) continue;
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

      const formula = fNode ? textOf(fNode) : undefined;
      if (value === '' && !formula) continue; // empty cell — keep the model sparse

      const entry: CellValue = { v: value };
      if (formula) entry.f = `=${formula}`;
      cells[ref] = entry;
    }
  }
  return cells;
}
