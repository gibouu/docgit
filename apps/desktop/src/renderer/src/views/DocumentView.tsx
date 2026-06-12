import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BranchRow, CommitRow, DocDiff, DocumentGraph, DocumentSummary } from '@docgit/core';
import { BranchGraph, DiffView } from '@docgit/ui';
import { Modal } from '../components/Modal.js';

export interface DocumentViewProps {
  document: DocumentSummary;
  onBack: () => void;
}

type DialogState =
  | { kind: 'branch'; from: CommitRow }
  | { kind: 'send'; commit: CommitRow }
  | { kind: 'restore'; commit: CommitRow; behind: number | null }
  | { kind: 'renameVersion'; commit: CommitRow }
  | { kind: 'renameBranch'; branch: BranchRow }
  | null;

export function DocumentView({ document: doc, onBack }: DocumentViewProps) {
  const [graph, setGraph] = useState<DocumentGraph | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [comparison, setComparison] = useState<{ diff: DocDiff; fromLabel: string; toLabel: string } | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [showArchived, setShowArchived] = useState(false);

  const treeScrollRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    setGraph(await window.docgit.getGraph(doc.id));
  }, [doc.id]);

  useEffect(() => {
    void refresh();
    return window.docgit.onChanged((id) => {
      if (id === doc.id) void refresh();
    });
  }, [doc.id, refresh]);

  // Newest version lives at the bottom — keep it in view as the tree grows.
  useEffect(() => {
    const el = treeScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [graph?.commits.length]);

  const commitsById = useMemo(() => new Map((graph?.commits ?? []).map((c) => [c.id, c])), [graph]);
  const selected = selectedIds.map((id) => commitsById.get(id)).filter(Boolean) as CommitRow[];

  const onSelect = useCallback((commit: CommitRow, additive: boolean) => {
    setComparison(null);
    setSelectedIds((prev) => {
      if (additive && prev.length >= 1 && !prev.includes(commit.id)) return [...prev.slice(-1), commit.id];
      if (prev.length === 1 && prev[0] === commit.id) return [];
      return [commit.id];
    });
  }, []);

  const compare = async () => {
    if (selected.length !== 2) return;
    // Older version on the left.
    const [a, b] = selected[0]!.createdAt <= selected[1]!.createdAt ? [selected[0]!, selected[1]!] : [selected[1]!, selected[0]!];
    setComparison(await window.docgit.getDiff(a.id, b.id));
  };

  const askRestore = async (commit: CommitRow) => {
    setDialog({ kind: 'restore', commit, behind: await window.docgit.getDivergence(commit.id) });
  };

  if (!graph) return <main className="docview" />;

  const currentBranch = graph.branches.find((b) => b.id === graph.document.currentBranchId);
  const hasArchived = graph.branches.some((b) => b.archived);
  const trunk = graph.branches[0]; // position 0 — Main

  const compareBranchToMain = async (branch: BranchRow) => {
    if (!trunk?.headCommitId || !branch.headCommitId) return;
    setSelectedIds([]);
    const result = await window.docgit.getDiff(trunk.headCommitId, branch.headCommitId);
    setComparison({ ...result, fromLabel: `${trunk.name} — latest`, toLabel: `${branch.name} — latest` });
  };

  // Always offered while working on a variant — identical heads simply show
  // an all-unchanged comparison, which is itself an answer.
  const canCompareToMain =
    currentBranch && trunk && currentBranch.id !== trunk.id && !!currentBranch.headCommitId && !!trunk.headCommitId;

  return (
    <main className="docview">
      <header className="docview-header">
        <button type="button" className="btn btn-ghost" onClick={onBack}>
          ‹ All documents
        </button>
        <div className="docview-title">
          <h1>{doc.name}</h1>
          <label className="branch-switcher" style={{ ['--dg-pill' as string]: currentBranch?.color }}>
            <span className="branch-switcher-dot" style={{ background: currentBranch?.color }} />
            <select
              value={graph.document.currentBranchId}
              onChange={(e) => void window.docgit.switchBranch(doc.id, e.target.value)}
              title="Switch branch — the document file follows"
            >
              {graph.branches
                .filter((b) => !b.archived || b.id === graph.document.currentBranchId)
                .map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
            </select>
          </label>
        </div>
        <div className="docview-actions">
          {hasArchived && (
            <label className="docview-archived-toggle">
              <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
              archived
            </label>
          )}
          {canCompareToMain && (
            <button type="button" className="btn" onClick={() => void compareBranchToMain(currentBranch)}>
              Compare with {trunk.name}
            </button>
          )}
          <button type="button" className="btn btn-primary" onClick={() => void window.docgit.openDocument(doc.id)}>
            Open in Word
          </button>
        </div>
      </header>

      <div className="docview-body">
        <section className="docview-tree">
          <div className="docview-tree-scroll" ref={treeScrollRef}>
            <BranchGraph
              branches={graph.branches}
              commits={graph.commits}
              sends={graph.sends}
              currentBranchId={graph.document.currentBranchId}
              selectedIds={selectedIds}
              onSelect={onSelect}
              showArchived={showArchived}
            />
          </div>
          <footer className="docview-tree-hint">
            First version at the top, newest at the bottom. Click a version to inspect it — ⌘-click a second one to
            compare.
          </footer>
        </section>

        <aside className="docview-panel">
          {comparison ? (
            <>
              <div className="panel-bar">
                <h2>What changed</h2>
                <button type="button" className="btn btn-ghost" onClick={() => setComparison(null)}>
                  ✕ Close
                </button>
              </div>
              <DiffView diff={comparison.diff} oldLabel={comparison.fromLabel} newLabel={comparison.toLabel} />
            </>
          ) : selected.length === 2 ? (
            <div className="panel-cta">
              <p>
                Two versions selected —{' '}
                <strong>
                  {selected[0]!.message ?? 'version'} ↔ {selected[1]!.message ?? 'version'}
                </strong>
              </p>
              <button type="button" className="btn btn-primary" onClick={() => void compare()}>
                Compare these versions
              </button>
            </div>
          ) : selected.length === 1 ? (
            <VersionDetails
              commit={selected[0]!}
              graph={graph}
              onOpenCopy={() => void window.docgit.openVersionCopy(selected[0]!.id)}
              onBranch={() => setDialog({ kind: 'branch', from: selected[0]! })}
              onRestore={() => void askRestore(selected[0]!)}
              onSend={() => setDialog({ kind: 'send', commit: selected[0]! })}
              onSwitchTo={(branchId) => void window.docgit.switchBranch(doc.id, branchId)}
              onRename={(commit) => setDialog({ kind: 'renameVersion', commit })}
            />
          ) : (
            <BranchPanel
              graph={graph}
              onCompareToMain={(b) => void compareBranchToMain(b)}
              onRenameBranch={(b) => setDialog({ kind: 'renameBranch', branch: b })}
            />
          )}
        </aside>
      </div>

      {dialog?.kind === 'renameVersion' && (
        <NameDialog
          title="Rename this version"
          placeholder="e.g. “Fees negotiated v2”"
          initial={dialog.commit.message ?? ''}
          submitLabel="Rename"
          onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            await window.docgit.renameVersion(doc.id, dialog.commit.id, name);
            setDialog(null);
          }}
        />
      )}
      {dialog?.kind === 'renameBranch' && (
        <NameDialog
          title={`Rename branch “${dialog.branch.name}”`}
          placeholder="Branch name"
          initial={dialog.branch.name}
          submitLabel="Rename"
          onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            await window.docgit.renameBranch(doc.id, dialog.branch.id, name);
            setDialog(null);
          }}
        />
      )}
      {dialog?.kind === 'branch' && (
        <BranchDialog
          onClose={() => setDialog(null)}
          onCreate={async (name) => {
            await window.docgit.createBranch(doc.id, name, dialog.from.id);
            setDialog(null);
          }}
        />
      )}
      {dialog?.kind === 'send' && (
        <SendDialog
          onClose={() => setDialog(null)}
          onMark={async (recipient, channel) => {
            await window.docgit.markSent(doc.id, dialog.commit.id, { recipient, channel: channel || undefined });
            setDialog(null);
          }}
        />
      )}
      {dialog?.kind === 'restore' && (
        <Modal title="Restore this version?" onClose={() => setDialog(null)}>
          {dialog.behind !== null && dialog.behind > 0 ? (
            <p>
              The document has moved on by <strong>{dialog.behind} version{dialog.behind > 1 ? 's' : ''}</strong> since
              this one. Restoring won't lose anything — today's content stays in the history.
            </p>
          ) : (
            <p>The file on disk will be replaced with this version's content. Nothing is lost — every version stays in the history.</p>
          )}
          <div className="modal-actions">
            <button type="button" className="btn" onClick={() => setDialog(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={async () => {
                await window.docgit.restoreVersion(doc.id, dialog.commit.id);
                setDialog(null);
                setSelectedIds([]);
              }}
            >
              Restore
            </button>
          </div>
        </Modal>
      )}
    </main>
  );
}

function VersionDetails(props: {
  commit: CommitRow;
  graph: DocumentGraph;
  onOpenCopy: () => void;
  onBranch: () => void;
  onRestore: () => void;
  onSend: () => void;
  onSwitchTo: (branchId: string) => void;
  onRename: (commit: CommitRow) => void;
}) {
  const { commit, graph } = props;
  const branch = graph.branches.find((b) => b.id === commit.branchId);
  const sends = graph.sends.filter((s) => s.commitId === commit.id);
  const isHead = branch?.headCommitId === commit.id;
  // Branches whose tip is this version and that aren't the working branch —
  // selecting another branch's tip is how you jump onto that branch.
  const switchableBranches = graph.branches.filter(
    (b) => b.headCommitId === commit.id && b.id !== graph.document.currentBranchId && !b.archived,
  );

  return (
    <div className="version-details">
      <h2>
        {commit.message ?? 'Saved version'}{' '}
        <button type="button" className="btn btn-mini" onClick={() => props.onRename(commit)} title="Rename this version">
          ✎ Rename
        </button>
      </h2>
      <dl>
        <div>
          <dt>When</dt>
          <dd>{new Date(commit.createdAt).toLocaleString()}</dd>
        </div>
        <div>
          <dt>Branch</dt>
          <dd>
            <span className="dg-branch-pill" style={{ ['--dg-pill' as string]: branch?.color }}>
              {branch?.name}
            </span>
          </dd>
        </div>
        {sends.length > 0 && (
          <div>
            <dt>Sent to</dt>
            <dd>
              {sends.map((s) => (
                <div key={s.id} className="send-line">
                  ✉ {s.recipient}
                  {s.channel ? ` · ${s.channel}` : ''} · {new Date(s.sentAt).toLocaleDateString()}
                </div>
              ))}
            </dd>
          </div>
        )}
      </dl>

      <div className="version-actions">
        {switchableBranches.map((b) => (
          <button key={b.id} type="button" className="btn btn-primary" onClick={() => props.onSwitchTo(b.id)}>
            Work on “{b.name}”
          </button>
        ))}
        <button type="button" className="btn" onClick={props.onOpenCopy} title="Opens a read-only temp copy — edits there are not tracked">
          Preview a copy
        </button>
        <button type="button" className="btn" onClick={props.onBranch}>
          Branch from here
        </button>
        {!isHead && (
          <button type="button" className="btn" onClick={props.onRestore}>
            Restore
          </button>
        )}
        <button type="button" className="btn" onClick={props.onSend}>
          Mark as sent…
        </button>
      </div>
    </div>
  );
}

const SWATCHES = ['#6366f1', '#10b981', '#f59e0b', '#ec4899', '#06b6d4', '#8b5cf6', '#ef4444', '#84cc16'];

function NameDialog(props: {
  title: string;
  placeholder: string;
  initial: string;
  submitLabel: string;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(props.initial);
  const submit = () => {
    if (name.trim()) void props.onSubmit(name.trim());
  };
  return (
    <Modal title={props.title} onClose={props.onClose}>
      <input
        autoFocus
        className="input"
        placeholder={props.placeholder}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onFocus={(e) => e.target.select()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
        }}
      />
      <div className="modal-actions">
        <button type="button" className="btn" onClick={props.onClose}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary" disabled={!name.trim()} onClick={submit}>
          {props.submitLabel}
        </button>
      </div>
    </Modal>
  );
}

function BranchPanel({
  graph,
  onCompareToMain,
  onRenameBranch,
}: {
  graph: DocumentGraph;
  onCompareToMain: (b: BranchRow) => void;
  onRenameBranch: (b: BranchRow) => void;
}) {
  const docId = graph.document.id;
  const trunk = graph.branches[0];
  return (
    <div className="branch-panel">
      <h2>Branches</h2>
      <ul>
        {graph.branches.map((branch) => {
          const isCurrent = branch.id === graph.document.currentBranchId;
          const comparable =
            trunk &&
            branch.id !== trunk.id &&
            !!branch.headCommitId &&
            !!trunk.headCommitId &&
            branch.headCommitId !== trunk.headCommitId;
          return (
            <li key={branch.id} className={branch.archived ? 'is-archived' : ''}>
              <span className="branch-swatch" style={{ background: branch.color }} />
              <span className="branch-name">
                {branch.name}
                {branch.archived ? ' (archived)' : ''}
              </span>
              <span className="branch-tools">
                {comparable && (
                  <button type="button" className="btn btn-mini" onClick={() => onCompareToMain(branch)}>
                    Compare to {trunk!.name}
                  </button>
                )}
                {!isCurrent && !branch.archived && (
                  <button type="button" className="btn btn-mini" onClick={() => void window.docgit.switchBranch(docId, branch.id)}>
                    Switch to
                  </button>
                )}
                {isCurrent && <span className="branch-current-tag">current</span>}
                <button type="button" className="btn btn-mini" onClick={() => onRenameBranch(branch)}>
                  Rename
                </button>
                <select
                  className="branch-color-pick"
                  value={branch.color}
                  title="Branch color"
                  onChange={(e) => void window.docgit.setBranchColor(docId, branch.id, e.target.value)}
                >
                  {[...new Set([branch.color, ...SWATCHES])].map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
                {!isCurrent && (
                  <button
                    type="button"
                    className="btn btn-mini"
                    onClick={() => void window.docgit.setBranchArchived(docId, branch.id, !branch.archived)}
                  >
                    {branch.archived ? 'Unarchive' : 'Archive'}
                  </button>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="branch-panel-hint">
        Select a version in the tree to open, branch, restore, or mark it as sent.
      </p>
    </div>
  );
}

function BranchDialog(props: { onClose: () => void; onCreate: (name: string) => Promise<void> }) {
  const [name, setName] = useState('');
  return (
    <Modal title="New branch from this version" onClose={props.onClose}>
      <p className="modal-hint">e.g. “CV — Marketing roles”, “Contract — Client B”, “French version”</p>
      <input
        autoFocus
        className="input"
        placeholder="Branch name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && name.trim()) void props.onCreate(name.trim());
        }}
      />
      <div className="modal-actions">
        <button type="button" className="btn" onClick={props.onClose}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary" disabled={!name.trim()} onClick={() => void props.onCreate(name.trim())}>
          Create branch
        </button>
      </div>
    </Modal>
  );
}

function SendDialog(props: { onClose: () => void; onMark: (recipient: string, channel: string) => Promise<void> }) {
  const [recipient, setRecipient] = useState('');
  const [channel, setChannel] = useState('email');
  return (
    <Modal title="Mark this version as sent" onClose={props.onClose}>
      <input
        autoFocus
        className="input"
        placeholder="Recipient — e.g. “Acme Recruiting”"
        value={recipient}
        onChange={(e) => setRecipient(e.target.value)}
      />
      <select className="input" value={channel} onChange={(e) => setChannel(e.target.value)}>
        <option value="email">email</option>
        <option value="link">link</option>
        <option value="post">post</option>
        <option value="other">other</option>
      </select>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={props.onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!recipient.trim()}
          onClick={() => void props.onMark(recipient.trim(), channel)}
        >
          Mark as sent
        </button>
      </div>
    </Modal>
  );
}
