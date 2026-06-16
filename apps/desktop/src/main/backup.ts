import { copyFileSync, existsSync } from 'node:fs';
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
  copyFileSync(srcPath, dbPath);
}
