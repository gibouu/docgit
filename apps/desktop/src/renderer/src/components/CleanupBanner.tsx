import { useEffect, useState } from 'react';
import type { OldInstaller } from '../../../preload/api';

const formatSize = (bytes: number): string =>
  bytes >= 1_000_000 ? `${Math.round(bytes / 1_000_000)} MB` : `${Math.round(bytes / 1000)} KB`;

/**
 * Shown once, after an update, when an old DocGit installer is still sitting in
 * Downloads. One click moves it to the Trash (recoverable); "Keep" dismisses.
 */
export function CleanupBanner() {
  const [items, setItems] = useState<OldInstaller[]>([]);
  const [done, setDone] = useState(false);

  useEffect(() => {
    void window.docgit.cleanupCandidates().then(setItems);
  }, []);

  if (done || items.length === 0) return null;
  const total = items.reduce((sum, i) => sum + i.bytes, 0);
  const plural = items.length > 1 ? 's' : '';

  return (
    <div className="update-banner" role="status">
      <div className="update-banner-main">
        <span>
          Found {items.length} old DocGit installer{plural} in Downloads ({formatSize(total)}). Move to Trash?
        </span>
        <span className="update-banner-actions">
          <button
            type="button"
            className="btn btn-primary btn-mini"
            onClick={async () => {
              await window.docgit.trashOldInstallers(items.map((i) => i.path));
              setDone(true);
            }}
          >
            Move to Trash
          </button>
          <button type="button" className="btn btn-mini" onClick={() => setDone(true)}>
            Keep
          </button>
        </span>
      </div>
    </div>
  );
}
