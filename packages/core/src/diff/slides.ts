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
      slideChanges.push({
        type: 'added',
        slideId: slide.id,
        newIndex,
        shapeChanges: slide.shapes.map((s) => ({ type: 'added' as const, name: s.name, newText: s.text })),
      });
      return;
    }
    const shapeChanges = diffShapes(old.slide.shapes, slide.shapes);
    summary.shapesChanged += shapeChanges.length;
    const moved = old.index !== newIndex;
    const type = shapeChanges.length > 0 ? 'modified' : moved ? 'moved' : 'unchanged';
    if (type === 'modified') summary.slidesModified++;
    else if (type === 'moved') summary.slidesMoved++;
    else summary.slidesUnchanged++;
    slideChanges.push({ type, slideId: slide.id, oldIndex: old.index, newIndex, shapeChanges });
  });

  oldModel.slides.forEach((slide, oldIndex) => {
    if (newIds.has(slide.id)) return;
    summary.slidesRemoved++;
    slideChanges.push({
      type: 'removed',
      slideId: slide.id,
      oldIndex,
      shapeChanges: slide.shapes.map((s) => ({ type: 'removed' as const, name: s.name, oldText: s.text })),
    });
  });

  return { kind: 'slides', slideChanges, summary };
}

function diffShapes(oldShapes: SlideShape[], newShapes: SlideShape[]): ShapeChange[] {
  const oldByName = new Map(oldShapes.map((s) => [s.name, s]));
  const newByName = new Map(newShapes.map((s) => [s.name, s]));
  const changes: ShapeChange[] = [];

  for (const shape of newShapes) {
    const old = oldByName.get(shape.name);
    if (!old) {
      changes.push({ type: 'added', name: shape.name, newText: shape.text });
    } else if (old.text !== shape.text) {
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
  for (const shape of oldShapes) {
    if (!newByName.has(shape.name)) changes.push({ type: 'removed', name: shape.name, oldText: shape.text });
  }
  return changes;
}
