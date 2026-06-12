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

export type DocModel = TextDocModel | SpreadsheetModel;

/** Canonical text content of a block — the unit the content diff compares. */
export function blockText(block: Block): string {
  if (block.type === 'paragraph') return block.text;
  return block.rows.map((row) => row.join(' | ')).join('\n');
}

/** Deterministic serialization used for content-addressing models. */
export function canonicalJson(model: DocModel): string {
  return JSON.stringify(model);
}
