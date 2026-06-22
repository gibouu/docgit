/**
 * Normalized document model — the format-agnostic intermediate representation
 * that all adapters parse into and the diff engine operates on.
 *
 * Milestone 1 covers text documents (Word / La Suite Docs). Spreadsheet and
 * slide models will be added alongside their adapters.
 */

export interface ParagraphBlock {
  type: 'paragraph';
  text: string;
  /** Paragraph style id, e.g. "Heading1" — used for formatting-level diffs. */
  style?: string;
  /** List numbering reference, when the paragraph is part of a numbered/bulleted list. */
  numbering?: { numId: string; level: number };
}

export interface TableBlock {
  type: 'table';
  /** rows × cells, each cell reduced to its plain text (paragraphs joined by \n). */
  rows: string[][];
}

export type Block = ParagraphBlock | TableBlock;

export interface TextDocModel {
  kind: 'text';
  blocks: Block[];
}

/** A single cell: display value, plus the formula when the cell is computed. */
export interface CellValue {
  v: string;
  f?: string;
}

export interface SheetModel {
  name: string;
  /** Cell reference ("A1") → value. Only non-empty cells are present. */
  cells: Record<string, CellValue>;
}

export interface SpreadsheetModel {
  kind: 'spreadsheet';
  sheets: SheetModel[];
}

/** A shape on a slide reduced to its text (paragraphs joined by \n). */
export interface SlideShape {
  name: string;
  text: string;
}

export interface SlideModel {
  /** PowerPoint's persistent slide id — stable across edits and reorders. */
  id: string;
  shapes: SlideShape[];
}

export interface PresentationModel {
  kind: 'slides';
  slides: SlideModel[];
}

export type DocModel = TextDocModel | SpreadsheetModel | PresentationModel;

/** Canonical text content of a block — the unit the content diff compares. */
export function blockText(block: Block): string {
  if (block.type === 'paragraph') return block.text;
  return block.rows.map((row) => row.join(' | ')).join('\n');
}

/**
 * Deterministic serialization used for content-addressing models. Object keys
 * are emitted in sorted order so map-like records (e.g. a sheet's cells) hash
 * by content, not by parser/construction insertion order; array order is
 * preserved (sheets, blocks, and slides are ordered, not sets).
 */
export function canonicalJson(model: DocModel): string {
  return stableStringify(model);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined) // match JSON.stringify: skip undefined-valued keys
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}
