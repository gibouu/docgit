import { describe, expect, it } from 'vitest';
import { diffModels, parseDocument, parsePptx } from '../src/index.js';
import { makePptx } from './helpers/makePptx.js';

describe('PowerPoint adapter — parsePptx', () => {
  it('parses slides in order with persistent ids and named shapes', () => {
    const model = parsePptx(
      makePptx([
        { id: '256', shapes: [{ name: 'Title 1', text: 'Q3 results' }, { name: 'Body 1', text: 'Revenue up 12%' }] },
        { id: '257', shapes: [{ name: 'Title 1', text: 'Outlook' }] },
      ]),
    );
    expect(model.kind).toBe('slides');
    expect(model.slides.map((s) => s.id)).toEqual(['256', '257']);
    expect(model.slides[0]!.shapes).toEqual([
      { name: 'Title 1', text: 'Q3 results' },
      { name: 'Body 1', text: 'Revenue up 12%' },
    ]);
  });

  it('joins multi-paragraph shape text with newlines and skips empty shapes', () => {
    const model = parsePptx(
      makePptx([{ shapes: [{ name: 'Body', text: 'line one\nline two' }, { name: 'Empty', text: '' }] }]),
    );
    expect(model.slides[0]!.shapes).toEqual([{ name: 'Body', text: 'line one\nline two' }]);
  });

  it('dispatches .pptx through parseDocument', () => {
    const bytes = makePptx([{ shapes: [{ name: 'T', text: 'x' }] }]);
    expect(parseDocument('/tmp/deck.pptx', bytes).kind).toBe('slides');
  });

  it('rejects non-pptx zips', () => {
    expect(() => parsePptx(new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)]))).toThrow(
      /presentation\.xml/,
    );
  });
});

describe('slides diff', () => {
  it('reports edited shape text as a modified slide with word spans', () => {
    const oldM = parsePptx(makePptx([{ id: '256', shapes: [{ name: 'Title 1', text: 'Revenue up 12%' }] }]));
    const newM = parsePptx(makePptx([{ id: '256', shapes: [{ name: 'Title 1', text: 'Revenue up 18%' }] }]));
    const diff = diffModels(oldM, newM);
    if (diff.kind !== 'slides') throw new Error('expected slides diff');
    expect(diff.summary).toMatchObject({ slidesModified: 1, slidesAdded: 0, slidesRemoved: 0, slidesMoved: 0 });
    const shape = diff.slideChanges[0]!.shapeChanges[0]!;
    expect(shape).toMatchObject({ type: 'modified', name: 'Title 1' });
    expect(shape.spans!.some((s) => s.kind === 'removed' && s.text.includes('12'))).toBe(true);
    expect(shape.spans!.some((s) => s.kind === 'added' && s.text.includes('18'))).toBe(true);
  });

  it('detects added and removed slides', () => {
    const oldM = parsePptx(makePptx([{ id: '256', shapes: [{ name: 'T', text: 'keep' }] }, { id: '257', shapes: [{ name: 'T', text: 'drop me' }] }]));
    const newM = parsePptx(
      makePptx([{ id: '256', shapes: [{ name: 'T', text: 'keep' }] }, { id: '300', shapes: [{ name: 'T', text: 'brand new' }] }]),
    );
    const diff = diffModels(oldM, newM);
    if (diff.kind !== 'slides') throw new Error('expected slides diff');
    expect(diff.summary).toMatchObject({ slidesAdded: 1, slidesRemoved: 1, slidesUnchanged: 1 });
    expect(diff.slideChanges.find((c) => c.type === 'added')!.slideId).toBe('300');
    expect(diff.slideChanges.find((c) => c.type === 'removed')!.slideId).toBe('257');
  });

  it('reports reordered slides as moved, not removed + added (adversarial: reorder)', () => {
    const a = { id: '1', shapes: [{ name: 'T', text: 'alpha' }] };
    const b = { id: '2', shapes: [{ name: 'T', text: 'beta' }] };
    const c = { id: '3', shapes: [{ name: 'T', text: 'gamma' }] };
    const diff = diffModels(parsePptx(makePptx([a, b, c])), parsePptx(makePptx([c, a, b])));
    if (diff.kind !== 'slides') throw new Error('expected slides diff');
    expect(diff.summary.slidesAdded).toBe(0);
    expect(diff.summary.slidesRemoved).toBe(0);
    expect(diff.summary.slidesMoved).toBeGreaterThan(0);
    const moved = diff.slideChanges.find((ch) => ch.slideId === '3')!;
    expect(moved).toMatchObject({ type: 'moved', oldIndex: 2, newIndex: 0 });
  });

  it('detects shapes added to an existing slide', () => {
    const oldM = parsePptx(makePptx([{ id: '256', shapes: [{ name: 'Title 1', text: 'Hello' }] }]));
    const newM = parsePptx(
      makePptx([{ id: '256', shapes: [{ name: 'Title 1', text: 'Hello' }, { name: 'Notes 1', text: 'Speaker note' }] }]),
    );
    const diff = diffModels(oldM, newM);
    if (diff.kind !== 'slides') throw new Error('expected slides diff');
    expect(diff.slideChanges[0]!.shapeChanges).toEqual([
      { type: 'added', name: 'Notes 1', newText: 'Speaker note' },
    ]);
  });

  it('counts shapes of added and removed slides in shapesChanged (#108)', () => {
    const before = { kind: 'slides' as const, slides: [{ id: '256', shapes: [] }] };
    const after = {
      kind: 'slides' as const,
      slides: [
        { id: '256', shapes: [] },
        { id: '257', shapes: [{ name: 'a', text: 'x' }, { name: 'b', text: 'y' }] },
      ],
    };
    const diff = diffModels(before, after);
    if (diff.kind !== 'slides') throw new Error('expected a slides diff');
    expect(diff.summary.shapesChanged).toBe(2); // both shapes of the added slide count
  });

  it('matches duplicate-named shapes by occurrence, not collapsing them (#100)', () => {
    const before = {
      kind: 'slides' as const,
      slides: [{ id: '256', shapes: [{ name: 'Body', text: 'A' }, { name: 'Body', text: 'B' }] }],
    };
    const after = { kind: 'slides' as const, slides: [{ id: '256', shapes: [{ name: 'Body', text: 'A' }] }] };
    const diff = diffModels(before, after);
    if (diff.kind !== 'slides') throw new Error('expected a slides diff');
    const shapeChanges = diff.slideChanges[0]!.shapeChanges;
    expect(shapeChanges).toHaveLength(1);
    expect(shapeChanges[0]).toMatchObject({ type: 'removed', name: 'Body', oldText: 'B' });
  });

  it('reports a reordered + edited slide as both moved and modified (#105)', () => {
    const before = {
      kind: 'slides' as const,
      slides: [
        { id: '256', shapes: [{ name: 'T', text: 'one' }] },
        { id: '257', shapes: [{ name: 'T', text: 'two' }] },
      ],
    };
    const after = {
      kind: 'slides' as const,
      slides: [
        { id: '257', shapes: [{ name: 'T', text: 'TWO' }] }, // moved to index 0 AND text changed
        { id: '256', shapes: [{ name: 'T', text: 'one' }] },
      ],
    };
    const diff = diffModels(before, after);
    if (diff.kind !== 'slides') throw new Error('expected a slides diff');
    const slide257 = diff.slideChanges.find((s) => s.slideId === '257')!;
    expect(slide257.moved).toBe(true);
    expect(slide257.shapeChanges.length).toBeGreaterThan(0); // also modified
    expect(diff.summary.slidesMoved).toBeGreaterThanOrEqual(1);
  });
});
