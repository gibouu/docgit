import { useEffect, useState } from 'react';
import type { UpdateState } from '../../../preload/api';

/** Non-blocking bar shown when a downloaded update is ready to install. */
export function UpdateBanner() {
  const [state, setState] = useState<UpdateState>({ status: 'idle' });
  const [dismissed, setDismissed] = useState(false);
  const [showNotes, setShowNotes] = useState(false);

  useEffect(() => {
    void window.docgit.updateState().then(setState);
    return window.docgit.onUpdate((s) => {
      setState(s);
      setDismissed(false); // a newly-ready update re-shows the bar
      setShowNotes(false);
    });
  }, []);

  if (state.status !== 'ready' || dismissed) return null;

  return (
    <div className="update-banner" role="status">
      <div className="update-banner-main">
        <span>
          DocGit {state.version ? `v${state.version}` : ''} is ready to install.
          {state.notes && (
            <button type="button" className="update-banner-whatsnew" onClick={() => setShowNotes((v) => !v)}>
              {showNotes ? 'Hide' : "What's new"} {showNotes ? '▾' : '▸'}
            </button>
          )}
        </span>
        <span className="update-banner-actions">
          <button type="button" className="btn btn-primary btn-mini" onClick={() => void window.docgit.installUpdate()}>
            Restart to update
          </button>
          <button type="button" className="btn btn-mini" onClick={() => setDismissed(true)}>
            Later
          </button>
        </span>
      </div>
      {state.notes && showNotes && <div className="update-banner-notes">{state.notes}</div>}
    </div>
  );
}
