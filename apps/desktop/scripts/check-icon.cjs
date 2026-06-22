/* Validate a rendered icon PNG: square, at least 1024px, and not blank.
 * Usage: node scripts/check-icon.cjs <png> */
const { readFileSync } = require('node:fs');

const png = readFileSync(process.argv[2]);
// PNG: 8-byte signature, then IHDR with width @16 and height @20 (big-endian).
const w = png.readUInt32BE(16);
const h = png.readUInt32BE(20);
if (w < 1024 || h < 1024 || w !== h) {
  console.error(`icon render check FAILED: dims ${w}x${h} (expected a square >= 1024)`);
  process.exit(1);
}
if (png.length < 5000) {
  console.error(`icon render check FAILED: PNG is ${png.length} bytes — likely blank/transparent`);
  process.exit(1);
}
console.log(`icon render OK: ${w}x${h}, ${png.length} bytes`);
