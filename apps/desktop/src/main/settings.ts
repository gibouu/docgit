import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** App-level preferences, stored as JSON next to the version database. */
export interface AppSettings {
  /** Check GitHub Releases for updates on launch. */
  autoUpdate: boolean;
  /** Whether the one-time auto-update privacy note has been shown. */
  seenUpdateNote: boolean;
  /** Last app version this machine launched, to detect a fresh update. */
  lastRunVersion: string | null;
  /** The single workspace root folder; the library mirrors its disk tree (#52). */
  workspaceRoot: string | null;
}

const DEFAULTS: AppSettings = {
  autoUpdate: true,
  seenUpdateNote: false,
  lastRunVersion: null,
  workspaceRoot: null,
};

/**
 * Tiny JSON-backed settings store. `dir` is the data directory
 * (`app.getPath('userData')` in the app; a temp dir in tests). Never throws
 * into the app: a missing or corrupt file yields defaults.
 */
export class Settings {
  private file: string;
  private cache: AppSettings;

  constructor(dir: string) {
    this.file = join(dir, 'settings.json');
    this.cache = this.read();
  }

  private read(): AppSettings {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<AppSettings>;
      return { ...DEFAULTS, ...parsed };
    } catch {
      return { ...DEFAULTS };
    }
  }

  get(): AppSettings {
    return { ...this.cache };
  }

  /**
   * Update a setting and persist it atomically (temp file + rename). The
   * in-memory cache always reflects the change; if the write fails this THROWS
   * so callers can tell the user the choice won't survive a relaunch (it's also
   * a privacy control — a silently-unsaved auto-update opt-out is the failure
   * mode #88 is about).
   */
  set<K extends keyof AppSettings>(key: K, value: AppSettings[K]): AppSettings {
    this.cache = { ...this.cache, [key]: value };
    const tmp = `${this.file}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(this.cache, null, 2));
      renameSync(tmp, this.file); // atomic: never leaves a half-written settings file
    } catch (err) {
      try {
        if (existsSync(tmp)) unlinkSync(tmp);
      } catch {
        // best-effort cleanup of the staged write
      }
      throw new Error('Settings could not be saved — the change applies now but may not survive a relaunch.');
    }
    return this.get();
  }
}
