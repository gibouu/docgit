import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** App-level preferences, stored as JSON next to the version database. */
export interface AppSettings {
  /** Check GitHub Releases for updates on launch. */
  autoUpdate: boolean;
  /** Whether the one-time auto-update privacy note has been shown. */
  seenUpdateNote: boolean;
}

const DEFAULTS: AppSettings = { autoUpdate: true, seenUpdateNote: false };

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

  set<K extends keyof AppSettings>(key: K, value: AppSettings[K]): AppSettings {
    this.cache = { ...this.cache, [key]: value };
    try {
      writeFileSync(this.file, JSON.stringify(this.cache, null, 2));
    } catch {
      // persistence is best-effort; in-memory cache still reflects the change
    }
    return this.get();
  }
}
