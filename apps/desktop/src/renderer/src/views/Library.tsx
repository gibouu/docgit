import { useState } from 'react';
import type { DocumentInfo } from '../../../preload/api';
import { Modal } from '../components/Modal.js';

export interface LibraryProps {
  documents: DocumentInfo[];
  onOpen: (doc: DocumentInfo) => void;
  onShowHistory: () => void;
  onRefresh: () => Promise<void>;
}

/**
 * The hub: every tracked document lives here. Users open documents through
 * DocGit so every Word save quietly becomes a version.
 */
export function Library({ documents, onOpen, onShowHistory, onRefresh }: LibraryProps) {
  const [showGrist, setShowGrist] = useState(false);

  const addDocument = async () => {
    const added = await window.docgit.addDocument();
    if (added) await onRefresh();
  };

  return (
    <main className="library">
      <header className="library-header">
        <div>
          <h1>Your documents</h1>
          <p className="library-sub">
            Every save becomes a version. Branch freely — nothing is ever lost, nothing leaves this Mac.
          </p>
        </div>
        <div className="library-actions">
          {documents.length > 0 && (
            <button type="button" className="btn" onClick={onShowHistory}>
              ✉ Sent history
            </button>
          )}
          <button type="button" className="btn" onClick={() => setShowGrist(true)}>
            ⛁ Connect Grist…
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void addDocument()}>
            + Add document
          </button>
        </div>
      </header>

      {showGrist && (
        <ConnectGristDialog
          onClose={() => setShowGrist(false)}
          onConnected={async () => {
            setShowGrist(false);
            await onRefresh();
          }}
        />
      )}

      {documents.length === 0 ? (
        <div className="library-empty">
          <div className="library-empty-mark">❧</div>
          <h2>Start with one document</h2>
          <p>
            Add a contract, a CV, a business plan — DocGit keeps every version, shows you exactly what changed,
            and remembers which version you sent to whom.
          </p>
          <button type="button" className="btn btn-primary" onClick={() => void addDocument()}>
            + Add your first document
          </button>
        </div>
      ) : (
        <ul className="library-grid">
          {documents.map((doc) => (
            <li key={doc.id}>
              <button type="button" className="doc-card" onClick={() => onOpen(doc)}>
                <span className="doc-card-name">
                  {doc.name}
                  {doc.remoteKind && <span className="doc-card-remote"> ⛁ {doc.remoteKind}</span>}
                </span>
                <span className="doc-card-path">{doc.path}</span>
                <span className="doc-card-meta">
                  <span>
                    {doc.versionCount} version{doc.versionCount === 1 ? '' : 's'}
                  </span>
                  <span>·</span>
                  <span>
                    {doc.branchCount} branch{doc.branchCount === 1 ? '' : 'es'}
                  </span>
                  {doc.lastVersionAt && (
                    <>
                      <span>·</span>
                      <span>last saved {new Date(doc.lastVersionAt).toLocaleDateString()}</span>
                    </>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

function ConnectGristDialog(props: { onClose: () => void; onConnected: () => Promise<void> }) {
  const [baseUrl, setBaseUrl] = useState('http://localhost:8484');
  const [docId, setDocId] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const connect = async () => {
    setBusy(true);
    setError('');
    try {
      await window.docgit.connectGrist(baseUrl.trim(), docId.trim(), apiKey.trim() || undefined);
      await props.onConnected();
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^.*Error[^:]*:\s*/, '') : String(err));
      setBusy(false);
    }
  };

  return (
    <Modal title="Connect a Grist document" onClose={props.onClose}>
      <p className="modal-hint">
        Read-only tracking: DocGit snapshots the document as it changes on the server. Its tables can feed linked
        values in your Word documents.
      </p>
      <input className="input" placeholder="Server — e.g. http://localhost:8484" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
      <input autoFocus className="input" placeholder="Document id (from the doc's URL)" value={docId} onChange={(e) => setDocId(e.target.value)} />
      <input className="input" placeholder="API key (optional for open local servers)" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
      {error && <p className="linkwizard-error">{error}</p>}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={props.onClose}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary" disabled={busy || !baseUrl.trim() || !docId.trim()} onClick={() => void connect()}>
          {busy ? 'Connecting…' : 'Connect'}
        </button>
      </div>
    </Modal>
  );
}
