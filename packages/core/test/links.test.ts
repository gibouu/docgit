import { describe, expect, it } from 'vitest';
import {
  findLinkableOccurrences,
  formatValue,
  insertLinkedValue,
  listLinkIds,
  parseDocx,
  refreshLinkedValue,
} from '../src/index.js';
import { docxFromParagraphs, makeDocx, p } from './helpers/makeDocx.js';

const LINK_ID = 'aaaaaaaa-1111-2222-3333-bbbbbbbbcccc';

describe('formatValue', () => {
  it('formats currency per locale', () => {
    expect(formatValue('1200000', { style: 'currency', currency: 'USD', locale: 'en-US', decimals: 0 })).toBe(
      '$1,200,000',
    );
    const fr = formatValue('1200000', { style: 'currency', currency: 'EUR', locale: 'fr-FR', decimals: 0 });
    expect(fr).toMatch(/1.200.000.€/); // NBSP group separators vary by ICU version
  });

  it('formats compact notation', () => {
    expect(formatValue('1200000', { style: 'number', locale: 'en-US', compact: true })).toBe('1.2M');
  });

  it('formats percentages', () => {
    expect(formatValue('0.35', { style: 'percent', locale: 'en-US' })).toBe('35%');
  });

  it('passes through raw style and non-numeric values', () => {
    expect(formatValue('1200', { style: 'raw' })).toBe('1200');
    expect(formatValue('N/A', { style: 'currency', currency: 'EUR' })).toBe('N/A');
  });

  it('requires an explicit currency for currency style (#115)', () => {
    expect(() => formatValue('1200', { style: 'currency', locale: 'en-US' })).toThrow(/currency code is required/);
  });
});

describe('word link surgery', () => {
  const doc = docxFromParagraphs(['Intro paragraph.', 'We forecast revenue of 1000000 in 2027.', 'Outro.']);

  it('finds linkable occurrences with context', () => {
    const occurrences = findLinkableOccurrences(doc, '1000000');
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]!.context).toContain('«1000000»');
    expect(occurrences[0]!.context).toContain('forecast revenue of');
  });

  it('wraps the occurrence in a tagged content control with the display value', () => {
    const bytes = insertLinkedValue(doc, '1000000', 0, LINK_ID, '€1.0M')!;
    expect(bytes).not.toBeNull();
    expect(listLinkIds(bytes)).toEqual([LINK_ID]);
    const model = parseDocx(bytes);
    expect(model.blocks[1]).toMatchObject({ text: 'We forecast revenue of €1.0M in 2027.' });
    // Other paragraphs untouched.
    expect(model.blocks[0]).toMatchObject({ text: 'Intro paragraph.' });
    expect(model.blocks[2]).toMatchObject({ text: 'Outro.' });
  });

  it('refreshes the linked value in place and reports the old one', () => {
    const linked = insertLinkedValue(doc, '1000000', 0, LINK_ID, '€1.0M')!;
    const refreshed = refreshLinkedValue(linked, LINK_ID, '€1.2M')!;
    expect(refreshed.oldValue).toBe('€1.0M');
    const model = parseDocx(refreshed.bytes);
    expect(model.blocks[1]).toMatchObject({ text: 'We forecast revenue of €1.2M in 2027.' });
    // Refresh again — idempotent surgery survives round trips.
    const again = refreshLinkedValue(refreshed.bytes, LINK_ID, '€1.5M')!;
    expect(again.oldValue).toBe('€1.2M');
    expect(parseDocx(again.bytes).blocks[1]).toMatchObject({ text: 'We forecast revenue of €1.5M in 2027.' });
  });

  it('returns null when the link tag was deleted from the document', () => {
    expect(refreshLinkedValue(doc, LINK_ID, 'x')).toBeNull();
  });

  it('preserves run formatting properties on the split runs', () => {
    const body = `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Total: 500 euros</w:t></w:r></w:p>`;
    const bytes = insertLinkedValue(makeDocx(body), '500', 0, LINK_ID, '750')!;
    const model = parseDocx(bytes);
    expect(model.blocks[0]).toMatchObject({ text: 'Total: 750 euros' });
  });

  it('skips occurrences in runs that carry non-text content', () => {
    const body = `<w:p><w:r><w:t>before</w:t><w:tab/><w:t>target 42</w:t></w:r></w:p>${p('clean 42 here')}`;
    const occurrences = findLinkableOccurrences(makeDocx(body), '42');
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]!.context).toContain('clean');
  });

  it('escapes XML-significant characters in values', () => {
    const linked = insertLinkedValue(doc, '1000000', 0, LINK_ID, '<1 & 2>')!;
    expect(parseDocx(linked).blocks[1]).toMatchObject({ text: 'We forecast revenue of <1 & 2> in 2027.' });
    const refreshed = refreshLinkedValue(linked, LINK_ID, '"$5" <ok>')!;
    expect(parseDocx(refreshed.bytes).blocks[1]).toMatchObject({ text: 'We forecast revenue of "$5" <ok> in 2027.' });
  });

  it('rejects link ids outside the supported grammar (#106)', () => {
    const bad = 'abc"/><script>';
    expect(() => insertLinkedValue(doc, '1000000', 0, bad, 'x')).toThrow(/Invalid link id/);
    expect(() => refreshLinkedValue(doc, bad, 'x')).toThrow(/Invalid link id/);
  });

  it('refreshes by exact id, not a prefix match (#106)', () => {
    // A link whose id has 'abc' as a prefix must not be hit by refreshing 'abc'.
    const linked = insertLinkedValue(doc, '1000000', 0, 'abcdef', '€1.0M')!;
    expect(refreshLinkedValue(linked, 'abc', 'WRONG')).toBeNull(); // no exact 'abc' control
    const right = refreshLinkedValue(linked, 'abcdef', '€2.0M')!;
    expect(parseDocx(right.bytes).blocks[1]).toMatchObject({ text: 'We forecast revenue of €2.0M in 2027.' });
  });
});
