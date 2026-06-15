import { app } from 'electron';
import electronUpdater from 'electron-updater';
import { appendFileSync } from 'node:fs';

const { autoUpdater } = electronUpdater;

export interface UpdateState {
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error' | 'disabled';
  version?: string;
  percent?: number;
}

type Send = (state: UpdateState) => void;

let state: UpdateState = { status: 'idle' };

export function getUpdateState(): UpdateState {
  return state;
}

/**
 * Wire electron-updater to the renderer. Network access is hard-gated by
 * `app.isPackaged`, so dev, smoke, and boot-check never reach out. Every
 * failure resolves to a logged `error` state — the app works fully offline.
 */
export function initUpdater(send: Send, logPath: string, autoUpdate: boolean): void {
  const log = (msg: string) => {
    try {
      appendFileSync(logPath, `${new Date().toISOString()}  updater ${msg}\n`);
    } catch {
      // logging must never break the app
    }
  };

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = { info: log, warn: log, error: log, debug: () => {} } as never;

  const set = (next: UpdateState) => {
    state = next;
    send(state);
  };

  autoUpdater.on('checking-for-update', () => set({ status: 'checking' }));
  autoUpdater.on('update-available', (info) => set({ status: 'available', version: info.version }));
  autoUpdater.on('update-not-available', () => set({ status: 'idle' }));
  autoUpdater.on('download-progress', (p) => set({ status: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => set({ status: 'ready', version: info.version }));
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

/** Manual check (the "Check now" button) — ignores the enabled flag. */
export function checkForUpdatesNow(): void {
  if (!app.isPackaged) return;
  void autoUpdater.checkForUpdates();
}

/** Quit and install a downloaded update. */
export function quitAndInstall(): void {
  autoUpdater.quitAndInstall();
}
