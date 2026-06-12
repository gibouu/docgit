import type { CellValue, SheetModel, SpreadsheetModel } from '../../model/types.js';

/**
 * Grist adapter — reads a Grist document over its REST API and reduces it to
 * the normalized spreadsheet model.
 *
 * Mapping: each table becomes a sheet; each record field becomes a cell with
 * ref "ColumnId:rowId" (row *ids* are stable in Grist, so row reordering
 * never reads as mass cell changes). Formula columns put the column formula
 * on each of their cells, so the diff distinguishes "the calculation
 * changed" from "a value changed" exactly like the Excel adapter.
 *
 * Remote documents are read-only for DocGit: we snapshot and diff them, and
 * they can feed live links — we never write back to the server.
 */

export interface GristConfig {
  /** e.g. http://localhost:8484 or https://docs.getgrist.com */
  baseUrl: string;
  docId: string;
  apiKey?: string;
  /** Injectable for tests. */
  fetchFn?: typeof fetch;
}

interface GristTable {
  id: string;
}

interface GristColumn {
  id: string;
  fields?: { formula?: string; isFormula?: boolean };
}

interface GristRecord {
  id: number;
  fields: Record<string, unknown>;
}

export class GristClient {
  private base: string;
  private fetchFn: typeof fetch;

  constructor(private config: GristConfig) {
    this.base = `${config.baseUrl.replace(/\/+$/, '')}/api/docs/${encodeURIComponent(config.docId)}`;
    this.fetchFn = config.fetchFn ?? fetch;
  }

  private async get<T>(path: string): Promise<T> {
    const response = await this.fetchFn(`${this.base}${path}`, {
      headers: this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {},
    });
    if (!response.ok) {
      throw new Error(`Grist API ${path} failed: ${response.status} ${response.statusText}`);
    }
    return (await response.json()) as T;
  }

  /** The document reduced to the normalized spreadsheet model. */
  async fetchModel(): Promise<SpreadsheetModel> {
    const { tables } = await this.get<{ tables: GristTable[] }>('/tables');
    const sheets: SheetModel[] = [];
    for (const table of tables) {
      const [{ columns }, { records }] = await Promise.all([
        this.get<{ columns: GristColumn[] }>(`/tables/${encodeURIComponent(table.id)}/columns`),
        this.get<{ records: GristRecord[] }>(`/tables/${encodeURIComponent(table.id)}/records`),
      ]);
      const formulaByColumn = new Map<string, string>();
      for (const column of columns) {
        if (column.fields?.isFormula && column.fields.formula) {
          formulaByColumn.set(column.id, `=${column.fields.formula}`);
        }
      }
      const cells: Record<string, CellValue> = {};
      for (const record of records) {
        for (const [columnId, raw] of Object.entries(record.fields)) {
          const value = raw === null || raw === undefined ? '' : String(raw);
          const formula = formulaByColumn.get(columnId);
          if (value === '' && !formula) continue;
          const entry: CellValue = { v: value };
          if (formula) entry.f = formula;
          cells[`${columnId}:${record.id}`] = entry;
        }
      }
      sheets.push({ name: table.id, cells });
    }
    return { kind: 'spreadsheet', sheets };
  }

  /** Full-fidelity snapshot bytes: the .grist SQLite file. */
  async downloadBytes(): Promise<Uint8Array> {
    const response = await this.fetchFn(`${this.base}/download`, {
      headers: this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {},
    });
    if (!response.ok) throw new Error(`Grist download failed: ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }
}
