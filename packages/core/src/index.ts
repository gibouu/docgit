export {
  blockText,
  canonicalJson,
  type Block,
  type CellValue,
  type DocModel,
  type ParagraphBlock,
  type PresentationModel,
  type SheetModel,
  type SlideModel,
  type SlideShape,
  type SpreadsheetModel,
  type TableBlock,
  type TextDocModel,
} from './model/types.js';
export { parseDocx } from './adapters/word/parse.js';
export { parseXlsx } from './adapters/excel/parse.js';
export { parsePptx } from './adapters/powerpoint/parse.js';
export { parseDocument, SUPPORTED_EXTENSIONS } from './adapters/parse.js';
export { GristClient, type GristConfig } from './adapters/grist/client.js';
export {
  isRemoteKey,
  SnapshotStore,
  type BranchRow,
  type CommitResult,
  type CommitRow,
  type DocumentGraph,
  type DocumentRow,
  type DocumentSummary,
  type LinkRow,
  type RemoteRow,
  type SendRow,
  type UpstreamStatus,
} from './store/store.js';
export { formatValue, type ValueFormat } from './links/format.js';
export {
  findLinkableOccurrences,
  insertLinkedValue,
  listLinkIds,
  refreshLinkedValue,
  type LinkableOccurrence,
} from './links/word-links.js';
export {
  diffModels,
  diffTextModels,
  similarity,
  type Change,
  type ChangeType,
  type DiffSummary,
  type DocDiff,
  type FormattingChange,
  type TextDiff,
  type WordSpan,
} from './diff/diff.js';
export {
  diffSpreadsheetModels,
  type CellChange,
  type SpreadsheetDiff,
  type SpreadsheetDiffSummary,
} from './diff/spreadsheet.js';
export {
  diffSlideModels,
  type ShapeChange,
  type SlideChange,
  type SlidesDiff,
  type SlidesDiffSummary,
} from './diff/slides.js';
