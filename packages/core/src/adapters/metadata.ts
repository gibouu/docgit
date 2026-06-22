import { strFromU8 } from 'fflate';
import { XMLParser } from 'fast-xml-parser';
import { safeUnzip } from './zip.js';

/**
 * Read the editor's name embedded in an OOXML document.
 *
 * Word, Excel and PowerPoint all stamp the last editor into
 * docProps/core.xml (`cp:lastModifiedBy`, falling back to the original
 * author `dc:creator`). Because this travels *inside* the file, it survives
 * iCloud/OneDrive sync — so DocGit can attribute a version to whoever
 * actually edited it, including collaborators, without any shared database.
 */
const metaParser = new XMLParser({
  ignoreAttributes: true, // attributes like xml:space aren't the value
  parseTagValue: false, // keep a numeric-looking name as a string
  processEntities: true, // decode the predefined XML entities (&amp; etc.)
  htmlEntities: true, // also decode numeric character references like &#233;
});

export function extractAuthor(bytes: Uint8Array): string | null {
  let xml: string;
  try {
    const files = safeUnzip(bytes);
    const core = files['docProps/core.xml'];
    if (!core) return null;
    xml = strFromU8(core);
  } catch {
    return null;
  }

  let doc: Record<string, unknown>;
  try {
    doc = metaParser.parse(xml) as Record<string, unknown>;
  } catch {
    return null;
  }
  const root = doc['cp:coreProperties'];
  const props = (root && typeof root === 'object' ? root : doc) as Record<string, unknown>;
  // Prefer the last editor; fall back to the creator only when the tag is
  // absent (?? leaves an explicitly-empty lastModifiedBy as null, matching the
  // prior behavior). The parser has already decoded entities, named and numeric.
  const value = props['cp:lastModifiedBy'] ?? props['dc:creator'];
  const author = typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
  return author || null;
}
