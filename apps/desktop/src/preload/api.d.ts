import type {
  BranchRow,
  CommitResult,
  DocDiff,
  DocumentGraph,
  DocumentRow,
  DocumentSummary,
  LinkableOccurrence,
  LinkRow,
  SendRow,
  ValueFormat,
} from '@docgit/core';

export interface LinkInfo {
  link: LinkRow;
  sourceName: string;
  stale: boolean;
  format: ValueFormat;
}

export interface CreateLinkPayload {
  sourceDocumentId: string;
  sheet: string;
  cellRef: string;
  format: ValueFormat;
  search: string;
  occurrence: number;
}

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

  listLinks(documentId: string): Promise<LinkInfo[]>;
  listWorkbooks(): Promise<DocumentSummary[]>;
  workbookSheets(sourceDocumentId: string): Promise<string[]>;
  workbookCell(
    sourceDocumentId: string,
    sheet: string,
    cellRef: string,
  ): Promise<{ value: string; formula?: string } | null>;
  findOccurrences(documentId: string, search: string): Promise<LinkableOccurrence[]>;
  createLink(documentId: string, payload: CreateLinkPayload): Promise<LinkInfo>;
  refreshLinks(documentId: string): Promise<number>;
  deleteLink(documentId: string, linkId: string): Promise<void>;

  onChanged(callback: (documentId: string) => void): () => void;
}

declare global {
  interface Window {
    docgit: DocgitApi;
  }
}

export {};
