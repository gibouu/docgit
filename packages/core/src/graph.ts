/** Minimal commit shape the graph ordering needs. */
export interface OrderableCommit {
  id: string;
  parentId: string | null;
  createdAt: string;
}

/**
 * Order commits so a parent always precedes its children (ancestry-aware),
 * breaking ties by `createdAt` then `id`. Sorting by timestamp alone can place
 * a child before its parent when timestamps tie, inputs arrive child-first, or
 * clocks skew — which makes the rendered graph contradict history. This is a
 * Kahn topological sort with a (createdAt, id) priority among ready nodes.
 */
export function topologicalCommitOrder<T extends OrderableCommit>(commits: T[]): T[] {
  const byId = new Map(commits.map((c) => [c.id, c]));
  const children = new Map<string, T[]>();
  const indegree = new Map<string, number>(commits.map((c) => [c.id, 0]));
  for (const c of commits) {
    if (c.parentId && byId.has(c.parentId)) {
      const list = children.get(c.parentId);
      if (list) list.push(c);
      else children.set(c.parentId, [c]);
      indegree.set(c.id, (indegree.get(c.id) ?? 0) + 1);
    }
  }

  const cmp = (a: T, b: T): number =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

  const ready = commits.filter((c) => (indegree.get(c.id) ?? 0) === 0);
  const out: T[] = [];
  while (ready.length) {
    ready.sort(cmp); // small graphs; re-sort keeps the next-oldest-ready first
    const next = ready.shift()!;
    out.push(next);
    for (const kid of children.get(next.id) ?? []) {
      const d = (indegree.get(kid.id) ?? 1) - 1;
      indegree.set(kid.id, d);
      if (d === 0) ready.push(kid);
    }
  }
  // Any commits left unreached (a cycle — shouldn't happen) appended in order.
  if (out.length < commits.length) {
    const seen = new Set(out.map((c) => c.id));
    out.push(...commits.filter((c) => !seen.has(c.id)).sort(cmp));
  }
  return out;
}
