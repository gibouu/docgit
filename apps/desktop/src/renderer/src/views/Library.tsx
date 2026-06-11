import type { DocumentSummary } from '@docgit/core';

export interface LibraryProps {
  documents: DocumentSummary[];
  onOpen: (doc: DocumentSummary) => void;
  onRefresh: () => Promise<void>;
}

/**
 * The hub: every tracked document lives here. Users open documents through
 * DocGit so every Word save quietly becomes a version.
 */
export function Library({ documents, onOpen, onRefresh }: LibraryProps) {
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
        <button type="button" className="btn btn-primary" onClick={() => void addDocument()}>
          + Add document
        </button>
      </header>

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
                <span className="doc-card-name">{doc.name}</span>
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
