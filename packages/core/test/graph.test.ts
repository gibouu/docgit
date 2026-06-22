import { describe, expect, it } from 'vitest';
import { topologicalCommitOrder } from '../src/index.js';

const c = (id: string, parentId: string | null, createdAt: string) => ({ id, parentId, createdAt });

describe('topologicalCommitOrder (#97)', () => {
  it('places a parent before a child even when the child has an earlier timestamp', () => {
    // Child created "before" parent (clock skew / equal stamp + child-first input).
    const commits = [c('child', 'parent', '2026-01-01T00:00:00Z'), c('parent', null, '2026-01-01T00:00:05Z')];
    const order = topologicalCommitOrder(commits).map((x) => x.id);
    expect(order.indexOf('parent')).toBeLessThan(order.indexOf('child'));
  });

  it('keeps a clean chain in ancestry order', () => {
    const commits = [c('c', 'b', 't3'), c('a', null, 't1'), c('b', 'a', 't2')];
    expect(topologicalCommitOrder(commits).map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });

  it('orders independent commits oldest-first', () => {
    const commits = [c('y', null, 't2'), c('x', null, 't1')];
    expect(topologicalCommitOrder(commits).map((x) => x.id)).toEqual(['x', 'y']);
  });

  it('returns every commit exactly once', () => {
    const commits = [c('a', null, 't1'), c('b', 'a', 't1'), c('d', 'a', 't1'), c('e', 'b', 't1')];
    const order = topologicalCommitOrder(commits);
    expect(new Set(order.map((x) => x.id)).size).toBe(4);
    // every parent precedes its children
    for (const x of order) {
      if (x.parentId) expect(order.findIndex((o) => o.id === x.parentId)).toBeLessThan(order.findIndex((o) => o.id === x.id));
    }
  });
});
