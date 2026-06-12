import { strToU8, zipSync } from 'fflate';
import { escapeXml } from './makeDocx.js';

/**
 * Build minimal but valid .xlsx fixtures in memory. Cells are given as
 * ref → string | number | { f: formula, v: cached value }.
 */

export type FixtureCell = string | number | { f: string; v?: string | number };
export type FixtureSheet = { name: string; cells: Record<string, FixtureCell> };

export function makeXlsx(sheets: FixtureSheet[]): Uint8Array {
  const shared: string[] = [];
  const sharedIndex = (text: string): number => {
    const existing = shared.indexOf(text);
    if (existing >= 0) return existing;
    shared.push(text);
    return shared.length - 1;
  };

  const files: Record<string, Uint8Array> = {};
  const sheetEntries: string[] = [];
  const relEntries: string[] = [];

  sheets.forEach((sheet, i) => {
    const n = i + 1;
    sheetEntries.push(`<sheet name="${escapeXml(sheet.name)}" sheetId="${n}" r:id="rId${n}"/>`);
    relEntries.push(
      `<Relationship Id="rId${n}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${n}.xml"/>`,
    );

    const byRow = new Map<number, string[]>();
    for (const [ref, cell] of Object.entries(sheet.cells)) {
      const row = Number(/\d+/.exec(ref)?.[0] ?? '1');
      let xml: string;
      if (typeof cell === 'object') {
        const cached = cell.v !== undefined ? `<v>${escapeXml(String(cell.v))}</v>` : '';
        xml = `<c r="${ref}"><f>${escapeXml(cell.f)}</f>${cached}</c>`;
      } else if (typeof cell === 'number') {
        xml = `<c r="${ref}"><v>${cell}</v></c>`;
      } else {
        xml = `<c r="${ref}" t="s"><v>${sharedIndex(cell)}</v></c>`;
      }
      const list = byRow.get(row) ?? [];
      list.push(xml);
      byRow.set(row, list);
    }
    const rows = [...byRow.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([r, cellsXml]) => `<row r="${r}">${cellsXml.join('')}</row>`)
      .join('');

    files[`xl/worksheets/sheet${n}.xml`] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`,
    );
  });

  files['xl/workbook.xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetEntries.join('')}</sheets></workbook>`,
  );
  files['xl/_rels/workbook.xml.rels'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relEntries.join('')}</Relationships>`,
  );
  files['xl/sharedStrings.xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">${shared
      .map((t) => `<si><t xml:space="preserve">${escapeXml(t)}</t></si>`)
      .join('')}</sst>`,
  );
  files['[Content_Types].xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`,
  );
  files['_rels/.rels'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  );

  return zipSync(files);
}
