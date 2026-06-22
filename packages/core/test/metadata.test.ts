import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { extractAuthor } from '../src/index.js';

function docWithCore(coreXml: string): Uint8Array {
  return zipSync({ 'docProps/core.xml': strToU8(coreXml) });
}

const wrap = (inner: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">${inner}</cp:coreProperties>`;

describe('extractAuthor', () => {
  it('reads cp:lastModifiedBy', () => {
    const bytes = docWithCore(wrap('<dc:creator>Original Author</dc:creator><cp:lastModifiedBy>Marie Dupont</cp:lastModifiedBy>'));
    expect(extractAuthor(bytes)).toBe('Marie Dupont');
  });

  it('falls back to dc:creator when lastModifiedBy is absent', () => {
    expect(extractAuthor(docWithCore(wrap('<dc:creator>Gibril B.</dc:creator>')))).toBe('Gibril B.');
  });

  it('decodes XML entities in names', () => {
    expect(extractAuthor(docWithCore(wrap('<cp:lastModifiedBy>Smith &amp; Co.</cp:lastModifiedBy>')))).toBe('Smith & Co.');
  });

  it('decodes numeric character references (#110)', () => {
    expect(extractAuthor(docWithCore(wrap('<cp:lastModifiedBy>Ren&#233;</cp:lastModifiedBy>')))).toBe('René');
  });

  it('extracts the name even when the element carries attributes (#110)', () => {
    expect(extractAuthor(docWithCore(wrap('<cp:lastModifiedBy xml:space="preserve">Marie</cp:lastModifiedBy>')))).toBe('Marie');
  });

  it('returns null when the field is empty or missing', () => {
    expect(extractAuthor(docWithCore(wrap('<cp:lastModifiedBy></cp:lastModifiedBy>')))).toBeNull();
    expect(extractAuthor(docWithCore(wrap('')))).toBeNull();
  });

  it('returns null for files without docProps/core.xml or non-zips', () => {
    expect(extractAuthor(zipSync({ 'word/document.xml': strToU8('<x/>') }))).toBeNull();
    expect(extractAuthor(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});
