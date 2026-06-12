import { strToU8, zipSync } from 'fflate';
import { escapeXml } from './makeDocx.js';

/** Build minimal but valid .pptx fixtures in memory. */

export interface FixtureSlide {
  /** Persistent slide id — defaults to 256 + index. */
  id?: string;
  shapes: { name: string; text: string }[];
}

export function makePptx(slides: FixtureSlide[]): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const sldIds: string[] = [];
  const rels: string[] = [];

  slides.forEach((slide, i) => {
    const n = i + 1;
    const id = slide.id ?? String(256 + i);
    sldIds.push(`<p:sldId id="${id}" r:id="rId${n}"/>`);
    rels.push(
      `<Relationship Id="rId${n}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${n}.xml"/>`,
    );

    const shapesXml = slide.shapes
      .map((shape, j) => {
        const paragraphs = shape.text
          .split('\n')
          .map((line) => `<a:p><a:r><a:t>${escapeXml(line)}</a:t></a:r></a:p>`)
          .join('');
        return `<p:sp><p:nvSpPr><p:cNvPr id="${j + 2}" name="${escapeXml(shape.name)}"/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/>${paragraphs}</p:txBody></p:sp>`;
      })
      .join('');

    files[`ppt/slides/slide${n}.xml`] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/></p:nvGrpSpPr><p:grpSpPr/>${shapesXml}</p:spTree></p:cSld></p:sld>`,
    );
  });

  files['ppt/presentation.xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst>${sldIds.join('')}</p:sldIdLst></p:presentation>`,
  );
  files['ppt/_rels/presentation.xml.rels'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`,
  );
  files['[Content_Types].xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>`,
  );
  files['_rels/.rels'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
  );

  return zipSync(files);
}
