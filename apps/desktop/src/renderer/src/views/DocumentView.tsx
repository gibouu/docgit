import { useCallback, useEffect, useMemo, useState } from 'react';
import type { BranchRow, CommitRow, DocDiff, DocumentGraph, UpstreamStatus } from '@docgit/core';
import type { CloudStatus, DocumentInfo } from '../../../preload/api';
import { DiffView, HorizontalBranchGraph } from '@docgit/ui';
import { Modal } from '../components/Modal.js';
import { LinksSection } from './LinksSection.js';

export interface DocumentViewProps {
  document: DocumentInfo;
  onBack: () => void;
  /** Pre-select this version on open (e.g. arriving from the sent history). */
  initialSelectedId?: string;
}

type DialogState =
  | { kind: 'branch'; from: CommitRow }
  | { kind: 'send'; commit: CommitRow }
  | { kind: 'restore'; commit: CommitRow; behind: number | null }
  | { kind: 'renameVersion'; commit: CommitRow }
  | { kind: 'renameBranch'; branch: BranchRow }
  | { kind: 'cloudSwitch'; branchId: string; branchName: string }
  | null;

type Tab = 'details' | 'changes' | 'sent' | 'links';

export function DocumentView({ document: doc, onBack, initialSelectedId }: DocumentViewProps) {
  const [graph, setGraph] = useState<DocumentGraph | null>(null);
  const [statuses, setStatuses] = useState<{ branchId: string; status: UpstreamStatus | null }[]>([]);
  const [cloud, setCloud] = useState<CloudStatus>({ provider: null, conflictCopies: [] });
  const [selectedIds, setSelectedIds] = useState<string[]>(initialSelectedId ? [initialSelectedId] : []);
  const [comparison, setComparison] = useState<{ diff: DocDiff; fromLabel: string; toLabel: string } | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [tab, setTab] = useState<Tab>('details');

  const refresh = useCallback(async () => {
    setGraph(await window.docgit.getGraph(doc.id));
    setStatuses(await window.docgit.branchStatuses(doc.id));
    setCloud(await window.docgit.cloudStatus(doc.id));
  }, [doc.id]);

  useEffect(() => {
    void refresh();
    return window.docgit.onChanged((id) => {
      if (id === doc.id) void refresh();
    });
  }, [doc.id, refresh]);

  const commitsById = useMemo(() => new Map((graph?.commits ?? []).map((c) => [c.id, c])), [graph]);
  const selected = selectedIds.map((id) => commitsById.get(id)).filter(Boolean) as CommitRow[];
  const lastSelected = selected.at(-1) ?? null;

  const onSelectNode = useCallback(
    (commit: CommitRow, additive: boolean) => {
      setComparison(null);
      setSelectedIds((prev) => {
        if (additive && prev.length >= 1 && !prev.includes(commit.id)) {
          setTab('changes');
          return [...prev.slice(-1), commit.id];
        }
        setTab('details');
        if (prev.length === 1 && prev[0] === commit.id) return [];
        return [commit.id];
      });
    },
    [],
  );

  const selectBranch = useCallback(
    (branchId: string) => {
      const branch = graph?.branches.find((b) => b.id === branchId);
      if (!branch?.headCommitId) return;
      setComparison(null);
      setSelectedIds([branch.headCommitId]);
      setTab('details');
    },
    [graph],
  );

  const askRestore = async (commit: CommitRow) => {
    setDialog({ kind: 'restore', commit, behind: await window.docgit.getDivergence(commit.id) });
  };

  if (!graph) return <main className="docview" />;

  const trunk = graph.branches[0];
  const currentBranch = graph.branches.find((b) => b.id === graph.document.currentBranchId);
  const hasArchived = graph.branches.some((b) => b.archived);
  const statusOf = (branchId: string) => statuses.find((s) => s.branchId === branchId)?.status ?? null;
  const visibleBranches = graph.branches.filter((b) => showArchived || !b.archived);

  const requestSwitch = (branchId: string) => {
    if (branchId === graph.document.currentBranchId) return;
    const branch = graph.branches.find((b) => b.id === branchId);
    if (cloud.provider) setDialog({ kind: 'cloudSwitch', branchId, branchName: branch?.name ?? 'branch' });
    else void window.docgit.switchBranch(doc.id, branchId);
  };

  const runCompare = async (fromId: string, toId: string, labels?: { from: string; to: string }) => {
    const result = await window.docgit.getDiff(fromId, toId);
    setComparison(labels ? { ...result, fromLabel: labels.from, toLabel: labels.to } : result);
    setTab('changes');
  };

  const compareSelectedPair = () => {
    if (selected.length !== 2) return;
    const [a, b] = selected[0]!.createdAt <= selected[1]!.createdAt ? [selected[0]!, selected[1]!] : [selected[1]!, selected[0]!];
    void runCompare(a.id, b.id);
  };

  const compareWithParent = (commit: CommitRow) => {
    if (!commit.parentId) return;
    void runCompare(commit.parentId, commit.id);
  };

  const compareBranchToMain = (branch: BranchRow) => {
    if (!trunk?.headCommitId || !branch.headCommitId) return;
    void runCompare(trunk.headCommitId, branch.headCommitId, { from: `${trunk.name} — latest`, to: `${branch.name} — latest` });
  };

  const showUpstreamChanges = (status: UpstreamStatus) => {
    void runCompare(status.baseCommitId, status.upstreamHeadCommitId, {
      from: 'Where this branch last caught up',
      to: `${status.upstreamBranchName} — latest`,
    });
  };

  const tabs: { id: Tab; icon: string; label: string }[] = [
    { id: 'details', icon: '◉', label: 'Details' },
    { id: 'changes', icon: '⇄', label: 'Changes' },
    { id: 'sent', icon: '✉', label: 'Sent' },
  ];
  if (!doc.remoteKind && doc.name.toLowerCase().endsWith('.docx')) tabs.push({ id: 'links', icon: '⛓', label: 'Links' });

  return (
    <main className="docview">
      <header className="docview-header">
        <button type="button" className="btn btn-ghost" onClick={onBack}>
          ‹ All documents
        </button>
        <div className="docview-title">
          <h1 title={doc.name}>{doc.name}</h1>
          <span className="docview-on" style={{ ['--dg-pill' as string]: currentBranch?.color }}>
            <span className="branch-switcher-dot" style={{ background: currentBranch?.color }} />
            on {currentBranch?.name}
          </span>
        </div>
        <div className="docview-actions">
          {hasArchived && (
            <label className="docview-archived-toggle">
              <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
              archived
            </label>
          )}
          {cloud.provider && (
            <span
              className="cloud-chip"
              title={`This file lives in a ${cloud.provider} folder. If the folder is shared, others receive every change DocGit writes — avoid switching branches on files other people edit live.`}
            >
              ☁ {cloud.provider}
            </span>
          )}
          {doc.remoteKind && (
            <button type="button" className="btn" onClick={() => void window.docgit.syncRemote(doc.id)}>
              Sync now
            </button>
          )}
          <button type="button" className="btn btn-primary" onClick={() => void window.docgit.openDocument(doc.id)}>
            {doc.remoteKind ? 'Open in Grist' : 'Open in Word'}
          </button>
        </div>
      </header>

      {cloud.conflictCopies.length > 0 && (
        <div className="cloud-banner">
          <strong>⚠ {cloud.provider ?? 'Your sync service'} created conflict copies of this document:</strong>
          {cloud.conflictCopies.map((path) => (
            <span key={path} className="cloud-conflict">
              {path.split('/').pop()}
              <button type="button" className="btn btn-mini" onClick={() => void window.docgit.addDocumentByPath(path)}>
                Track it
              </button>
            </span>
          ))}
          <span className="cloud-banner-hint">A conflict copy may hold someone else's edits that are not in this history.</span>
        </div>
      )}

      {/* Top: the tree viewer */}
      <section className="tree-viewer">
        <HorizontalBranchGraph
          branches={graph.branches}
          commits={graph.commits}
          sends={graph.sends}
          currentBranchId={graph.document.currentBranchId}
          selectedIds={selectedIds}
          onSelect={onSelectNode}
          onSelectBranch={selectBranch}
          showArchived={showArchived}
        />
        <span className="tree-viewer-hint">Drag to pan · click a version · ⌘-click a second to compare · click a branch name to jump</span>
      </section>

      {/* Bottom: the dock */}
      <div className="dock">
        <aside className="dock-left">
          <div className="dock-left-head">Branches</div>
          <ul className="dock-branches">
            {visibleBranches.map((branch) => {
              const isCurrent = branch.id === graph.document.currentBranchId;
              const isSelected = lastSelected?.branchId === branch.id;
              const status = statusOf(branch.id);
              return (
                <li key={branch.id}>
                  <button
                    type="button"
                    className={`dock-branch${isSelected ? ' is-selected' : ''}`}
                    onClick={() => selectBranch(branch.id)}
                  >
                    <span className="dock-branch-swatch" style={{ background: branch.color }} />
                    <span className="dock-branch-name" style={{ color: branch.color }}>
                      {branch.name}
                    </span>
                    {isCurrent && <span className="dock-branch-current">working</span>}
                    {status && status.behind > 0 && (
                      <span className="behind-badge behind-badge-mini" title={`${status.behind} upstream change(s) not in this branch`}>
                        −{status.behind}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </aside>

        <section className="dock-right">
          <div className="dock-tabs">
            {tabs.map((t) => (
              <button key={t.id} type="button" className={`dock-tab${tab === t.id ? ' is-active' : ''}`} onClick={() => setTab(t.id)}>
                <span className="dock-tab-icon">{t.icon}</span>
                {t.label}
              </button>
            ))}
          </div>

          <div className="dock-content">
            {tab === 'details' && (
              <DetailsTab
                doc={doc}
                graph={graph}
                commit={lastSelected}
                status={lastSelected ? statusOf(lastSelected.branchId) : null}
                readOnly={!!doc.remoteKind}
                onOpenCopy={(c) => void window.docgit.openVersionCopy(c.id)}
                onBranch={(c) => setDialog({ kind: 'branch', from: c })}
                onRestore={(c) => void askRestore(c)}
                onSend={(c) => setDialog({ kind: 'send', commit: c })}
                onSwitchTo={requestSwitch}
                onRenameVersion={(c) => setDialog({ kind: 'renameVersion', commit: c })}
                onRenameBranch={(b) => setDialog({ kind: 'renameBranch', branch: b })}
                onRecolor={(b, color) => void window.docgit.setBranchColor(doc.id, b.id, color)}
                onArchive={(b, archived) => void window.docgit.setBranchArchived(doc.id, b.id, archived)}
                onShowUpstream={showUpstreamChanges}
                onMarkSynced={(b) => void window.docgit.markBranchSynced(doc.id, b.id)}
              />
            )}

            {tab === 'changes' && (
              <ChangesTab
                comparison={comparison}
                selected={selected}
                trunk={trunk}
                lastSelected={lastSelected}
                onClose={() => setComparison(null)}
                onComparePair={compareSelectedPair}
                onCompareParent={compareWithParent}
                onCompareBranchToMain={compareBranchToMain}
                graph={graph}
              />
            )}

            {tab === 'sent' && <SentTab graph={graph} onOpenVersion={(id) => onSelectNode(commitsById.get(id)!, false)} />}

            {tab === 'links' && <LinksSection documentId={doc.id} />}
          </div>
        </section>
      </div>

      {dialog?.kind === 'cloudSwitch' && (
        <Modal title={`Switch branches in a ${cloud.provider} folder?`} onClose={() => setDialog(null)}>
          <p>
            Switching to <strong>“{dialog.branchName}”</strong> rewrites the file on disk with that branch's content.
            Because this file lives in {cloud.provider}, the rewrite syncs to <strong>everyone the folder is shared with</strong> —
            if someone else is editing it right now, your branches will collide with their work.
          </p>
          <p className="modal-hint">Safe if you're the only one using this file. Your own work is never lost either way.</p>
          <div className="modal-actions">
            <button type="button" className="btn" onClick={() => setDialog(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                void window.docgit.switchBranch(doc.id, dialog.branchId);
                setDialog(null);
              }}
            >
              Switch anyway
            </button>
          </div>
        </Modal>
      )}
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
            const branch = await window.docgit.createBranch(doc.id, name, dialog.from.id);
            setDialog(null);
            // Jump straight onto the new branch so it's obvious you're now in it.
            setComparison(null);
            setTab('details');
            if (branch.headCommitId) setSelectedIds([branch.headCommitId]);
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
              The document has moved on by <strong>{dialog.behind} version{dialog.behind > 1 ? 's' : ''}</strong> since this
              one. Restoring won't lose anything — today's content stays in the history.
            </p>
          ) : (
            <p>The file on disk will be replaced with this version's content. Nothing is lost — every version stays in the history.</p>
          )}
          {cloud.provider && (
            <p className="modal-hint">
              ⚠ This file lives in {cloud.provider} — the restored content syncs to everyone the folder is shared with.
            </p>
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

// ── Details tab ────────────────────────────────────────────────────────────

function DetailsTab(props: {
  doc: DocumentInfo;
  graph: DocumentGraph;
  commit: CommitRow | null;
  status: UpstreamStatus | null;
  readOnly: boolean;
  onOpenCopy: (c: CommitRow) => void;
  onBranch: (c: CommitRow) => void;
  onRestore: (c: CommitRow) => void;
  onSend: (c: CommitRow) => void;
  onSwitchTo: (branchId: string) => void;
  onRenameVersion: (c: CommitRow) => void;
  onRenameBranch: (b: BranchRow) => void;
  onRecolor: (b: BranchRow, color: string) => void;
  onArchive: (b: BranchRow, archived: boolean) => void;
  onShowUpstream: (s: UpstreamStatus) => void;
  onMarkSynced: (b: BranchRow) => void;
}) {
  const { graph, commit, readOnly } = props;
  const trunk = graph.branches[0];
  if (!commit) {
    return <p className="dock-empty">Pick a version in the tree, or a branch on the left, to see its details here.</p>;
  }
  const branch = graph.branches.find((b) => b.id === commit.branchId);
  const sends = graph.sends.filter((s) => s.commitId === commit.id);
  const isHead = branch?.headCommitId === commit.id;
  const isCurrentBranch = commit.branchId === graph.document.currentBranchId;
  const isWorkingHead = isHead && isCurrentBranch;
  const switchable = isHead && branch && !isCurrentBranch && !branch.archived;

  return (
    <div className="details-tab">
      <div className="details-main">
        <div className="version-details">
          <h2>
            {commit.message ?? 'Saved version'}{' '}
            {!readOnly && (
              <button type="button" className="btn btn-mini" onClick={() => props.onRenameVersion(commit)}>
                ✎ Rename
              </button>
            )}
          </h2>
          {!isHead && (
            <p className="not-latest">⚠ Not the latest version of “{branch?.name}” — you're looking at history.</p>
          )}
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
            {switchable && (
              <button type="button" className="btn btn-primary" onClick={() => props.onSwitchTo(branch!.id)}>
                Work on this branch
              </button>
            )}
            {!readOnly && isCurrentBranch && !isWorkingHead && (
              <button
                type="button"
                className="btn btn-primary"
                title="Make this version the latest on this branch — what Word will open"
                onClick={() => props.onRestore(commit)}
              >
                Restore this version
              </button>
            )}
            <button
              type="button"
              className="btn"
              onClick={() => props.onOpenCopy(commit)}
              title="Open a read-only copy of exactly this version in the Office app"
            >
              Open this version
            </button>
            {!readOnly && (
              <button type="button" className="btn" onClick={() => props.onBranch(commit)}>
                Branch from here
              </button>
            )}
            <button type="button" className="btn" onClick={() => props.onSend(commit)}>
              Mark as sent…
            </button>
          </div>

          {isHead && branch && (
            <div className="branch-controls">
              <span className="branch-controls-label">Branch “{branch.name}”</span>
              {props.status && props.status.behind > 0 && (
                <>
                  <button type="button" className="behind-badge" onClick={() => props.onShowUpstream(props.status!)}>
                    behind {props.status.upstreamBranchName} by {props.status.behind} — view
                  </button>
                  <button type="button" className="btn btn-mini" onClick={() => props.onMarkSynced(branch)}>
                    Caught up
                  </button>
                </>
              )}
              {!readOnly && (
                <button type="button" className="btn btn-mini" onClick={() => props.onRenameBranch(branch)}>
                  Rename branch
                </button>
              )}
              {!readOnly && (
                <select className="branch-color-pick" value={branch.color} title="Branch color" onChange={(e) => props.onRecolor(branch, e.target.value)}>
                  {[...new Set([branch.color, ...SWATCHES])].map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              )}
              {!readOnly && !isCurrentBranch && branch.id !== trunk?.id && (
                <button type="button" className="btn btn-mini" onClick={() => props.onArchive(branch, !branch.archived)}>
                  {branch.archived ? 'Unarchive' : 'Archive'}
                </button>
              )}
            </div>
          )}
        </div>

        <VersionPreview commitId={commit.id} />
      </div>
    </div>
  );
}

function VersionPreview({ commitId }: { commitId: string }) {
  const [lines, setLines] = useState<string[] | null>(null);
  useEffect(() => {
    let alive = true;
    setLines(null);
    void window.docgit.versionPreview(commitId).then((p) => {
      if (alive) setLines(p.lines);
    });
    return () => {
      alive = false;
    };
  }, [commitId]);

  return (
    <div className="version-preview">
      <div className="version-preview-head">Document preview</div>
      <div className="version-preview-body">
        {lines === null ? (
          <span className="dock-empty">Loading…</span>
        ) : lines.length === 0 ? (
          <span className="dock-empty">(empty)</span>
        ) : (
          lines.map((line, i) => (
            <p key={i} className={line.startsWith('▦') || line.startsWith('◻') ? 'version-preview-heading' : ''}>
              {line || ' '}
            </p>
          ))
        )}
      </div>
    </div>
  );
}

// ── Changes tab ────────────────────────────────────────────────────────────

function ChangesTab(props: {
  comparison: { diff: DocDiff; fromLabel: string; toLabel: string } | null;
  selected: CommitRow[];
  lastSelected: CommitRow | null;
  trunk: BranchRow | undefined;
  graph: DocumentGraph;
  onClose: () => void;
  onComparePair: () => void;
  onCompareParent: (c: CommitRow) => void;
  onCompareBranchToMain: (b: BranchRow) => void;
}) {
  const { comparison, selected, lastSelected, trunk, graph } = props;
  if (comparison) {
    return (
      <div className="changes-tab">
        <div className="panel-bar">
          <h2>What changed</h2>
          <button type="button" className="btn btn-ghost" onClick={props.onClose}>
            ✕ Close
          </button>
        </div>
        <DiffView diff={comparison.diff} oldLabel={comparison.fromLabel} newLabel={comparison.toLabel} />
      </div>
    );
  }
  if (selected.length === 2) {
    return (
      <div className="dock-cta">
        <p>
          Two versions selected — <strong>{selected[0]!.message ?? 'version'} ↔ {selected[1]!.message ?? 'version'}</strong>
        </p>
        <button type="button" className="btn btn-primary" onClick={props.onComparePair}>
          Compare these versions
        </button>
      </div>
    );
  }
  if (lastSelected) {
    const branch = graph.branches.find((b) => b.id === lastSelected.branchId);
    const canBranchVsMain = branch && trunk && branch.id !== trunk.id && !!branch.headCommitId && !!trunk.headCommitId;
    return (
      <div className="dock-cta">
        <p>Compare “{lastSelected.message ?? 'this version'}” with…</p>
        {lastSelected.parentId && (
          <button type="button" className="btn" onClick={() => props.onCompareParent(lastSelected)}>
            the previous version
          </button>
        )}
        {canBranchVsMain && branch && (
          <button type="button" className="btn" onClick={() => props.onCompareBranchToMain(branch)}>
            {trunk!.name} (latest)
          </button>
        )}
        <p className="dock-hint">…or ⌘-click a second version in the tree.</p>
      </div>
    );
  }
  return <p className="dock-empty">Select a version, then compare it with its previous version, with Main, or with any other version (⌘-click two).</p>;
}

// ── Sent tab ───────────────────────────────────────────────────────────────

function SentTab({ graph, onOpenVersion }: { graph: DocumentGraph; onOpenVersion: (commitId: string) => void }) {
  const byMessage = new Map(graph.commits.map((c) => [c.id, c.message]));
  if (graph.sends.length === 0) {
    return <p className="dock-empty">No version of this document has been marked as sent yet. Select a version → “Mark as sent…”.</p>;
  }
  const sends = [...graph.sends].sort((a, b) => b.sentAt.localeCompare(a.sentAt));
  return (
    <ul className="sent-tab">
      {sends.map((s) => (
        <li key={s.id}>
          <span className="sent-recipient">✉ {s.recipient}</span>
          <span className="sent-version">{byMessage.get(s.commitId) ?? 'Saved version'}</span>
          <span className="sent-when">
            {new Date(s.sentAt).toLocaleDateString()}
            {s.channel ? ` · ${s.channel}` : ''}
          </span>
          <button type="button" className="btn btn-mini" onClick={() => onOpenVersion(s.commitId)}>
            Show version
          </button>
        </li>
      ))}
    </ul>
  );
}

// ── Dialogs & shared bits ──────────────────────────────────────────────────

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

function BranchDialog(props: { onClose: () => void; onCreate: (name: string) => Promise<void> }) {
  const [name, setName] = useState('');
  return (
    <Modal title="Name this branch" onClose={props.onClose}>
      <p className="modal-hint">
        A branch is a named variant of this document with its own life — give it the purpose it exists for: “CV — Marketing
        roles”, “Contract — Client B”, “French version”.
      </p>
      <input
        autoFocus
        className="input"
        placeholder="What is this variant for?"
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
        <button type="button" className="btn btn-primary" disabled={!recipient.trim()} onClick={() => void props.onMark(recipient.trim(), channel)}>
          Mark as sent
        </button>
      </div>
    </Modal>
  );
}
