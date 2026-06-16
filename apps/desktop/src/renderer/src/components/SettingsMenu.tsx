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
          {version && <p className="settings-version">DocGit v{version}</p>}
        </div>
      )}
    </div>
  );
}
