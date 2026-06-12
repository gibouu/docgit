import { extname } from 'node:path';
import type { DocModel } from '../model/types.js';
import { parseDocx } from './word/parse.js';
import { parseXlsx } from './excel/parse.js';
import { parsePptx } from './powerpoint/parse.js';

export const SUPPORTED_EXTENSIONS = ['.docx', '.xlsx', '.pptx'] as const;

/** Parse any supported document by file extension into the normalized model. */
export function parseDocument(filePath: string, bytes: Uint8Array): DocModel {
  const ext = extname(filePath).toLowerCase();
  switch (ext) {
    case '.docx':
      return parseDocx(bytes);
    case '.xlsx':
      return parseXlsx(bytes);
    case '.pptx':
      return parsePptx(bytes);
    default:
      throw new Error(`Unsupported document type "${ext}" — supported: ${SUPPORTED_EXTENSIONS.join(', ')}`);
  }
}
