import { strFromU8 } from 'fflate';
import { safeUnzip } from '../zip.js';
import { XMLParser } from 'fast-xml-parser';
import type { Block, ParagraphBlock, TextDocModel } from '../../model/types.js';

/**
 * Word (.docx) adapter — parse side.
 *
 * A .docx is a ZIP of OOXML parts; the document body lives in
 * word/document.xml. We parse the XML preserving element order and walk the
 * body, reducing it to the normalized model. Tracked changes are resolved to
 * the document's *final* state: insertions (w:ins) are included, deletions
 * (w:del / w:delText) are excluded — so a document with pending track-changes
 * diffs identically to its accepted form.
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

function textContent(node: XNode): string {
  let out = '';
  for (const child of childrenOf(node)) {
    if ('#text' in child) out += String(child['#text']);
  }
  return out;
}

function findChild(nodes: XNode[], tag: string): XNode | undefined {
  return nodes.find((n) => tagOf(n) === tag);
}

export function parseDocx(data: Uint8Array): TextDocModel {
  const files = safeUnzip(data);
  const documentXml = files['word/document.xml'];
  if (!documentXml) {
    throw new Error('Not a valid .docx file: missing word/document.xml');
  }
  const root = parser.parse(strFromU8(documentXml)) as XNode[];

  const document = findChild(root, 'w:document');
  if (!document) throw new Error('Invalid OOXML: missing w:document');
  const body = findChild(childrenOf(document), 'w:body');
  if (!body) throw new Error('Invalid OOXML: missing w:body');

  return { kind: 'text', blocks: blocksFromBody(childrenOf(body)) };
}

function blocksFromBody(nodes: XNode[]): Block[] {
  const blocks: Block[] = [];
  for (const node of nodes) {
    const tag = tagOf(node);
    if (tag === 'w:p') {
      blocks.push(parseParagraph(node));
    } else if (tag === 'w:tbl') {
      blocks.push(parseTable(node));
    }
    // w:sectPr and other section-level nodes carry no content — skipped.
  }
  return blocks;
}

function parseParagraph(p: XNode): ParagraphBlock {
  const block: ParagraphBlock = { type: 'paragraph', text: '' };

  const pPr = findChild(childrenOf(p), 'w:pPr');
  if (pPr) {
    const pPrKids = childrenOf(pPr);
    const styleNode = findChild(pPrKids, 'w:pStyle');
    if (styleNode) {
      const val = attrsOf(styleNode)['@_w:val'];
      if (val) block.style = val;
    }
    const numPr = findChild(pPrKids, 'w:numPr');
    if (numPr) {
      const numKids = childrenOf(numPr);
      const numId = numPr && findChild(numKids, 'w:numId');
      const ilvl = findChild(numKids, 'w:ilvl');
      if (numId) {
        block.numbering = {
          numId: attrsOf(numId)['@_w:val'] ?? '0',
          level: Number(ilvl ? (attrsOf(ilvl)['@_w:val'] ?? '0') : '0'),
        };
      }
    }
  }

  block.text = collectRunText(childrenOf(p));
  return block;
}

/**
 * Collect visible text from a paragraph's content, descending through run
 * containers (w:r, w:hyperlink, w:ins, w:smartTag, …). w:del subtrees are
 * skipped entirely — their w:delText is not part of the final document.
 */
function collectRunText(nodes: XNode[]): string {
  let text = '';
  for (const node of nodes) {
    const tag = tagOf(node);
    if (!tag) continue;
    switch (tag) {
      case 'w:pPr':
      case 'w:del':
      case 'w:delText':
        break;
      case 'w:t':
        text += textContent(node);
        break;
      case 'w:tab':
        text += '\t';
        break;
      case 'w:br':
      case 'w:cr':
        text += '\n';
        break;
      default:
        text += collectRunText(childrenOf(node));
    }
  }
  return text;
}

function parseTable(tbl: XNode): Block {
  const rows: string[][] = [];
  for (const rowNode of childrenOf(tbl)) {
    if (tagOf(rowNode) !== 'w:tr') continue;
    const cells: string[] = [];
    for (const cellNode of childrenOf(rowNode)) {
      if (tagOf(cellNode) !== 'w:tc') continue;
      const cellParagraphs: string[] = [];
      for (const inner of childrenOf(cellNode)) {
        const innerTag = tagOf(inner);
        if (innerTag === 'w:p') {
          cellParagraphs.push(parseParagraph(inner).text);
        } else if (innerTag === 'w:tbl') {
          // Nested table: flatten its text into the host cell.
          const nested = parseTable(inner);
          if (nested.type === 'table') {
            cellParagraphs.push(nested.rows.map((r) => r.join(' | ')).join('\n'));
          }
        }
      }
      cells.push(cellParagraphs.join('\n'));
    }
    rows.push(cells);
  }
  return { type: 'table', rows };
}
