import { unzipSync, strFromU8 } from 'fflate';
import { XMLParser } from 'fast-xml-parser';
import type { PresentationModel, SlideModel, SlideShape } from '../../model/types.js';

/**
 * PowerPoint (.pptx) adapter — parse side.
 *
 * ppt/presentation.xml lists slides in order with persistent ids (p:sldId
 * @id survives edits and reorders — the natural identity for move
 * detection); relationships map them to slide parts. Each slide reduces to
 * its named shapes, each shape to its visible text (DrawingML a:t runs,
 * paragraphs joined by newlines). Tables and grouped shapes flatten to text.
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

/** Find first descendant with the given tag (breadth-first). */
function findDeep(nodes: XNode[], tag: string): XNode | undefined {
  const queue = [...nodes];
  while (queue.length) {
    const node = queue.shift()!;
    if (tagOf(node) === tag) return node;
    queue.push(...childrenOf(node));
  }
  return undefined;
}

export function parsePptx(data: Uint8Array): PresentationModel {
  const files = unzipSync(data);
  const presentationXml = files['ppt/presentation.xml'];
  if (!presentationXml) throw new Error('Not a valid .pptx file: missing ppt/presentation.xml');

  const relTargets = parseRels(files['ppt/_rels/presentation.xml.rels']);
  const root = parser.parse(strFromU8(presentationXml)) as XNode[];
  const presentation = findChild(root, 'p:presentation');
  const sldIdLst = findChild(childrenOf(presentation ?? ({} as XNode)), 'p:sldIdLst');

  const slides: SlideModel[] = [];
  for (const sldId of findAll(childrenOf(sldIdLst ?? ({} as XNode)), 'p:sldId')) {
    const attrs = attrsOf(sldId);
    const id = attrs['@_id'] ?? String(256 + slides.length);
    const relId = attrs['@_r:id'];
    const target = relId ? relTargets.get(relId) : undefined;
    const partPath = target ? normalizePartPath(target) : `ppt/slides/slide${slides.length + 1}.xml`;
    const partXml = files[partPath];
    if (!partXml) continue;
    slides.push({ id, shapes: parseSlide(partXml) });
  }

  return { kind: 'slides', slides };
}

function normalizePartPath(target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  return `ppt/${target}`;
}

function parseRels(data: Uint8Array | undefined): Map<string, string> {
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

function parseSlide(data: Uint8Array): SlideShape[] {
  const root = parser.parse(strFromU8(data)) as XNode[];
  const spTree = findDeep(root, 'p:spTree');
  if (!spTree) return [];

  const shapes: SlideShape[] = [];
  let anonymous = 0;
  const visit = (nodes: XNode[]) => {
    for (const node of nodes) {
      const tag = tagOf(node);
      if (tag === 'p:sp' || tag === 'p:graphicFrame' || tag === 'p:pic') {
        const cNvPr = findDeep(childrenOf(node), 'p:cNvPr');
        const name = cNvPr ? (attrsOf(cNvPr)['@_name'] ?? '') : '';
        const text = shapeText(childrenOf(node));
        if (text.trim() !== '') {
          shapes.push({ name: name || `Shape ${++anonymous}`, text });
        }
      } else if (tag === 'p:grpSp') {
        visit(childrenOf(node)); // grouped shapes flatten into the slide
      }
    }
  };
  visit(childrenOf(spTree));
  return shapes;
}

/** Visible text of a shape: a:p paragraphs joined by \n, a:br as \n, a:t runs concatenated. */
function shapeText(nodes: XNode[]): string {
  const paragraphs: string[] = [];
  const walk = (list: XNode[]) => {
    for (const node of list) {
      const tag = tagOf(node);
      if (tag === 'a:p') {
        paragraphs.push(paragraphText(childrenOf(node)));
      } else if (tag) {
        walk(childrenOf(node));
      }
    }
  };
  walk(nodes);
  return paragraphs.join('\n');
}

function paragraphText(nodes: XNode[]): string {
  let text = '';
  for (const node of nodes) {
    const tag = tagOf(node);
    if (tag === 'a:t') text += textOf(node);
    else if (tag === 'a:br') text += '\n';
    else if (tag === 'a:pPr' || tag === 'a:rPr' || tag === 'a:endParaRPr') continue;
    else if (tag) text += paragraphText(childrenOf(node));
  }
  return text;
}
