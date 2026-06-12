import { useEffect, useState } from 'react';
import type { RecipientSend, RecipientSummary } from '../../../preload/api';

/**
 * Per-recipient send history: everything ever sent to someone, across all
 * documents — "which exact version did Acme get, and when?"
 */
export function SentHistory(props: { onBack: () => void; onOpenVersion: (documentId: string, commitId: string) => void }) {
  const [recipients, setRecipients] = useState<RecipientSummary[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [sends, setSends] = useState<RecipientSend[]>([]);

  useEffect(() => {
    void window.docgit.recipients().then(setRecipients);
  }, []);

  useEffect(() => {
    if (open === null) return;
    void window.docgit.sendsToRecipient(open).then(setSends);
  }, [open]);

  return (
    <main className="library">
      <header className="library-header">
        <div>
          <h1>Sent history</h1>
          <p className="library-sub">Every version that ever left this Mac, grouped by who received it.</p>
        </div>
        <button type="button" className="btn" onClick={props.onBack}>
          ‹ All documents
        </button>
      </header>

      {recipients.length === 0 ? (
        <div className="library-empty">
          <div className="library-empty-mark">✉</div>
          <h2>Nothing marked as sent yet</h2>
          <p>
            When you send a document to someone, select that version in its tree and use “Mark as sent…” — then this
            page answers “which version does Acme have?” forever.
          </p>
        </div>
      ) : (
        <ul className="recipients-list">
          {recipients.map((r) => (
            <li key={r.recipient}>
              <button
                type="button"
                className={`recipient-row${open === r.recipient ? ' is-open' : ''}`}
                onClick={() => setOpen(open === r.recipient ? null : r.recipient)}
              >
                <span className="recipient-name">✉ {r.recipient}</span>
                <span className="recipient-meta">
                  {r.sendCount} version{r.sendCount === 1 ? '' : 's'} · last{' '}
                  {new Date(r.lastSentAt).toLocaleDateString()}
                </span>
              </button>
              {open === r.recipient && (
                <ul className="recipient-sends">
                  {sends.map((send) => (
                    <li key={send.id}>
                      <span className="send-doc">{send.documentName}</span>
                      <span className="send-version">{send.commitMessage ?? 'Saved version'}</span>
                      <span className="send-when">
                        {new Date(send.sentAt).toLocaleDateString()}
                        {send.channel ? ` · ${send.channel}` : ''}
                      </span>
                      <button
                        type="button"
                        className="btn btn-mini"
                        onClick={() => props.onOpenVersion(send.documentId, send.commitId)}
                      >
                        Show version
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
