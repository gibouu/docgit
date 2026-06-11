export {
  blockText,
  canonicalJson,
  type Block,
  type DocModel,
  type ParagraphBlock,
  type TableBlock,
} from './model/types.js';
export { parseDocx } from './adapters/word/parse.js';
export { SnapshotStore, type CommitResult, type CommitRow } from './store/store.js';
export {
  diffModels,
  similarity,
  type Change,
  type ChangeType,
  type DiffSummary,
  type DocDiff,
  type WordSpan,
} from './diff/diff.js';
