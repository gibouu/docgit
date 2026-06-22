import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { safeUnzip } from '../src/adapters/zip.js';

describe('safeUnzip', () => {
  const pkg = zipSync({ 'a.xml': strToU8('hello'), 'b.xml': strToU8('world'), 'c.xml': strToU8('!') });

  it('unzips a normal package', () => {
    expect(Object.keys(safeUnzip(pkg)).sort()).toEqual(['a.xml', 'b.xml', 'c.xml']);
  });

  it('rejects a package with too many entries', () => {
    expect(() => safeUnzip(pkg, { maxEntries: 2 })).toThrow(/too many internal parts/);
  });

  it('rejects a package that expands too large (zip-bomb guard)', () => {
    expect(() => safeUnzip(pkg, { maxUncompressedBytes: 3 })).toThrow(/expands too large/);
  });

  it('rejects oversized compressed input', () => {
    expect(() => safeUnzip(pkg, { maxCompressedBytes: 1 })).toThrow(/too large to open safely/);
  });
});
