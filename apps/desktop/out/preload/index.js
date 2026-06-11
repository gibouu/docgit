"use strict";
const electron = require("electron");
const api = {
  listDocuments: () => electron.ipcRenderer.invoke("docs:list"),
  addDocument: () => electron.ipcRenderer.invoke("docs:add"),
  openDocument: (documentId) => electron.ipcRenderer.invoke("docs:open", documentId),
  getGraph: (documentId) => electron.ipcRenderer.invoke("docs:graph", documentId),
  saveVersion: (documentId, message) => electron.ipcRenderer.invoke("version:save", documentId, message),
  getDiff: (fromId, toId) => electron.ipcRenderer.invoke("version:diff", fromId, toId),
  getDivergence: (commitId) => electron.ipcRenderer.invoke("version:divergence", commitId),
  restoreVersion: (documentId, commitId) => electron.ipcRenderer.invoke("version:restore", documentId, commitId),
  openVersionCopy: (commitId) => electron.ipcRenderer.invoke("version:openCopy", commitId),
  createBranch: (documentId, name, fromCommitId) => electron.ipcRenderer.invoke("branch:create", documentId, name, fromCommitId),
  switchBranch: (documentId, branchId) => electron.ipcRenderer.invoke("branch:switch", documentId, branchId),
  renameBranch: (documentId, branchId, name) => electron.ipcRenderer.invoke("branch:rename", documentId, branchId, name),
  setBranchColor: (documentId, branchId, color) => electron.ipcRenderer.invoke("branch:color", documentId, branchId, color),
  setBranchArchived: (documentId, branchId, archived) => electron.ipcRenderer.invoke("branch:archive", documentId, branchId, archived),
  markSent: (documentId, commitId, info) => electron.ipcRenderer.invoke("send:mark", documentId, commitId, info),
  onChanged: (callback) => {
    const listener = (_event, documentId) => callback(documentId);
    electron.ipcRenderer.on("docgit:changed", listener);
    return () => electron.ipcRenderer.removeListener("docgit:changed", listener);
  }
};
electron.contextBridge.exposeInMainWorld("docgit", api);
