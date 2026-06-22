import { useCallback, useEffect, useMemo, useState } from 'react';
import { buildFolderTree, type FolderNode } from '@docgit/core/folders';
import type { DocumentInfo, WorkspaceFile } from '../../../preload/api';

/**
 * The "sealed workspace folder" view (#52/#157): shows the real Office files in
 * the workspace tree. Tracked files are highlighted and open their history;
 * untracked files are one click from being tracked.
 */
export function WorkspaceFolders({
  root,
  documents,
  onOpen,
  onRefresh,
  onWorkspaceChanged,
}: {
  root: string;
  documents: DocumentInfo[];
  onOpen: (doc: DocumentInfo) => void;
  onRefresh: () => Promise<void>;
  onWorkspaceChanged: () => Promise<void>;
}) {
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [folders, setFolders] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [tracking, setTracking] = useState<string | null>(null);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const rescan = useCallback(async () => {
    const { files: f, folders: created } = await window.docgit.scanWorkspace();
    setFiles(f);
    setFolders(created);
  }, []);
  useEffect(() => {
    void rescan();
  }, [rescan, root]);

  const docByPath = useMemo(() => new Map(documents.map((d) => [d.path, d])), [documents]);
  const fileByPath = useMemo(() => new Map(files.map((f) => [f.path, f])), [files]);
  // Build from the scanned files PLUS tracked docs (so an out-of-root tracked
  // doc still shows, under "Other locations") PLUS explicitly-created folders
  // (so an empty folder is still visible).
  const tree = useMemo(() => {
    const paths = [...new Set([...files.map((f) => f.path), ...documents.map((d) => d.path)])];
    return buildFolderTree(paths, root, folders);
  }, [files, documents, root, folders]);

  const createFolder = async () => {
    const name = newFolderName.trim();
    if (!name) return;
    try {
      await window.docgit.createFolder(root, name); // created at the root for now
      setNewFolderName('');
      setNewFolderOpen(false);
      await rescan();
    } catch {
      // surfaced via disabled state; keep the input open for a retry
    }
  };

  const moveInto = async (documentId: string, targetDir: string) => {
    setDropTarget(null);
    try {
      await window.docgit.moveDocument(documentId, targetDir);
      await onRefresh();
      await rescan();
    } catch {
      // a locked/conflicting move is reported by the main process; tree is unchanged
    }
  };

  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const startTracking = async (path: string) => {
    setTracking(path);
    try {
      await window.docgit.addDocumentByPath(path);
      await onRefresh(); // refresh the tracked-documents list…
      await rescan(); // …then re-scan so the file flips to tracked
    } finally {
      setTracking(null);
    }
  };

  const renderFile = (path: string) => {
    const doc = docByPath.get(path);
    const name = fileByPath.get(path)?.name ?? doc?.name ?? path.split('/').pop() ?? path;
    if (doc) {
      return (
        <button
          key={path}
          type="button"
          className="ws-file ws-file-tracked"
          onClick={() => onOpen(doc)}
          draggable
          onDragStart={(e) => e.dataTransfer.setData('text/docgit-doc', doc.id)}
          title={`${path} — drag into a folder to move it`}
        >
          <span className="ws-file-name">{name}</span>
          <span className="ws-file-meta">
            {doc.versionCount} version{doc.versionCount === 1 ? '' : 's'} · tracked
          </span>
        </button>
      );
    }
    return (
      <button
        key={path}
        type="button"
        className="ws-file ws-file-untracked"
        disabled={tracking === path}
        onClick={() => void startTracking(path)}
        title={`${path} — click to track with DocGit`}
      >
        <span className="ws-file-name">{name}</span>
        <span className="ws-file-meta">{tracking === path ? 'Tracking…' : 'Click to track with DocGit'}</span>
      </button>
    );
  };

  const renderFolder = (node: FolderNode, depth: number) => {
    const isCollapsed = collapsed.has(node.path);
    return (
      <div key={node.path} className="ws-folder" style={{ marginLeft: node.name ? 14 : 0 }}>
        {node.name && (
          <button
            type="button"
            className={`ws-folder-header${dropTarget === node.path ? ' ws-drop' : ''}`}
            onClick={() => toggle(node.path)}
            onDragOver={(e) => {
              e.preventDefault();
              setDropTarget(node.path);
            }}
            onDragLeave={() => setDropTarget((t) => (t === node.path ? null : t))}
            onDrop={(e) => {
              e.preventDefault();
              const id = e.dataTransfer.getData('text/docgit-doc');
              if (id) void moveInto(id, node.path);
            }}
          >
            <span className="ws-folder-caret">{isCollapsed ? '▸' : '▾'}</span> {node.name}
          </button>
        )}
        {!isCollapsed && (
          <>
            {node.docPaths.map(renderFile)}
            {node.folders.map((f) => renderFolder(f, depth + 1))}
          </>
        )}
      </div>
    );
  };

  const empty =
    tree.root.docPaths.length === 0 && tree.root.folders.length === 0 && tree.otherLocations.length === 0;

  return (
    <div className="workspace-view">
      <div className="workspace-bar">
        <span className="workspace-root" title={root}>
          📁 {root}
        </span>
        <span className="workspace-bar-actions">
          {newFolderOpen ? (
            <span className="ws-newfolder">
              <input
                autoFocus
                className="input ws-newfolder-input"
                placeholder="Folder name"
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void createFolder();
                  if (e.key === 'Escape') setNewFolderOpen(false);
                }}
              />
              <button type="button" className="btn btn-mini btn-primary" onClick={() => void createFolder()}>
                Create
              </button>
            </span>
          ) : (
            <button type="button" className="btn btn-mini" onClick={() => setNewFolderOpen(true)}>
              + New folder
            </button>
          )}
          <button type="button" className="btn btn-mini" onClick={() => void window.docgit.setWorkspaceRoot().then(onWorkspaceChanged)}>
            Change…
          </button>
          <button type="button" className="btn btn-mini" onClick={() => void window.docgit.clearWorkspaceRoot().then(onWorkspaceChanged)}>
            Clear
          </button>
        </span>
      </div>
      {empty ? (
        <p className="workspace-empty-hint">No Word, Excel, or PowerPoint files in this folder yet. Drag a tracked file onto a folder to move it.</p>
      ) : (
        <div
          className={`workspace-tree${dropTarget === root ? ' ws-drop' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDropTarget(root);
          }}
          onDragLeave={() => setDropTarget((t) => (t === root ? null : t))}
          onDrop={(e) => {
            // Dropping on the tree background (not a folder header) moves to the root.
            if (dropTarget === root) {
              const id = e.dataTransfer.getData('text/docgit-doc');
              if (id) void moveInto(id, root);
            }
          }}
        >
          {renderFolder(tree.root, 0)}
          {tree.otherLocations.length > 0 && (
            <div className="ws-folder">
              <div className="ws-folder-header ws-folder-other">Other locations</div>
              {tree.otherLocations.map(renderFile)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
