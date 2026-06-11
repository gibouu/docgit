import { contextBridge, ipcRenderer } from 'electron';

/**
 * The typed bridge the renderer sees as `window.docgit`. Pure pass-through to
 * main-process IPC — no logic here.
 */
const api = {
  listDocuments: () => ipcRenderer.invoke('docs:list'),
  addDocument: () => ipcRenderer.invoke('docs:add'),
  openDocument: (documentId: string) => ipcRenderer.invoke('docs:open', documentId),
  getGraph: (documentId: string) => ipcRenderer.invoke('docs:graph', documentId),

  saveVersion: (documentId: string, message?: string) => ipcRenderer.invoke('version:save', documentId, message),
  getDiff: (fromId: string, toId: string) => ipcRenderer.invoke('version:diff', fromId, toId),
  getDivergence: (commitId: string) => ipcRenderer.invoke('version:divergence', commitId),
  restoreVersion: (documentId: string, commitId: string) =>
    ipcRenderer.invoke('version:restore', documentId, commitId),
  openVersionCopy: (commitId: string) => ipcRenderer.invoke('version:openCopy', commitId),

  createBranch: (documentId: string, name: string, fromCommitId: string) =>
    ipcRenderer.invoke('branch:create', documentId, name, fromCommitId),
  switchBranch: (documentId: string, branchId: string) => ipcRenderer.invoke('branch:switch', documentId, branchId),
  renameBranch: (documentId: string, branchId: string, name: string) =>
    ipcRenderer.invoke('branch:rename', documentId, branchId, name),
  setBranchColor: (documentId: string, branchId: string, color: string) =>
    ipcRenderer.invoke('branch:color', documentId, branchId, color),
  setBranchArchived: (documentId: string, branchId: string, archived: boolean) =>
    ipcRenderer.invoke('branch:archive', documentId, branchId, archived),

  markSent: (documentId: string, commitId: string, info: { recipient: string; channel?: string; note?: string }) =>
    ipcRenderer.invoke('send:mark', documentId, commitId, info),

  onChanged: (callback: (documentId: string) => void) => {
    const listener = (_event: unknown, documentId: string) => callback(documentId);
    ipcRenderer.on('docgit:changed', listener);
    return () => ipcRenderer.removeListener('docgit:changed', listener);
  },
};

export type DocgitApi = typeof api;

contextBridge.exposeInMainWorld('docgit', api);
