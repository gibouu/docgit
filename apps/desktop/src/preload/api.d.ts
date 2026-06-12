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
  UpstreamStatus,
  ValueFormat,
} from '@docgit/core';

export type DocumentInfo = DocumentSummary & { remoteKind: string | null };

export interface RecipientSummary {
  recipient: string;
  sendCount: number;
  lastSentAt: string;
}

export interface RecipientSend extends SendRow {
  documentId: string;
  documentName: string;
  commitMessage: string | null;
}

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
  listDocuments(): Promise<DocumentInfo[]>;
  addDocument(): Promise<DocumentRow | null>;
  connectGrist(baseUrl: string, remoteDocId: string, apiKey?: string): Promise<DocumentRow>;
  syncRemote(documentId: string): Promise<CommitResult | undefined>;
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

  branchStatuses(documentId: string): Promise<{ branchId: string; status: UpstreamStatus | null }[]>;
  markBranchSynced(documentId: string, branchId: string): Promise<BranchRow>;
  recipients(): Promise<RecipientSummary[]>;
  sendsToRecipient(recipient: string): Promise<RecipientSend[]>;

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
