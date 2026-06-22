import { unzipSync, type Unzipped, type UnzipFileInfo } from 'fflate';

/**
 * Bounds for a single OOXML package. These are generous for real Office files
 * (a media-heavy deck is tens of MB) but reject decompression bombs and
 * pathological archives before they exhaust memory.
 */
export interface ZipLimits {
  /** Max compressed (on-disk) package size. */
  maxCompressedBytes?: number;
  /** Max total declared uncompressed size across all entries. */
  maxUncompressedBytes?: number;
  /** Max number of entries. */
  maxEntries?: number;
}

const DEFAULTS: Required<ZipLimits> = {
  maxCompressedBytes: 300 * 1024 * 1024, // 300 MB on disk
  maxUncompressedBytes: 800 * 1024 * 1024, // 800 MB inflated
  maxEntries: 8192,
};

/**
 * `unzipSync` with guardrails. The package is rejected if it is too large on
 * disk, declares too much uncompressed data, or has too many entries — checked
 * against each entry's declared size via fflate's filter, *before* that entry
 * is inflated, so a zip bomb is caught early instead of freezing the process.
 *
 * Note: the per-entry check trusts the archive's declared `originalSize`; a
 * crafted header that lies about its size could still over-inflate one entry.
 * The compressed-size and total caps bound the blast radius; full streaming
 * enforcement would need a different unzip API.
 */
export function safeUnzip(data: Uint8Array, limits: ZipLimits = {}): Unzipped {
  const { maxCompressedBytes, maxUncompressedBytes, maxEntries } = { ...DEFAULTS, ...limits };
  if (data.length > maxCompressedBytes) {
    throw new Error(`This file is too large to open safely (${Math.round(data.length / 1024 / 1024)} MB).`);
  }
  let entries = 0;
  let totalUncompressed = 0;
  return unzipSync(data, {
    filter: (file: UnzipFileInfo) => {
      entries += 1;
      totalUncompressed += file.originalSize;
      if (entries > maxEntries) throw new Error('This file has too many internal parts to open safely.');
      if (totalUncompressed > maxUncompressedBytes) {
        throw new Error('This file expands too large to open safely (possible corruption or zip bomb).');
      }
      return true;
    },
  });
}
