import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { diffModels } from '@docgit/core/diff';
import { DiffView } from '../src/index.js';

const para = (text: string) => ({ type: 'paragraph' as const, text });

describe('DiffView', () => {
  it('exposes the old/new side labels and shows changed text', () => {
    const before = { kind: 'text' as const, blocks: [para('keep'), para('old wording here')] };
    const after = { kind: 'text' as const, blocks: [para('keep'), para('brand new wording')] };
    render(<DiffView diff={diffModels(before, after)} oldLabel="version 1" newLabel="version 2" />);

    // #70: column labels are no longer aria-hidden — they're in the DOM/AT tree.
    expect(screen.getByText('version 1')).toBeTruthy();
    expect(screen.getByText('version 2')).toBeTruthy();
    // The modified paragraph's new text is rendered.
    expect(screen.getByText(/brand new wording/)).toBeTruthy();
  });

  it('renders a spreadsheet diff with the changed cell', () => {
    const before = { kind: 'spreadsheet' as const, sheets: [{ name: 'Sheet1', cells: { A1: { v: '1' } } }] };
    const after = { kind: 'spreadsheet' as const, sheets: [{ name: 'Sheet1', cells: { A1: { v: '2' } } }] };
    render(<DiffView diff={diffModels(before, after)} oldLabel="old" newLabel="new" />);

    expect(screen.getByText('A1')).toBeTruthy(); // the changed cell ref
    expect(screen.getByText('2')).toBeTruthy(); // its new value
  });

  it('renders a slides diff summary', () => {
    const before = { kind: 'slides' as const, slides: [{ id: '256', shapes: [{ name: 'T', text: 'one' }] }] };
    const after = { kind: 'slides' as const, slides: [{ id: '256', shapes: [{ name: 'T', text: 'two' }] }] };
    render(<DiffView diff={diffModels(before, after)} oldLabel="a" newLabel="b" />);

    expect(screen.getByText(/two/)).toBeTruthy(); // the edited shape text
  });
});
