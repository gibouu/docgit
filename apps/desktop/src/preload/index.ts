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
  renameVersion: (documentId: string, commitId: string, message: string) =>
    ipcRenderer.invoke('version:rename', documentId, commitId, message),
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

  connectGrist: (baseUrl: string, remoteDocId: string, apiKey?: string) =>
    ipcRenderer.invoke('grist:connect', baseUrl, remoteDocId, apiKey),
  syncRemote: (documentId: string) => ipcRenderer.invoke('remote:sync', documentId),

  branchStatuses: (documentId: string) => ipcRenderer.invoke('branch:statuses', documentId),
  markBranchSynced: (documentId: string, branchId: string) =>
    ipcRenderer.invoke('branch:markSynced', documentId, branchId),
  recipients: () => ipcRenderer.invoke('history:recipients'),
  sendsToRecipient: (recipient: string) => ipcRenderer.invoke('history:sends', recipient),

  listLinks: (documentId: string) => ipcRenderer.invoke('links:list', documentId),
  listWorkbooks: () => ipcRenderer.invoke('links:workbooks'),
  workbookSheets: (sourceDocumentId: string) => ipcRenderer.invoke('links:sheets', sourceDocumentId),
  workbookCell: (sourceDocumentId: string, sheet: string, cellRef: string) =>
    ipcRenderer.invoke('links:cell', sourceDocumentId, sheet, cellRef),
  findOccurrences: (documentId: string, search: string) =>
    ipcRenderer.invoke('links:occurrences', documentId, search),
  createLink: (documentId: string, payload: unknown) => ipcRenderer.invoke('links:create', documentId, payload),
  refreshLinks: (documentId: string) => ipcRenderer.invoke('links:refresh', documentId),
  deleteLink: (documentId: string, linkId: string) => ipcRenderer.invoke('links:delete', documentId, linkId),

  onChanged: (callback: (documentId: string) => void) => {
    const listener = (_event: unknown, documentId: string) => callback(documentId);
    ipcRenderer.on('docgit:changed', listener);
    return () => ipcRenderer.removeListener('docgit:changed', listener);
  },
};

export type DocgitApi = typeof api;

contextBridge.exposeInMainWorld('docgit', api);
