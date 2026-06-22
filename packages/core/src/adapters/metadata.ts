import { strFromU8 } from 'fflate';
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
  const match =
    /<cp:lastModifiedBy>([\s\S]*?)<\/cp:lastModifiedBy>/.exec(xml) ?? /<dc:creator>([\s\S]*?)<\/dc:creator>/.exec(xml);
  const raw = match?.[1]?.trim();
  if (!raw) return null;
  return raw
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
