import { contextBridge, ipcRenderer, webUtils } from 'electron';

/**
 * The typed bridge the renderer sees as `window.docgit`. Pure pass-through to
 * main-process IPC — no logic here.
 */
const api = {
  listDocuments: () => ipcRenderer.invoke('docs:list'),
  addDocument: () => ipcRenderer.invoke('docs:add'),
  openDocument: (documentId: string) => ipcRenderer.invoke('docs:open', documentId),
  getGraph: (documentId: string) => ipcRenderer.invoke('docs:graph', documentId),
  versionPreview: (commitId: string) => ipcRenderer.invoke('version:preview', commitId),

  saveVersion: (documentId: string, message?: string) => ipcRenderer.invoke('version:save', documentId, message),
  getDiff: (fromId: string, toId: string) => ipcRenderer.invoke('version:diff', fromId, toId),
  getDivergence: (commitId: string) => ipcRenderer.invoke('version:divergence', commitId),
  renameVersion: (documentId: string, commitId: string, message: string) =>
    ipcRenderer.invoke('version:rename', documentId, commitId, message),
  restoreVersion: (documentId: string, commitId: string) =>
    ipcRenderer.invoke('version:restore', documentId, commitId),
  openVersionCopy: (commitId: string) => ipcRenderer.invoke('version:openCopy', commitId),

  createBranch: (documentId: string, name: string, fromCommitId: string, reason?: string) =>
    ipcRenderer.invoke('branch:create', documentId, name, fromCommitId, reason),
  setBranchReason: (documentId: string, branchId: string, reason: string) =>
    ipcRenderer.invoke('branch:reason', documentId, branchId, reason),
  switchBranch: (documentId: string, branchId: string) => ipcRenderer.invoke('branch:switch', documentId, branchId),
  renameBranch: (documentId: string, branchId: string, name: string) =>
    ipcRenderer.invoke('branch:rename', documentId, branchId, name),
  setBranchColor: (documentId: string, branchId: string, color: string) =>
    ipcRenderer.invoke('branch:color', documentId, branchId, color),
  setBranchArchived: (documentId: string, branchId: string, archived: boolean) =>
    ipcRenderer.invoke('branch:archive', documentId, branchId, archived),

  markSent: (documentId: string, commitId: string, info: { recipient: string; channel?: string; note?: string }) =>
    ipcRenderer.invoke('send:mark', documentId, commitId, info),

  cloudStatus: (documentId: string) => ipcRenderer.invoke('docs:cloudStatus', documentId),
  setSharing: (documentId: string, shared: boolean, myName: string | null) =>
    ipcRenderer.invoke('docs:setSharing', documentId, shared, myName),
  addDocumentByPath: (path: string) => ipcRenderer.invoke('docs:addPath', path),
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  addDocumentByPaths: (paths: string[]) => ipcRenderer.invoke('docs:addPaths', paths),
  renameDocument: (documentId: string, newBaseName: string) =>
    ipcRenderer.invoke('docs:rename', documentId, newBaseName),
  deleteDocument: (documentId: string, opts: { trashFile: boolean }) =>
    ipcRenderer.invoke('docs:delete', documentId, opts),
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

  updateState: () => ipcRenderer.invoke('update:getState'),
  checkForUpdate: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  updateSettings: () => ipcRenderer.invoke('update:settings'),
  setAutoUpdate: (enabled: boolean) => ipcRenderer.invoke('update:setEnabled', enabled),
  markUpdateNoteSeen: () => ipcRenderer.invoke('update:markNoteSeen'),
  onUpdate: (callback: (state: unknown) => void) => {
    const listener = (_event: unknown, state: unknown) => callback(state);
    ipcRenderer.on('docgit:update', listener);
    return () => ipcRenderer.removeListener('docgit:update', listener);
  },

  runBackup: () => ipcRenderer.invoke('backup:run'),
  restoreBackup: () => ipcRenderer.invoke('backup:restore'),
  revealDataFolder: () => ipcRenderer.invoke('data:reveal'),

  cleanupCandidates: () => ipcRenderer.invoke('cleanup:candidates'),
  trashOldInstallers: (paths: string[]) => ipcRenderer.invoke('cleanup:trash', paths),

  getWorkspaceRoot: () => ipcRenderer.invoke('workspace:get'),
  setWorkspaceRoot: () => ipcRenderer.invoke('workspace:set'),
  clearWorkspaceRoot: () => ipcRenderer.invoke('workspace:clear'),
  scanWorkspace: () => ipcRenderer.invoke('workspace:scan'),
  createFolder: (parentPath: string, name: string) => ipcRenderer.invoke('workspace:createFolder', parentPath, name),
  moveDocument: (documentId: string, targetDir: string) => ipcRenderer.invoke('workspace:moveDocument', documentId, targetDir),
};

export type DocgitApi = typeof api;

contextBridge.exposeInMainWorld('docgit', api);
