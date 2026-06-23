import { useCallback, useEffect, useState } from 'react';
import type { DocumentInfo } from '../../preload/api';
import { Library } from './views/Library.js';
import { DocumentView } from './views/DocumentView.js';
import { SentHistory } from './views/SentHistory.js';
import { UpdateBanner } from './components/UpdateBanner.js';
import { CleanupBanner } from './components/CleanupBanner.js';
import { Modal } from './components/Modal.js';

type Route =
  | { kind: 'library' }
  | { kind: 'history' }
  | { kind: 'doc'; id: string; commitId?: string };

export function App() {
  const [documents, setDocuments] = useState<DocumentInfo[]>([]);
  const [route, setRoute] = useState<Route>({ kind: 'library' });
  const [showUpdateNote, setShowUpdateNote] = useState(false);

  useEffect(() => {
    void window.docgit.updateSettings().then((s) => setShowUpdateNote(!s.seenUpdateNote));
  }, []);

  const refresh = useCallback(async () => {
    setDocuments(await window.docgit.listDocuments());
  }, []);

  useEffect(() => {
    void refresh();
    return window.docgit.onChanged(() => void refresh());
  }, [refresh]);

  const openDoc = route.kind === 'doc' ? (documents.find((d) => d.id === route.id) ?? null) : null;

  return (
    <div className="app">
      <div className="titlebar" />
      <UpdateBanner />
      <CleanupBanner />
      {showUpdateNote && (
        <Modal title="DocGit keeps itself up to date" onClose={() => { void window.docgit.markUpdateNoteSeen(); setShowUpdateNote(false); }}>
          <p className="modal-hint">
            DocGit now checks GitHub for a new version when it starts, and downloads updates in the background.
            A downloaded update installs automatically the next time you quit and reopen DocGit, so you always
            run the latest version — or click “Restart to update” to apply it right away. That check is the only
            network use DocGit starts on its own — connecting a Grist document also reaches the network, but only when you choose to.
            Everything else stays on your Mac. You can turn the update check off any time under ⚙ Settings.
          </p>
          <div className="modal-actions">
            <button type="button" className="btn btn-primary" onClick={() => { void window.docgit.markUpdateNoteSeen(); setShowUpdateNote(false); }}>
              Got it
            </button>
          </div>
        </Modal>
      )}
      {route.kind === 'doc' && openDoc ? (
        <DocumentView
          key={`${openDoc.id}:${route.commitId ?? ''}`}
          document={openDoc}
          initialSelectedId={route.kind === 'doc' ? route.commitId : undefined}
          onBack={() => setRoute({ kind: 'library' })}
        />
      ) : route.kind === 'history' ? (
        <SentHistory
          onBack={() => setRoute({ kind: 'library' })}
          onOpenVersion={(documentId, commitId) => setRoute({ kind: 'doc', id: documentId, commitId })}
        />
      ) : (
        <Library
          documents={documents}
          onOpen={(d) => setRoute({ kind: 'doc', id: d.id })}
          onShowHistory={() => setRoute({ kind: 'history' })}
          onRefresh={refresh}
        />
      )}
    </div>
  );
}
