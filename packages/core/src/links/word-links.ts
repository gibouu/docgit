import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

/**
 * Surgical edits to word/document.xml for live-linked values.
 *
 * A linked value lives inside an inline content control (w:sdt) whose tag is
 * `docgit-link:<id>`. Word preserves content controls through edits and
 * saves, so the link survives the user's normal workflow, and refreshing is
 * a deterministic "find the tag, replace the text inside" operation.
 *
 * The surgery is string-level on document.xml — no XML re-serialization of
 * the whole document, so untouched parts stay byte-identical. MVP limit:
 * a value can only be linked when it sits inside a single run containing
 * nothing but text (true for typical inline numbers); occurrences split
 * across runs are not offered.
 */

export interface LinkableOccurrence {
  /** Index into the list of linkable occurrences — pass back to insertLinkedValue. */
  occurrence: number;
  /** Text around the match for the picker UI. */
  context: string;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

interface RawOccurrence {
  runStart: number;
  runEnd: number; // index after </w:r>
  rPr: string;
  before: string;
  match: string;
  after: string;
}

const T_RE = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;

/**
 * Find occurrences of `search` that are eligible for linking: inside a w:t
 * whose run contains only that text (plus run properties).
 */
function scan(xml: string, search: string): RawOccurrence[] {
  const out: RawOccurrence[] = [];
  T_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = T_RE.exec(xml))) {
    const content = m[1]!;
    const text = unescapeXml(content);
    let from = 0;
    let hit: number;
    while ((hit = text.indexOf(search, from)) >= 0) {
      from = hit + Math.max(search.length, 1);
      const tStart = m.index;
      // Enclosing run: nearest <w:r before the w:t, closing </w:r> after it.
      const runStart = Math.max(xml.lastIndexOf('<w:r>', tStart), xml.lastIndexOf('<w:r ', tStart));
      const runClose = xml.indexOf('</w:r>', tStart);
      if (runStart < 0 || runClose < 0) continue;
      const runEnd = runClose + '</w:r>'.length;
      const runXml = xml.slice(runStart, runEnd);
      const rPr = /<w:rPr>[\s\S]*?<\/w:rPr>/.exec(runXml)?.[0] ?? '';
      // Eligibility: the run holds exactly this one w:t and nothing else.
      const runInner = runXml.replace(/^<w:r(?:\s[^>]*)?>/, '').replace(/<\/w:r>$/, '');
      const withoutRpr = rPr ? runInner.replace(rPr, '') : runInner;
      if (withoutRpr.trim() !== xml.slice(tStart, xml.indexOf('</w:t>', tStart) + '</w:t>'.length)) {
        // The run carries siblings (tabs, breaks, multiple w:t) — skip.
        continue;
      }
      out.push({
        runStart,
        runEnd,
        rPr,
        before: text.slice(0, hit),
        match: search,
        after: text.slice(hit + search.length),
      });
    }
  }
  return out;
}

function withDocumentXml(docx: Uint8Array, mutate: (xml: string) => string | null): Uint8Array | null {
  const files = unzipSync(docx);
  const part = files['word/document.xml'];
  if (!part) throw new Error('Not a valid .docx file: missing word/document.xml');
  const next = mutate(strFromU8(part));
  if (next === null) return null;
  files['word/document.xml'] = strToU8(next);
  return zipSync(files);
}

export function findLinkableOccurrences(docx: Uint8Array, search: string): LinkableOccurrence[] {
  if (!search) return [];
  const files = unzipSync(docx);
  const part = files['word/document.xml'];
  if (!part) throw new Error('Not a valid .docx file: missing word/document.xml');
  return scan(strFromU8(part), search).map((occ, i) => ({
    occurrence: i,
    context: `${occ.before.slice(-60)}«${occ.match}»${occ.after.slice(0, 60)}`,
  }));
}

/**
 * Wrap the chosen occurrence in a tagged content control, replacing the
 * matched text with `displayValue`. Returns null when the occurrence no
 * longer exists (document changed since the picker was shown).
 */
/**
 * The one supported link-id grammar (lowercase hex + hyphens, as produced by
 * randomUUID and recognized by listLinkIds). Ids are interpolated into XML
 * attributes and used as search keys, so anything outside this grammar — XML
 * metacharacters, whitespace — is rejected rather than escaped, keeping
 * insert / refresh / list perfectly consistent.
 */
const LINK_ID_RE = /^[0-9a-f-]+$/;

function assertLinkId(linkId: string): void {
  if (!LINK_ID_RE.test(linkId)) throw new Error(`Invalid link id: ${JSON.stringify(linkId)}`);
}

export function insertLinkedValue(
  docx: Uint8Array,
  search: string,
  occurrence: number,
  linkId: string,
  displayValue: string,
): Uint8Array | null {
  assertLinkId(linkId);
  return withDocumentXml(docx, (xml) => {
    const occ = scan(xml, search)[occurrence];
    if (!occ) return null;
    const run = (text: string) => `<w:r>${occ.rPr}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
    const sdt =
      `<w:sdt><w:sdtPr><w:alias w:val="DocGit linked value"/><w:tag w:val="docgit-link:${linkId}"/></w:sdtPr>` +
      `<w:sdtContent>${run(displayValue)}</w:sdtContent></w:sdt>`;
    const replacement = (occ.before ? run(occ.before) : '') + sdt + (occ.after ? run(occ.after) : '');
    return xml.slice(0, occ.runStart) + replacement + xml.slice(occ.runEnd);
  });
}

/**
 * Replace the text inside an existing link's content control.
 * Returns the new bytes plus the previous display value, or null when the
 * tag is gone (user deleted the control in Word).
 */
export function refreshLinkedValue(
  docx: Uint8Array,
  linkId: string,
  newValue: string,
): { bytes: Uint8Array; oldValue: string } | null {
  assertLinkId(linkId);
  let oldValue = '';
  const bytes = withDocumentXml(docx, (xml) => {
    // Match the exact tag value (note the trailing quote that closes the
    // w:val attribute) so a short id can't prefix-match a longer one's control.
    const tagIdx = xml.indexOf(`docgit-link:${linkId}"`);
    if (tagIdx < 0) return null;
    const contentStart = xml.indexOf('<w:sdtContent>', tagIdx);
    const contentEnd = xml.indexOf('</w:sdtContent>', contentStart);
    if (contentStart < 0 || contentEnd < 0) return null;
    const inner = xml.slice(contentStart, contentEnd);
    // Word can split the linked value across several runs/text nodes. Read the
    // whole value (all <w:t> concatenated), put the new value in the FIRST run,
    // and blank the rest so no stale fragment is left behind.
    const texts: string[] = [];
    let placed = false;
    const newInner = inner.replace(/(<w:t(?:\s[^>]*)?>)([\s\S]*?)(<\/w:t>)/g, (_m, open, content, close) => {
      texts.push(unescapeXml(content));
      if (!placed) {
        placed = true;
        return `${open}${escapeXml(newValue)}${close}`; // function replacer: no $-substitution
      }
      return `${open}${close}`;
    });
    if (!placed) return null;
    oldValue = texts.join('');
    return xml.slice(0, contentStart) + newInner + xml.slice(contentEnd);
  });
  return bytes ? { bytes, oldValue } : null;
}

/** Link ids present in the document (tags the user hasn't deleted in Word). */
export function listLinkIds(docx: Uint8Array): string[] {
  const files = unzipSync(docx);
  const part = files['word/document.xml'];
  if (!part) return [];
  const xml = strFromU8(part);
  const ids: string[] = [];
  const re = /docgit-link:([0-9a-f-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) ids.push(m[1]!);
  return ids;
}
