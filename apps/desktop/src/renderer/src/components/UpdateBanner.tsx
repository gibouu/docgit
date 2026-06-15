import { useEffect, useState } from 'react';
import type { UpdateState } from '../../../preload/api';

/** Non-blocking bar shown when a downloaded update is ready to install. */
export function UpdateBanner() {
  const [state, setState] = useState<UpdateState>({ status: 'idle' });
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    void window.docgit.updateState().then(setState);
    return window.docgit.onUpdate((s) => {
      setState(s);
      setDismissed(false); // a newly-ready update re-shows the bar
    });
  }, []);

  if (state.status !== 'ready' || dismissed) return null;

  return (
    <div className="update-banner" role="status">
      <span>
        DocGit {state.version ? `v${state.version}` : ''} is ready to install.
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
  );
}
