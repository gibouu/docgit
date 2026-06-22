import { appendFileSync, renameSync, statSync } from 'node:fs';

/** Size cap before activity.log rotates to activity.log.1 (one generation kept). */
export const LOG_MAX_BYTES = 1_000_000;

/**
 * Append a timestamped line to a log file, rotating to `<path>.1` once the file
 * grows past `maxBytes`, so the diagnostic log can never grow without bound.
 * Best-effort: logging must never throw into the app. `maxBytes` is injectable
 * for tests; production uses LOG_MAX_BYTES.
 */
export function appendLog(logPath: string, message: string, maxBytes = LOG_MAX_BYTES): void {
  try {
    let size = 0;
    try {
      size = statSync(logPath).size;
    } catch {
      // no file yet — first write
    }
    if (size > maxBytes) {
      renameSync(logPath, `${logPath}.1`); // replaces any previous generation
    }
    appendFileSync(logPath, `${new Date().toISOString()}  ${message}\n`);
  } catch {
    // never break the app over a log write
  }
}
