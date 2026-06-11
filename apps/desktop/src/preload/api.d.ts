import type {
  BranchRow,
  CommitResult,
  DocDiff,
  DocumentGraph,
  DocumentRow,
  DocumentSummary,
  SendRow,
} from '@docgit/core';

/** Renderer-side view of the preload bridge, with IPC-resolved types. */
export interface DocgitApi {
  listDocuments(): Promise<DocumentSummary[]>;
  addDocument(): Promise<DocumentRow | null>;
  openDocument(documentId: string): Promise<string>;
  getGraph(documentId: string): Promise<DocumentGraph>;

  saveVersion(documentId: string, message?: string): Promise<CommitResult>;
  getDiff(fromId: string, toId: string): Promise<{ diff: DocDiff; fromLabel: string; toLabel: string }>;
  getDivergence(commitId: string): Promise<number | null>;
  renameVersion(documentId: string, commitId: string, message: string): Promise<void>;
  restoreVersion(documentId: string, commitId: string): Promise<CommitResult>;
  openVersionCopy(commitId: string): Promise<string>;

  createBranch(documentId: string, name: string, fromCommitId: string): Promise<BranchRow>;
  switchBranch(documentId: string, branchId: string): Promise<BranchRow>;
  renameBranch(documentId: string, branchId: string, name: string): Promise<BranchRow>;
  setBranchColor(documentId: string, branchId: string, color: string): Promise<BranchRow>;
  setBranchArchived(documentId: string, branchId: string, archived: boolean): Promise<BranchRow>;

  markSent(
    documentId: string,
    commitId: string,
    info: { recipient: string; channel?: string; note?: string },
  ): Promise<SendRow>;

  onChanged(callback: (documentId: string) => void): () => void;
}

declare global {
  interface Window {
    docgit: DocgitApi;
  }
}

export {};
