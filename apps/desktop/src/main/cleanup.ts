import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface OldInstaller {
  /** Absolute path to the leftover installer file. */
  path: string;
  /** Size in bytes (for a human-readable "free up N MB" prompt). */
  bytes: number;
}

/**
 * Find leftover DocGit installer files in a directory (normally ~/Downloads).
 *
 * Once DocGit is installed and running, the `.dmg`/`.zip` it was installed from
 * is dead weight — auto-updates replace the app bundle in place, so the only
 * thing that ever accumulates is the manual installer the user double-clicked.
 * We surface those so the user can move them to the Trash (recoverable), never
 * deleting anything automatically.
 *
 * Pure and directory-injected so it is unit-testable without touching the real
 * Downloads folder. Returns [] (never throws) if the directory is unreadable.
 */
export function findOldInstallers(dir: string): OldInstaller[] {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // no Downloads dir, or no permission — nothing to offer
  }
  const found: OldInstaller[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/^DocGit.*\.(dmg|zip)$/i.test(entry.name)) continue;
    const path = join(dir, entry.name);
    try {
      found.push({ path, bytes: statSync(path).size });
    } catch {
      // file vanished between readdir and stat — skip it
    }
  }
  return found;
}
