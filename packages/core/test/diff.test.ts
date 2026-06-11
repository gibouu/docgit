import { describe, expect, it } from 'vitest';
import { diffModels, parseDocx, type DocModel } from '../src/index.js';
import { docxFromParagraphs, makeDocx } from './helpers/makeDocx.js';

const modelOf = (texts: string[]): DocModel => parseDocx(docxFromParagraphs(texts));

describe('diffModels — paragraph-level content diff', () => {
  it('reports identical documents as fully unchanged', () => {
    const m = modelOf(['a', 'b', 'c']);
    const { changes, summary } = diffModels(m, modelOf(['a', 'b', 'c']));
    expect(summary).toEqual({ added: 0, removed: 0, modified: 0, moved: 0, unchanged: 3, formatting: 0 });
    expect(changes.every((c) => c.type === 'unchanged')).toBe(true);
  });

  it('detects added and removed paragraphs with correct indices', () => {
    const oldM = modelOf(['intro', 'old clause', 'outro']);
    const newM = modelOf(['intro', 'outro', 'brand new annex about indemnities']);
    const { changes, summary } = diffModels(oldM, newM);
    expect(summary.added).toBe(1);
    expect(summary.removed).toBe(1);
    const removed = changes.find((c) => c.type === 'removed')!;
    const added = changes.find((c) => c.type === 'added')!;
    expect(removed.oldIndex).toBe(1);
    expect(added.newIndex).toBe(2);
  });

  it('classifies an edited paragraph as modified with word-level spans', () => {
    const oldM = modelOf(['The fee shall be 5000 euros payable within 30 days.']);
    const newM = modelOf(['The fee shall be 7500 euros payable within 45 days.']);
    const { changes, summary } = diffModels(oldM, newM);
    expect(summary).toMatchObject({ added: 0, removed: 0, modified: 1 });
    const spans = changes[0]!.spans!;
    expect(spans.some((s) => s.kind === 'removed' && s.text.includes('5000'))).toBe(true);
    expect(spans.some((s) => s.kind === 'added' && s.text.includes('7500'))).toBe(true);
    expect(spans.some((s) => s.kind === 'same' && s.text.includes('euros payable within'))).toBe(true);
  });

  it('does not pair unrelated replaced paragraphs as modified', () => {
    const oldM = modelOf(['Governing law: France.']);
    const newM = modelOf(['Bananas are an excellent source of potassium.']);
    const { summary } = diffModels(oldM, newM);
    expect(summary).toMatchObject({ added: 1, removed: 1, modified: 0 });
  });

  it('detects a moved paragraph instead of reporting remove + add (adversarial: reordering)', () => {
    const clause = 'Clause 7: Either party may terminate with 60 days written notice.';
    const oldM = modelOf([clause, 'a', 'b', 'c']);
    const newM = modelOf(['a', 'b', 'c', clause]);
    const { changes, summary } = diffModels(oldM, newM);
    expect(summary).toMatchObject({ added: 0, removed: 0, moved: 1, unchanged: 3 });
    const moved = changes.find((c) => c.type === 'moved')!;
    expect(moved.oldIndex).toBe(0);
    expect(moved.newIndex).toBe(3);
  });

  it('does not treat empty paragraphs as moves', () => {
    const oldM = modelOf(['', 'content', '']);
    const newM = modelOf(['content', '', '', 'extra']);
    const { summary } = diffModels(oldM, newM);
    expect(summary.moved).toBe(0);
  });

  it('handles mixed hunks: one edit plus one insertion in the same region', () => {
    const oldM = modelOf(['header', 'The price is 100.', 'footer']);
    const newM = modelOf(['header', 'The price is 200.', 'A new delivery clause.', 'footer']);
    const { summary } = diffModels(oldM, newM);
    expect(summary).toMatchObject({ added: 1, removed: 0, modified: 1, unchanged: 2 });
  });

  it('diffs table content (adversarial: tables reduce to row text)', () => {
    const withTable = (amount: string): DocModel => ({
      kind: 'text',
      blocks: [
        { type: 'paragraph', text: 'Pricing:' },
        { type: 'table', rows: [['Item', 'Amount'], ['License', amount]] },
      ],
    });
    const { changes, summary } = diffModels(withTable('€1,000'), withTable('€1,200'));
    expect(summary).toMatchObject({ modified: 1, unchanged: 1 });
    expect(changes.find((c) => c.type === 'modified')!.newBlock!.type).toBe('table');
  });

  it('treats numbering text changes as paragraph modifications (adversarial: renumbering)', () => {
    const oldM = modelOf(['1. Scope', '2. Fees', '3. Term']);
    const newM = modelOf(['1. Scope', '2. Definitions', '3. Fees', '4. Term']);
    const { summary } = diffModels(oldM, newM);
    // "2. Definitions" inserted; "2. Fees"→"3. Fees" and "3. Term"→"4. Term" are renumber edits.
    expect(summary.unchanged).toBe(1);
    expect(summary.added + summary.modified).toBe(3);
    expect(summary.removed).toBe(0);
  });

  it('diffs tracked-changes documents by their final state (adversarial: revision artifacts)', () => {
    const accepted = modelOf(['The fee is 7500 euros.']);
    // Same final content, but expressed as pending track-changes markup.
    const tracked = parseDocx(
      makeDocx(`<w:p>
        <w:r><w:t xml:space="preserve">The fee is </w:t></w:r>
        <w:del w:id="1" w:author="A"><w:r><w:delText>5000</w:delText></w:r></w:del>
        <w:ins w:id="2" w:author="A"><w:r><w:t>7500</w:t></w:r></w:ins>
        <w:r><w:t xml:space="preserve"> euros.</w:t></w:r>
      </w:p>`),
    );
    const { summary } = diffModels(accepted, tracked);
    expect(summary).toMatchObject({ added: 0, removed: 0, modified: 0, unchanged: 1 });
  });

  it('reports style-only changes as formatting, keeping content unchanged primary', () => {
    const styled = (style?: string): DocModel => ({
      kind: 'text',
      blocks: [{ type: 'paragraph', text: 'Same exact words.', ...(style ? { style } : {}) }],
    });
    const { changes, summary } = diffModels(styled('Normal'), styled('Heading1'));
    expect(summary).toMatchObject({ added: 0, removed: 0, modified: 0, unchanged: 1, formatting: 1 });
    expect(changes[0]!.formatting).toEqual({ fromStyle: 'Normal', toStyle: 'Heading1' });
  });

  it('meets the performance bar: two ~1500-paragraph documents diff in under 2s', () => {
    const size = 1500;
    const oldTexts = Array.from(
      { length: size },
      (_, i) => `Clause ${i}: the parties agree to obligation number ${i} under this agreement.`,
    );
    const newTexts = oldTexts.map((t, i) => (i % 10 === 0 ? `${t} (as amended)` : t));
    // Sprinkle structural changes: deletions, insertions, and a move.
    newTexts.splice(100, 5);
    newTexts.splice(700, 0, 'A brand new clause about data protection.', 'Another new clause.');
    newTexts.push(oldTexts[50]!);

    const oldM: DocModel = { kind: 'text', blocks: oldTexts.map((text) => ({ type: 'paragraph', text })) };
    const newM: DocModel = { kind: 'text', blocks: newTexts.map((text) => ({ type: 'paragraph', text })) };

    const start = performance.now();
    const { summary } = diffModels(oldM, newM);
    const elapsed = performance.now() - start;

    expect(summary.modified).toBeGreaterThan(100);
    expect(elapsed).toBeLessThan(2000);
  });
});
