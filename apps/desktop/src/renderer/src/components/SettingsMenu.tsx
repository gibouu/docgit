import { useEffect, useRef, useState } from 'react';
import type { AppSettings, UpdateState } from '../../../preload/api';

const STATUS_LABEL: Record<UpdateState['status'], string> = {
  idle: 'Up to date',
  checking: 'Checking…',
  available: 'Update found…',
  downloading: 'Downloading…',
  ready: 'Ready — restart to update',
  error: "Couldn't check",
  disabled: 'Automatic updates off',
};

export function SettingsMenu({ version }: { version: string }) {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [update, setUpdate] = useState<UpdateState>({ status: 'idle' });
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [dataMsg, setDataMsg] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    void window.docgit.updateSettings().then(setSettings);
    void window.docgit.updateState().then(setUpdate);
    const offUpdate = window.docgit.onUpdate(setUpdate);
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      offUpdate();
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="settings-wrap" ref={wrapRef}>
      <button type="button" className="btn" aria-label="Settings" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        ⚙
      </button>
      {open && (
        <div className="settings-popover" role="menu">
          <label className="settings-row">
            <input
              type="checkbox"
              checked={settings?.autoUpdate ?? true}
              onChange={async (e) => setSettings(await window.docgit.setAutoUpdate(e.target.checked))}
            />
            Automatic updates
          </label>
          <p className="settings-hint">
            Checks GitHub for a new version on launch — the only time DocGit uses the network.
          </p>
          <div className="settings-row settings-status">
            <span>{STATUS_LABEL[update.status]}{update.status === 'downloading' && update.percent != null ? ` ${update.percent}%` : ''}</span>
            <button type="button" className="btn btn-mini" onClick={() => void window.docgit.checkForUpdate()}>
              Check now
            </button>
          </div>
          <div className="settings-divider" />
          <div className="settings-section-label">Your data</div>
          <div className="settings-data-actions">
            <button
              type="button"
              className="btn btn-mini"
              onClick={async () => {
                try {
                  const path = await window.docgit.runBackup();
                  setDataMsg(path ? 'Backup saved.' : '');
                } catch {
                  setDataMsg('Couldn’t save the backup — check the location has space and is writable, then try again.');
                }
              }}
            >
              Back up now…
            </button>
            <button type="button" className="btn btn-mini" onClick={() => window.docgit.revealDataFolder()}>
              Reveal data folder
            </button>
          </div>
          {!confirmRestore ? (
            <button type="button" className="settings-restore-link" onClick={() => setConfirmRestore(true)}>
              Restore from a backup…
            </button>
          ) : (
            <div className="settings-restore-confirm">
              <p>This replaces your current history with the backup. Your current data is saved to <code>docgit.db.bak</code> first, and DocGit will relaunch.</p>
              <div className="settings-data-actions">
                <button type="button" className="btn btn-mini" onClick={() => setConfirmRestore(false)}>Cancel</button>
                <button
                  type="button"
                  className="btn btn-mini btn-danger"
                  onClick={async () => {
                    try {
                      await window.docgit.restoreBackup(); // app relaunches on success; an invalid file rejects here
                      setConfirmRestore(false);
                    } catch (err) {
                      setDataMsg(err instanceof Error ? err.message.replace(/^.*Error[^:]*:\s*/, '') : String(err));
                    }
                  }}
                >
                  Choose backup & restore
                </button>
              </div>
            </div>
          )}
          {dataMsg && <p className="settings-hint">{dataMsg}</p>}
          {version && <p className="settings-version">DocGit v{version}</p>}
        </div>
      )}
    </div>
  );
}
