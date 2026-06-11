export {
  blockText,
  canonicalJson,
  type Block,
  type DocModel,
  type ParagraphBlock,
  type TableBlock,
} from './model/types.js';
export { parseDocx } from './adapters/word/parse.js';
export {
  SnapshotStore,
  type BranchRow,
  type CommitResult,
  type CommitRow,
  type DocumentGraph,
  type DocumentRow,
  type DocumentSummary,
  type SendRow,
} from './store/store.js';
export {
  diffModels,
  similarity,
  type Change,
  type ChangeType,
  type DiffSummary,
  type DocDiff,
  type FormattingChange,
  type WordSpan,
} from './diff/diff.js';
