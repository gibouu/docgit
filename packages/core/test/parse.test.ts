import { describe, expect, it } from 'vitest';
import { parseDocx } from '../src/index.js';
import { docxFromParagraphs, makeDocx, p } from './helpers/makeDocx.js';

describe('Word adapter — parseDocx', () => {
  it('parses plain paragraphs in order', () => {
    const model = parseDocx(docxFromParagraphs(['First', 'Second', 'Third']));
    expect(model.kind).toBe('text');
    expect(model.blocks).toEqual([
      { type: 'paragraph', text: 'First' },
      { type: 'paragraph', text: 'Second' },
      { type: 'paragraph', text: 'Third' },
    ]);
  });

  it('concatenates split runs (Word fragments text arbitrarily)', () => {
    const body = `<w:p><w:r><w:t xml:space="preserve">Hello </w:t></w:r><w:r><w:t>wor</w:t></w:r><w:r><w:t>ld</w:t></w:r></w:p>`;
    const model = parseDocx(makeDocx(body));
    expect(model.blocks[0]).toMatchObject({ text: 'Hello world' });
  });

  it('captures paragraph styles and numbering', () => {
    const body =
      p('Title here', { style: 'Heading1' }) +
      `<w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="3"/></w:numPr></w:pPr><w:r><w:t>List item</w:t></w:r></w:p>`;
    const model = parseDocx(makeDocx(body));
    expect(model.blocks[0]).toMatchObject({ style: 'Heading1', text: 'Title here' });
    expect(model.blocks[1]).toMatchObject({
      text: 'List item',
      numbering: { numId: '3', level: 1 },
    });
  });

  it('converts tabs and breaks to whitespace characters', () => {
    const body = `<w:p><w:r><w:t>a</w:t><w:tab/><w:t>b</w:t><w:br/><w:t>c</w:t></w:r></w:p>`;
    const model = parseDocx(makeDocx(body));
    expect(model.blocks[0]).toMatchObject({ text: 'a\tb\nc' });
  });

  it('reads text inside hyperlinks', () => {
    const body = `<w:p><w:r><w:t xml:space="preserve">See </w:t></w:r><w:hyperlink r:id="rId9" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:r><w:t>our site</w:t></w:r></w:hyperlink></w:p>`;
    const model = parseDocx(makeDocx(body));
    expect(model.blocks[0]).toMatchObject({ text: 'See our site' });
  });

  it('resolves tracked changes to the final document state (w:ins kept, w:del dropped)', () => {
    const body = `<w:p>
      <w:r><w:t xml:space="preserve">The fee is </w:t></w:r>
      <w:del w:id="1" w:author="A"><w:r><w:delText>5000</w:delText></w:r></w:del>
      <w:ins w:id="2" w:author="A"><w:r><w:t>7500</w:t></w:r></w:ins>
      <w:r><w:t xml:space="preserve"> euros.</w:t></w:r>
    </w:p>`;
    const model = parseDocx(makeDocx(body));
    expect(model.blocks[0]).toMatchObject({ text: 'The fee is 7500 euros.' });
  });

  it('parses tables into rows of cell text', () => {
    const body = `<w:tbl>
      <w:tr><w:tc>${p('Name')}</w:tc><w:tc>${p('Amount')}</w:tc></w:tr>
      <w:tr><w:tc>${p('Acme')}</w:tc><w:tc>${p('€1,200')}</w:tc></w:tr>
    </w:tbl>`;
    const model = parseDocx(makeDocx(body));
    expect(model.blocks[0]).toEqual({
      type: 'table',
      rows: [
        ['Name', 'Amount'],
        ['Acme', '€1,200'],
      ],
    });
  });

  it('joins multi-paragraph cells with newlines', () => {
    const body = `<w:tbl><w:tr><w:tc>${p('line one')}${p('line two')}</w:tc></w:tr></w:tbl>`;
    const model = parseDocx(makeDocx(body));
    expect(model.blocks[0]).toEqual({ type: 'table', rows: [['line one\nline two']] });
  });

  it('rejects files without word/document.xml', () => {
    expect(() => parseDocx(new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)]))).toThrow(
      /document\.xml/,
    );
  });

  it('parses text inside a block-level content control (w:sdt) (#71)', () => {
    const body = `<w:sdt><w:sdtContent><w:p><w:r><w:t>Inside a control</w:t></w:r></w:p></w:sdtContent></w:sdt>`;
    const model = parseDocx(makeDocx(body));
    expect(model.blocks.map((b) => ('text' in b ? b.text : ''))).toContain('Inside a control');
  });

  it('excludes tracked move-from content from final-state text (#72)', () => {
    const body =
      `<w:p><w:moveFrom><w:r><w:t>moved sentence</w:t></w:r></w:moveFrom></w:p>` +
      `<w:p><w:moveTo><w:r><w:t>moved sentence</w:t></w:r></w:moveTo></w:p>`;
    const texts = parseDocx(makeDocx(body)).blocks.map((b) => ('text' in b ? b.text : ''));
    expect(texts.filter((t) => t === 'moved sentence')).toHaveLength(1); // moveTo kept, not duplicated
    expect(texts[0]).toBe(''); // the move-from paragraph has no final text
  });
});
