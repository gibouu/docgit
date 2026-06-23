import { app } from 'electron';
import electronUpdater, { type Logger } from 'electron-updater';
import { appendLog } from './log.js';

const { autoUpdater } = electronUpdater;

export interface UpdateState {
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error' | 'disabled';
  version?: string;
  percent?: number;
  notes?: string;
}

type Send = (state: UpdateState) => void;

let state: UpdateState = { status: 'idle' };

export function getUpdateState(): UpdateState {
  return state;
}

function notesToText(
  rn: string | Array<{ version: string; note: string | null }> | null | undefined,
): string | undefined {
  if (!rn) return undefined;
  if (typeof rn === 'string') return rn.trim() || undefined;
  const text = rn.map((r) => r.note ?? '').filter(Boolean).join('\n\n').trim();
  return text || undefined;
}

/**
 * Wire electron-updater to the renderer. Network access is hard-gated by
 * `app.isPackaged`, so dev, smoke, and boot-check never reach out. Every
 * failure resolves to a logged `error` state — the app works fully offline.
 */
export function initUpdater(send: Send, logPath: string, autoUpdate: boolean): void {
  const log = (msg: string) => appendLog(logPath, `updater ${msg}`);

  autoUpdater.autoDownload = true;
  // Install ONLY when the user explicitly clicks "Restart to update"
  // (quitAndInstall). "Later" then genuinely postpones — a downloaded update
  // never installs on a surprise quit, which matters for a local-first tool.
  autoUpdater.autoInstallOnAppQuit = false;
  const logger: Logger = { info: log, warn: log, error: log, debug: () => {} };
  autoUpdater.logger = logger;

  const set = (next: UpdateState) => {
    state = next;
    send(state);
  };

  autoUpdater.on('checking-for-update', () => set({ status: 'checking' }));
  autoUpdater.on('update-available', (info) => set({ status: 'available', version: info.version }));
  autoUpdater.on('update-not-available', () => set({ status: 'idle' }));
  autoUpdater.on('download-progress', (p) => set({ status: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) =>
    set({ status: 'ready', version: info.version, notes: notesToText(info.releaseNotes) }),
  );
  autoUpdater.on('error', (err) => {
    log(`error ${String(err)}`);
    set({ status: 'error' });
  });

  if (!app.isPackaged) {
    set({ status: 'disabled' });
    return;
  }
  if (autoUpdate) void autoUpdater.checkForUpdates();
  else set({ status: 'disabled' });
}

/**
 * Manual check (the "Check now" button) — ignores the enabled flag.
 * Safe to call while a check is in flight: electron-updater coalesces
 * concurrent checks onto the same in-flight promise.
 */
export function checkForUpdatesNow(): void {
  if (!app.isPackaged) return;
  void autoUpdater.checkForUpdates();
}

/** Quit and install a downloaded update. */
export function quitAndInstall(): void {
  if (!app.isPackaged) return; // self-guard: no install path exists unpackaged
  autoUpdater.quitAndInstall();
}
