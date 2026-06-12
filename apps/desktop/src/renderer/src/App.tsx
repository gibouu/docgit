import { useCallback, useEffect, useState } from 'react';
import type { DocumentSummary } from '@docgit/core';
import { Library } from './views/Library.js';
import { DocumentView } from './views/DocumentView.js';
import { SentHistory } from './views/SentHistory.js';

type Route =
  | { kind: 'library' }
  | { kind: 'history' }
  | { kind: 'doc'; id: string; commitId?: string };

export function App() {
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [route, setRoute] = useState<Route>({ kind: 'library' });

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
