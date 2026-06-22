import { copyFileSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

/** Copy the database file to `destPath` (a complete backup — objects hold all content). */
export function backupDatabase(dbPath: string, destPath: string): string {
  copyFileSync(dbPath, destPath);
  return destPath;
}

/** Throw a friendly error if `srcPath` is not a readable DocGit database. */
export function assertDocgitDb(srcPath: string): void {
  if (!existsSync(srcPath)) throw new Error('That file no longer exists.');
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(srcPath, { readOnly: true });
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('documents','commits')")
      .all();
    if (tables.length < 2) throw new Error("That file isn't a DocGit backup.");
  } catch {
    throw new Error("That file isn't a DocGit backup.");
  } finally {
    db?.close();
  }
}

/**
 * Replace `dbPath` with `srcPath`, after saving the current database to
 * `${dbPath}.bak`. The caller MUST close the live store before calling this.
 */
export function restoreDatabase(dbPath: string, srcPath: string): void {
  assertDocgitDb(srcPath);
  if (existsSync(dbPath)) copyFileSync(dbPath, `${dbPath}.bak`);
  // Stage into a sibling temp, validate it, then atomically rename it into
  // place. If anything before the rename fails, dbPath is left exactly as it
  // was — never a half-written database — and the .bak is an extra safety net.
  const tmp = `${dbPath}.restore-tmp`;
  try {
    copyFileSync(srcPath, tmp);
    assertDocgitDb(tmp); // the staged copy must itself be a valid DocGit db
    renameSync(tmp, dbPath); // atomic replace
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // best-effort cleanup of the staged copy
    }
    throw err;
  }
  // Drop stale WAL sidecars from the previous database so SQLite can't replay
  // them onto the freshly restored file (which would corrupt it).
  for (const suffix of ['-wal', '-shm']) {
    try {
      if (existsSync(`${dbPath}${suffix}`)) unlinkSync(`${dbPath}${suffix}`);
    } catch {
      // a missing or locked sidecar is not fatal
    }
  }
}
