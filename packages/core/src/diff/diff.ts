import { diffArrays, diffWords } from 'diff';
import { blockText, type Block, type DocModel } from '../model/types.js';

/**
 * Paragraph-level content diff between two normalized models.
 *
 * Pipeline:
 *  1. Sequence diff (Myers, via jsdiff) over block content keys →
 *     unchanged / removed / added runs.
 *  2. Within each replaced hunk, pair removed↔added blocks by text
 *     similarity → "modified", with word-level spans for highlighting.
 *  3. Across the whole document, identical blocks that were removed in one
 *     place and added in another are reported as "moved", not as an
 *     unrelated delete + insert — a classic adversarial case for legal docs.
 */

export type ChangeType = 'unchanged' | 'added' | 'removed' | 'modified' | 'moved';

export interface WordSpan {
  text: string;
  kind: 'same' | 'added' | 'removed';
}

export interface Change {
  type: ChangeType;
  /** Index in the old document (absent for pure additions). */
  oldIndex?: number;
  /** Index in the new document (absent for pure removals). */
  newIndex?: number;
  oldBlock?: Block;
  newBlock?: Block;
  /** Word-level highlighting, present on "modified" changes. */
  spans?: WordSpan[];
}

export interface DiffSummary {
  added: number;
  removed: number;
  modified: number;
  moved: number;
  unchanged: number;
}

export interface DocDiff {
  changes: Change[];
  summary: DiffSummary;
}

/** Minimum token-Dice similarity for a removed/added pair to count as an edit of the same paragraph. */
const MODIFIED_THRESHOLD = 0.4;

export function diffModels(oldModel: DocModel, newModel: DocModel): DocDiff {
  const oldBlocks = oldModel.blocks;
  const newBlocks = newModel.blocks;
  const oldKeys = oldBlocks.map(blockText);
  const newKeys = newBlocks.map(blockText);

  const parts = diffArrays(oldKeys, newKeys);

  const changes: Change[] = [];
  let oldIdx = 0;
  let newIdx = 0;
  let pendingRemoved: Change[] = [];

  const flushPending = (addedRun: Change[]) => {
    changes.push(...pairHunk(pendingRemoved, addedRun));
    pendingRemoved = [];
  };

  for (const part of parts) {
    if (part.removed) {
      for (const _ of part.value) {
        pendingRemoved.push({
          type: 'removed',
          oldIndex: oldIdx,
          oldBlock: oldBlocks[oldIdx],
        });
        oldIdx++;
      }
    } else if (part.added) {
      const addedRun: Change[] = [];
      for (const _ of part.value) {
        addedRun.push({
          type: 'added',
          newIndex: newIdx,
          newBlock: newBlocks[newIdx],
        });
        newIdx++;
      }
      flushPending(addedRun);
    } else {
      flushPending([]);
      for (const _ of part.value) {
        changes.push({
          type: 'unchanged',
          oldIndex: oldIdx,
          newIndex: newIdx,
          oldBlock: oldBlocks[oldIdx],
          newBlock: newBlocks[newIdx],
        });
        oldIdx++;
        newIdx++;
      }
    }
  }
  flushPending([]);

  detectMoves(changes);

  return { changes, summary: summarize(changes) };
}

/**
 * Pair removed and added blocks of one replacement hunk by best text
 * similarity; pairs above the threshold become "modified" with word spans,
 * the rest stay as plain removals/additions, emitted in document order.
 */
function pairHunk(removed: Change[], added: Change[]): Change[] {
  if (removed.length === 0 || added.length === 0) return [...removed, ...added];

  const matchedAdded = new Set<number>();
  const result: Change[] = [];

  for (const rem of removed) {
    const remText = blockText(rem.oldBlock!);
    let best = -1;
    let bestScore = 0;
    for (let i = 0; i < added.length; i++) {
      if (matchedAdded.has(i)) continue;
      const score = similarity(remText, blockText(added[i]!.newBlock!));
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best >= 0 && bestScore >= MODIFIED_THRESHOLD) {
      matchedAdded.add(best);
      const add = added[best]!;
      result.push({
        type: 'modified',
        oldIndex: rem.oldIndex,
        newIndex: add.newIndex,
        oldBlock: rem.oldBlock,
        newBlock: add.newBlock,
        spans: wordSpans(remText, blockText(add.newBlock!)),
      });
    } else {
      result.push(rem);
    }
  }
  for (let i = 0; i < added.length; i++) {
    if (!matchedAdded.has(i)) result.push(added[i]!);
  }
  return result;
}

/**
 * Convert exact-text removed+added pairs into a single "moved" change.
 * Whitespace-only blocks are ignored — empty paragraphs move around
 * meaninglessly when documents are restructured.
 */
function detectMoves(changes: Change[]): void {
  const removedByText = new Map<string, Change[]>();
  for (const change of changes) {
    if (change.type !== 'removed') continue;
    const text = blockText(change.oldBlock!);
    if (text.trim() === '') continue;
    const list = removedByText.get(text);
    if (list) list.push(change);
    else removedByText.set(text, [change]);
  }
  if (removedByText.size === 0) return;

  const toDrop = new Set<Change>();
  for (const change of changes) {
    if (change.type !== 'added') continue;
    const text = blockText(change.newBlock!);
    const candidates = removedByText.get(text);
    const partner = candidates?.shift();
    if (!partner) continue;
    change.type = 'moved';
    change.oldIndex = partner.oldIndex;
    change.oldBlock = partner.oldBlock;
    toDrop.add(partner);
  }
  if (toDrop.size > 0) {
    let write = 0;
    for (let read = 0; read < changes.length; read++) {
      if (!toDrop.has(changes[read]!)) changes[write++] = changes[read]!;
    }
    changes.length = write;
  }
}

function summarize(changes: Change[]): DiffSummary {
  const summary: DiffSummary = { added: 0, removed: 0, modified: 0, moved: 0, unchanged: 0 };
  for (const change of changes) summary[change.type]++;
  return summary;
}

/** Token-set Dice coefficient — cheap similarity for pairing edited paragraphs. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const ta = tokenSet(a);
  const tb = tokenSet(b);
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersection = 0;
  for (const token of ta) {
    if (tb.has(token)) intersection++;
  }
  return (2 * intersection) / (ta.size + tb.size);
}

function tokenSet(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[\s.,;:!?()[\]{}'"«»]+/).filter(Boolean));
}

function wordSpans(oldText: string, newText: string): WordSpan[] {
  return diffWords(oldText, newText).map((part) => ({
    text: part.value,
    kind: part.added ? 'added' : part.removed ? 'removed' : 'same',
  }));
}
