#!/usr/bin/env node
import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import pc from 'picocolors';
import { parseDocx } from './adapters/word/parse.js';
import { diffModels, type Change } from './diff/diff.js';
import { blockText } from './model/types.js';
import { SnapshotStore } from './store/store.js';

/**
 * Test CLI for the core engine (Milestone 1). End users get the desktop app;
 * this exists to exercise parse → snapshot → diff from the terminal.
 *
 * Store location: $DOCGIT_DIR/docgit.db, defaulting to ~/.docgit/docgit.db.
 */

function openStore(): SnapshotStore {
  const dir = process.env['DOCGIT_DIR'] ?? join(homedir(), '.docgit');
  return new SnapshotStore(join(dir, 'docgit.db'));
}

const short = (id: string) => id.slice(0, 8);

const program = new Command();
program.name('docgit').description('DocGit core engine test CLI').version('0.1.0');

program
  .command('commit')
  .argument('<file>', 'path to a .docx file')
  .option('-m, --message <message>', 'commit message')
  .option('-a, --author <author>', 'author name')
  .description('snapshot the current content of a document')
  .action((file: string, opts: { message?: string; author?: string }) => {
    const bytes = readFileSync(file);
    const model = parseDocx(bytes);
    const store = openStore();
    try {
      const { commit, created } = store.commit(file, bytes, model, opts);
      if (created) {
        console.log(`${pc.green('✓')} ${short(commit.id)} ${commit.message ?? ''}`.trimEnd());
      } else {
        console.log(pc.dim(`No changes — head is ${short(commit.id)}`));
      }
    } finally {
      store.close();
    }
  });

program
  .command('log')
  .argument('<file>', 'path to a tracked document')
  .description('show the version history of a document')
  .action((file: string) => {
    const store = openStore();
    try {
      const commits = store.log(file);
      if (commits.length === 0) {
        console.log(pc.dim('No versions yet.'));
        return;
      }
      for (const c of commits) {
        const when = new Date(c.createdAt).toLocaleString();
        const author = c.author ? ` ${pc.cyan(c.author)}` : '';
        console.log(`${pc.yellow(short(c.id))}  ${when}${author}  ${c.message ?? pc.dim('(no message)')}`);
      }
    } finally {
      store.close();
    }
  });

program
  .command('diff')
  .argument('<from>', 'older commit id (may be abbreviated)')
  .argument('<to>', 'newer commit id (may be abbreviated)')
  .description('side-by-side content diff between two versions')
  .action((from: string, to: string) => {
    const store = openStore();
    try {
      const a = store.resolve(from);
      const b = store.resolve(to);
      const { changes, summary } = diffModels(store.getModel(a), store.getModel(b));

      console.log(
        pc.bold(
          `${pc.green(`+${summary.added}`)} ${pc.red(`−${summary.removed}`)} ` +
            `${pc.yellow(`~${summary.modified} modified`)} ${pc.cyan(`↕${summary.moved} moved`)} ` +
            pc.dim(`(${summary.unchanged} unchanged)`),
        ),
      );
      console.log();
      let skipped = 0;
      const flushSkipped = () => {
        if (skipped > 0) {
          console.log(pc.dim(`  ⋮ ${skipped} unchanged`));
          skipped = 0;
        }
      };
      for (const change of changes) {
        if (change.type === 'unchanged') {
          skipped++;
          continue;
        }
        flushSkipped();
        printChange(change);
      }
      flushSkipped();
    } finally {
      store.close();
    }
  });

program
  .command('show')
  .argument('<ref>', 'commit id (may be abbreviated)')
  .description('print the text content of a version')
  .action((ref: string) => {
    const store = openStore();
    try {
      const commit = store.resolve(ref);
      const model = store.getModel(commit);
      for (const block of model.blocks) console.log(blockText(block));
    } finally {
      store.close();
    }
  });

function printChange(change: Change): void {
  switch (change.type) {
    case 'added':
      console.log(pc.green(`+ ${blockText(change.newBlock!)}`));
      break;
    case 'removed':
      console.log(pc.red(`− ${blockText(change.oldBlock!)}`));
      break;
    case 'moved':
      console.log(pc.cyan(`↕ ${blockText(change.newBlock!)} ${pc.dim(`(moved ${change.oldIndex} → ${change.newIndex})`)}`));
      break;
    case 'modified': {
      const line = (change.spans ?? [])
        .map((s) => (s.kind === 'added' ? pc.green(s.text) : s.kind === 'removed' ? pc.red(pc.strikethrough(s.text)) : s.text))
        .join('');
      console.log(`${pc.yellow('~')} ${line}`);
      break;
    }
    case 'unchanged':
      break;
  }
}

program.parse();
