import { useMemo, useState } from 'react';
import type { DocumentInfo } from '../../../preload/api';
import { Modal } from '../components/Modal.js';

/** Document families, color-coded throughout the library. */
const DOC_TYPES = [
  { id: 'doc', label: 'Docs', color: '#3b6ea5' },
  { id: 'table', label: 'Tables', color: '#2c7a4b' },
  { id: 'slides', label: 'Slides', color: '#d97a26' },
] as const;

type DocType = (typeof DOC_TYPES)[number]['id'];

function docTypeOf(doc: DocumentInfo): DocType {
  if (doc.remoteKind === 'grist') return 'table';
  const path = doc.path.toLowerCase();
  if (path.endsWith('.xlsx')) return 'table';
  if (path.endsWith('.pptx')) return 'slides';
  return 'doc';
}

const TIME_FILTERS = [
  { id: 'all', label: 'All time', days: null },
  { id: 'today', label: 'Today', days: 1 },
  { id: '7d', label: '7 days', days: 7 },
  { id: '30d', label: '30 days', days: 30 },
] as const;

type TimeFilter = (typeof TIME_FILTERS)[number]['id'];

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
  const [typeFilter, setTypeFilter] = useState<DocType | 'all'>('all');
  const [timeFilter, setTimeFilter] = useState<TimeFilter>('all');

  const visible = useMemo(() => {
    const cutoffDays = TIME_FILTERS.find((t) => t.id === timeFilter)?.days ?? null;
    const cutoff = cutoffDays === null ? null : Date.now() - cutoffDays * 24 * 60 * 60 * 1000;
    return documents
      .filter((doc) => typeFilter === 'all' || docTypeOf(doc) === typeFilter)
      .filter((doc) => cutoff === null || (doc.lastVersionAt !== null && Date.parse(doc.lastVersionAt) >= cutoff))
      .slice()
      .sort((a, b) => (b.lastVersionAt ?? '').localeCompare(a.lastVersionAt ?? ''));
  }, [documents, typeFilter, timeFilter]);

  const countOf = (type: DocType) => documents.filter((d) => docTypeOf(d) === type).length;

  const [sharePrompt, setSharePrompt] = useState<{ docId: string; provider: string } | null>(null);

  const addDocument = async () => {
    const added = await window.docgit.addDocument();
    if (!added) return;
    await onRefresh();
    // If it lives in a cloud folder, it might be shared — offer attribution.
    const cloud = await window.docgit.cloudStatus(added.id);
    if (cloud.provider) setSharePrompt({ docId: added.id, provider: cloud.provider });
  };

  const SUPPORTED = ['.docx', '.xlsx', '.pptx'];
  const [dragOver, setDragOver] = useState(false);

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => window.docgit.pathForFile(f))
      .filter((p) => SUPPORTED.some((ext) => p.toLowerCase().endsWith(ext)));
    if (paths.length === 0) return; // silently ignore unsupported drops
    const added = await window.docgit.addDocumentByPaths(paths);
    await onRefresh();
    // Offer attribution for the first cloud-resident add, mirroring addDocument().
    for (const doc of added) {
      const cloud = await window.docgit.cloudStatus(doc.id);
      if (cloud.provider) {
        setSharePrompt({ docId: doc.id, provider: cloud.provider });
        break;
      }
    }
  };

  return (
    <main
      className={`library${dragOver ? ' is-dragover' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragOver(false);
      }}
      onDrop={(e) => void onDrop(e)}
    >
      {dragOver && (
        <div className="library-dropzone">
          <div className="library-dropzone-inner">Drop Word, Excel or PowerPoint files to add</div>
        </div>
      )}
      {sharePrompt && (
        <SharedDocDialog
          provider={sharePrompt.provider}
          onClose={async (shared, myName) => {
            await window.docgit.setSharing(sharePrompt.docId, shared, myName);
            setSharePrompt(null);
            await onRefresh();
          }}
        />
      )}
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
        <>
          <div className="library-filters">
            <span className="filter-group">
              <button
                type="button"
                className={`filter-chip${typeFilter === 'all' ? ' is-active' : ''}`}
                onClick={() => setTypeFilter('all')}
              >
                All · {documents.length}
              </button>
              {DOC_TYPES.map((type) =>
                countOf(type.id) === 0 ? null : (
                  <button
                    key={type.id}
                    type="button"
                    className={`filter-chip${typeFilter === type.id ? ' is-active' : ''}`}
                    style={{ ['--chip-color' as string]: type.color }}
                    onClick={() => setTypeFilter(typeFilter === type.id ? 'all' : type.id)}
                  >
                    <span className="filter-dot" style={{ background: type.color }} />
                    {type.label} · {countOf(type.id)}
                  </button>
                ),
              )}
            </span>
            <span className="filter-group">
              {TIME_FILTERS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={`filter-chip${timeFilter === t.id ? ' is-active' : ''}`}
                  onClick={() => setTimeFilter(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </span>
          </div>

          {visible.length === 0 ? (
            <p className="library-no-match">Nothing modified in this period.</p>
          ) : (
            <ul className="library-list">
              {visible.map((doc) => {
                const type = DOC_TYPES.find((t) => t.id === docTypeOf(doc))!;
                return (
                  <li key={doc.id}>
                    <button
                      type="button"
                      className="doc-row"
                      style={{ ['--type-color' as string]: type.color }}
                      onClick={() => onOpen(doc)}
                    >
                      <span className="doc-row-bar" />
                      <span className="doc-row-main">
                        <span className="doc-row-name" title={doc.name}>
                          {doc.name}
                          {doc.remoteKind && <span className="doc-card-remote"> ⛁ {doc.remoteKind}</span>}
                        </span>
                        <span className="doc-row-path" title={doc.path}>
                          {doc.path}
                        </span>
                      </span>
                      <span className="doc-row-meta">
                        <span>
                          {doc.versionCount} version{doc.versionCount === 1 ? '' : 's'}
                        </span>
                        <span>
                          {doc.branchCount} branch{doc.branchCount === 1 ? '' : 'es'}
                        </span>
                        <span className="doc-row-date">
                          {doc.lastVersionAt
                            ? new Date(doc.lastVersionAt).toLocaleDateString(undefined, {
                                day: 'numeric',
                                month: 'short',
                              })
                            : '—'}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </main>
  );
}

function SharedDocDialog(props: { provider: string; onClose: (shared: boolean, myName: string | null) => Promise<void> }) {
  const [name, setName] = useState('');
  return (
    <Modal title={`This document is in ${props.provider}`} onClose={() => void props.onClose(false, null)}>
      <p className="modal-hint">
        If this folder is shared with other people, DocGit can show who made each change — it reads the editor's name
        that Word/Excel/PowerPoint save inside the file. What name should it show for <strong>your</strong> edits?
      </p>
      <input
        autoFocus
        className="input"
        placeholder="Your name (e.g. “Gibril B.”)"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && name.trim()) void props.onClose(true, name.trim());
        }}
      />
      <div className="modal-actions">
        <button type="button" className="btn" onClick={() => void props.onClose(false, null)}>
          Just me — not shared
        </button>
        <button type="button" className="btn btn-primary" disabled={!name.trim()} onClick={() => void props.onClose(true, name.trim())}>
          It's shared
        </button>
      </div>
    </Modal>
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
