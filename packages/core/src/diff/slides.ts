import { diffWords } from 'diff';
import type { PresentationModel, SlideShape } from '../model/types.js';
import type { WordSpan } from './diff.js';

/**
 * Slide/shape-level presentation diff. Slides are matched by PowerPoint's
 * persistent slide id, so a reordered slide reads as "moved", not as a
 * delete + insert; shapes within a slide match by name, with word-level
 * highlighting on edited text.
 */

export interface ShapeChange {
  type: 'added' | 'removed' | 'modified';
  name: string;
  oldText?: string;
  newText?: string;
  /** Word-level highlighting for modified shapes. */
  spans?: WordSpan[];
}

export interface SlideChange {
  type: 'added' | 'removed' | 'modified' | 'moved' | 'unchanged';
  /** True whenever the slide changed position, even if its shapes also changed. */
  moved: boolean;
  slideId: string;
  /** 0-based position in the old deck (absent for added slides). */
  oldIndex?: number;
  /** 0-based position in the new deck (absent for removed slides). */
  newIndex?: number;
  shapeChanges: ShapeChange[];
}

export interface SlidesDiffSummary {
  slidesAdded: number;
  slidesRemoved: number;
  slidesModified: number;
  slidesMoved: number;
  slidesUnchanged: number;
  shapesChanged: number;
}

export interface SlidesDiff {
  kind: 'slides';
  slideChanges: SlideChange[];
  summary: SlidesDiffSummary;
}

export function diffSlideModels(oldModel: PresentationModel, newModel: PresentationModel): SlidesDiff {
  const oldById = new Map(oldModel.slides.map((s, i) => [s.id, { slide: s, index: i }]));
  const newIds = new Set(newModel.slides.map((s) => s.id));

  const slideChanges: SlideChange[] = [];
  const summary: SlidesDiffSummary = {
    slidesAdded: 0,
    slidesRemoved: 0,
    slidesModified: 0,
    slidesMoved: 0,
    slidesUnchanged: 0,
    shapesChanged: 0,
  };

  newModel.slides.forEach((slide, newIndex) => {
    const old = oldById.get(slide.id);
    if (!old) {
      summary.slidesAdded++;
      const shapeChanges = slide.shapes.map((s) => ({ type: 'added' as const, name: s.name, newText: s.text }));
      summary.shapesChanged += shapeChanges.length; // an added slide's shapes are changes too
      slideChanges.push({ type: 'added', moved: false, slideId: slide.id, newIndex, shapeChanges });
      return;
    }
    const shapeChanges = diffShapes(old.slide.shapes, slide.shapes);
    summary.shapesChanged += shapeChanges.length;
    // Movement and edits are independent signals: a reordered slide whose text
    // also changed is BOTH moved and modified, and each is counted on its own.
    const moved = old.index !== newIndex;
    const modified = shapeChanges.length > 0;
    if (moved) summary.slidesMoved++;
    if (modified) summary.slidesModified++;
    if (!moved && !modified) summary.slidesUnchanged++;
    const type = modified ? 'modified' : moved ? 'moved' : 'unchanged';
    slideChanges.push({ type, moved, slideId: slide.id, oldIndex: old.index, newIndex, shapeChanges });
  });

  oldModel.slides.forEach((slide, oldIndex) => {
    if (newIds.has(slide.id)) return;
    summary.slidesRemoved++;
    const shapeChanges = slide.shapes.map((s) => ({ type: 'removed' as const, name: s.name, oldText: s.text }));
    summary.shapesChanged += shapeChanges.length; // a removed slide's shapes are changes too
    slideChanges.push({ type: 'removed', moved: false, slideId: slide.id, oldIndex, shapeChanges });
  });

  return { kind: 'slides', slideChanges, summary };
}

function diffShapes(oldShapes: SlideShape[], newShapes: SlideShape[]): ShapeChange[] {
  // PowerPoint shape names aren't unique. Group old shapes by name into queues
  // and match the k-th new "Body" to the k-th old "Body", so duplicates aren't
  // collapsed (which would miss removals or mismatch edits).
  const oldQueues = new Map<string, SlideShape[]>();
  for (const s of oldShapes) {
    const q = oldQueues.get(s.name);
    if (q) q.push(s);
    else oldQueues.set(s.name, [s]);
  }
  const matched = new Set<SlideShape>();
  const changes: ShapeChange[] = [];

  for (const shape of newShapes) {
    const old = oldQueues.get(shape.name)?.shift();
    if (!old) {
      changes.push({ type: 'added', name: shape.name, newText: shape.text });
    } else {
      matched.add(old);
      if (old.text !== shape.text) {
        changes.push({
          type: 'modified',
          name: shape.name,
          oldText: old.text,
          newText: shape.text,
          spans: diffWords(old.text, shape.text).map((part) => ({
            text: part.value,
            kind: part.added ? 'added' : part.removed ? 'removed' : 'same',
          })),
        });
      }
    }
  }
  // Any old shape never matched is a removal, reported in original order.
  for (const shape of oldShapes) {
    if (!matched.has(shape)) changes.push({ type: 'removed', name: shape.name, oldText: shape.text });
  }
  return changes;
}
