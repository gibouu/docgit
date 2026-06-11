import { useCallback, useEffect, useState } from 'react';
import type { DocumentSummary } from '@docgit/core';
import { Library } from './views/Library.js';
import { DocumentView } from './views/DocumentView.js';

export function App() {
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [openDocId, setOpenDocId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setDocuments(await window.docgit.listDocuments());
  }, []);

  useEffect(() => {
    void refresh();
    return window.docgit.onChanged(() => void refresh());
  }, [refresh]);

  const openDoc = documents.find((d) => d.id === openDocId) ?? null;

  return (
    <div className="app">
      <div className="titlebar" />
      {openDoc ? (
        <DocumentView document={openDoc} onBack={() => setOpenDocId(null)} />
      ) : (
        <Library documents={documents} onOpen={(d) => setOpenDocId(d.id)} onRefresh={refresh} />
      )}
    </div>
  );
}
