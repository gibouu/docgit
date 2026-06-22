import { describe, expect, it } from 'vitest';
import { diffModels, GristClient } from '../src/index.js';

/** Fetch stub returning documented Grist API shapes. */
function stubFetch(data: {
  tables: string[];
  columns: Record<string, { id: string; formula?: string }[]>;
  records: Record<string, { id: number; fields: Record<string, unknown> }[]>;
}): typeof fetch {
  return (async (url: string | URL) => {
    const path = String(url);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (path.endsWith('/tables')) return json({ tables: data.tables.map((id) => ({ id })) });
    const colMatch = /\/tables\/([^/]+)\/columns$/.exec(path);
    if (colMatch) {
      const cols = data.columns[decodeURIComponent(colMatch[1]!)] ?? [];
      return json({
        columns: cols.map((c) => ({ id: c.id, fields: c.formula ? { isFormula: true, formula: c.formula } : {} })),
      });
    }
    const recMatch = /\/tables\/([^/]+)\/records$/.exec(path);
    if (recMatch) return json({ records: data.records[decodeURIComponent(recMatch[1]!)] ?? [] });
    if (path.endsWith('/download')) return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

const config = (fetchFn: typeof fetch) => ({ baseUrl: 'http://grist.local', docId: 'doc1', fetchFn });

describe('Grist adapter', () => {
  it('maps tables to sheets and records to row-id-keyed cells', async () => {
    const client = new GristClient(
      config(
        stubFetch({
          tables: ['Forecast'],
          columns: { Forecast: [{ id: 'Item' }, { id: 'Amount' }] },
          records: {
            Forecast: [
              { id: 1, fields: { Item: 'Revenue', Amount: 1200 } },
              { id: 2, fields: { Item: 'Costs', Amount: 800 } },
            ],
          },
        }),
      ),
    );
    const model = await client.fetchModel();
    expect(model.kind).toBe('spreadsheet');
    expect(model.sheets[0]!.name).toBe('Forecast');
    expect(model.sheets[0]!.cells).toEqual({
      'Item:1': { v: 'Revenue' },
      'Amount:1': { v: '1200' },
      'Item:2': { v: 'Costs' },
      'Amount:2': { v: '800' },
    });
  });

  it('marks formula-column cells with the column formula', async () => {
    const client = new GristClient(
      config(
        stubFetch({
          tables: ['T'],
          columns: { T: [{ id: 'A' }, { id: 'Total', formula: '$A * 2' }] },
          records: { T: [{ id: 1, fields: { A: 10, Total: 20 } }] },
        }),
      ),
    );
    const model = await client.fetchModel();
    expect(model.sheets[0]!.cells['Total:1']).toEqual({ v: '20', f: '=$A * 2' });
  });

  it('diffs two Grist snapshots cell by cell with stable row identity', async () => {
    const before = await new GristClient(
      config(
        stubFetch({
          tables: ['T'],
          columns: { T: [{ id: 'Amount' }] },
          records: { T: [{ id: 1, fields: { Amount: 100 } }, { id: 2, fields: { Amount: 50 } }] },
        }),
      ),
    ).fetchModel();
    const after = await new GristClient(
      config(
        stubFetch({
          tables: ['T'],
          columns: { T: [{ id: 'Amount' }] },
          // Row 2 reordered first and row 1's value changed — row ids keep identity.
          records: { T: [{ id: 2, fields: { Amount: 50 } }, { id: 1, fields: { Amount: 150 } }] },
        }),
      ),
    ).fetchModel();
    const diff = diffModels(before, after);
    if (diff.kind !== 'spreadsheet') throw new Error('expected spreadsheet diff');
    expect(diff.summary).toMatchObject({ cellsModified: 1, cellsAdded: 0, cellsRemoved: 0, cellsUnchanged: 1 });
    expect(diff.cellChanges[0]).toMatchObject({ ref: 'Amount:1', oldValue: { v: '100' }, newValue: { v: '150' } });
  });

  it('downloads snapshot bytes and surfaces API errors', async () => {
    const client = new GristClient(config(stubFetch({ tables: [], columns: {}, records: {} })));
    expect(Array.from(await client.downloadBytes())).toEqual([1, 2, 3]);

    const failing = new GristClient({
      baseUrl: 'http://grist.local',
      docId: 'nope',
      fetchFn: (async () => new Response('denied', { status: 403, statusText: 'Forbidden' })) as typeof fetch,
    });
    await expect(failing.fetchModel()).rejects.toThrow(/403/);
  });

  it('preserves non-scalar field values as JSON, not [object Object] (#74)', async () => {
    const client = new GristClient(
      config(
        stubFetch({
          tables: ['T'],
          columns: { T: [{ id: 'Refs' }] },
          records: { T: [{ id: 1, fields: { Refs: ['L', 10, 20] } }] },
        }),
      ),
    );
    const model = await client.fetchModel();
    expect(model.sheets[0]!.cells['Refs:1']!.v).toBe('["L",10,20]');
  });

  it('aborts a request that exceeds the timeout (#102)', async () => {
    const hang: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        (init as RequestInit | undefined)?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const client = new GristClient({ baseUrl: 'http://grist.local', docId: 'd', fetchFn: hang, timeoutMs: 10 });
    await expect(client.fetchModel()).rejects.toThrow();
  });
});
