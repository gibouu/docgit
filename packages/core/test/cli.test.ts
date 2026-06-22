import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { docxFromParagraphs } from './helpers/makeDocx.js';

// E2E against the shipped bin (built by `pnpm build`, which CI runs first).
const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

describe('docgit CLI', () => {
  let dir: string;
  const run = (args: string[]): string =>
    execFileSync('node', [CLI, ...args], {
      // NO_COLOR keeps output plain — picocolors otherwise emits ANSI when CI is
      // set (GitHub Actions), which would break id parsing.
      env: { ...process.env, DOCGIT_DIR: dir, NO_COLOR: '1' },
      encoding: 'utf8',
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'docgit-cli-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('commits a document and lists it in the log', () => {
    const file = join(dir, 'contract.docx');
    writeFileSync(file, docxFromParagraphs(['First clause.']));
    expect(run(['commit', file, '-m', 'initial'])).toMatch(/initial/);
    expect(run(['log', file])).toMatch(/initial/);
  });

  it('reports no changes on an unchanged re-commit', () => {
    const file = join(dir, 'c.docx');
    writeFileSync(file, docxFromParagraphs(['same content']));
    run(['commit', file, '-m', 'v1']);
    expect(run(['commit', file, '-m', 'v1'])).toMatch(/No changes/);
  });

  it('diffs two versions of a document', () => {
    const file = join(dir, 'd.docx');
    writeFileSync(file, docxFromParagraphs(['one']));
    run(['commit', file, '-m', 'a']);
    writeFileSync(file, docxFromParagraphs(['one', 'two']));
    run(['commit', file, '-m', 'b']);
    const log = run(['log', file]);
    const ids = log.match(/\b[0-9a-f]{8}\b/g) ?? [];
    expect(ids.length).toBeGreaterThanOrEqual(2);
    const diff = run(['diff', ids[1]!, ids[0]!]); // older → newer
    expect(diff).toMatch(/two/); // the added paragraph shows up
  });
});
