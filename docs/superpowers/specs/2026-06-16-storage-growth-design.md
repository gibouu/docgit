# Storage Growth — Part-Level Object Store (Design / Recorded Plan)

Date: 2026-06-16
Status: **Recorded plan — to be built as its own dedicated project later.** Not scheduled in this round.
Issue: #25

This documents the agreed direction for solving DocGit's long-term disk growth so
it can be picked up later without re-deciding the approach.

## The problem (plain terms)

Word/Excel/PowerPoint files are zip archives containing many parts: the text
(`document.xml`), and separately every image, font, chart, etc. Today DocGit
stores the **whole zipped file** for each version (content-addressed in the
`objects` table, so byte-identical files are stored once, and auto-save
coalescing caps the version count).

The failure mode is **embedded media**. Change one word in a 10 MB deck and the
zip's bytes shift entirely → a new file hash → DocGit stores another ~10 MB, even
though the images never changed. Fifty saves ≈ 500 MB for a deck whose pictures
were static. Text-only documents are fine; media-heavy ones bloat.

## The fix (the git model): part-level content-addressed storage

Stop storing the whole zip. Unzip each document and store **each internal part**
as its own content-addressed object, plus a small **manifest** per version
listing which part-hashes (and their archive paths/metadata) compose that file.

- Save #1 → store `document.xml`(v1), `media/image1.png`, `media/image2.png`, and
  a manifest `{document.xml→h1, image1→h2, image2→h3}`.
- Save #2 (text edit) → only `document.xml` changed → store `document.xml`(v2) +
  a new manifest. `image1`/`image2` already exist (same hash) → **0 extra bytes**.

You only pay for parts that actually change. The 10 MB × 50 deck collapses to
~10 MB + 50 tiny text deltas. Reconstructing a version = read its manifest,
fetch each part, re-zip (OOXML zip is deterministic enough to round-trip; store
the original zip's entry order/metadata in the manifest to reproduce byte-exact
files where needed).

This fits the existing schema: parts are just more rows in `objects`
(`hash → BLOB`). New tables: a `manifests`/`file_parts` mapping
`(commit/file_hash) → [part_path, part_hash, order, flags]`.

## Staged rollout (in payoff order)

1. **Part-level store** — the big win (often 10×+ for media-heavy files). Unzip on
   commit, store parts + manifest; reconstruct on read. Everything else
   (diff, branches, links) operates on the normalized model as today, so this is
   a storage-layer change behind `getFileBytes`/the commit path.
2. **Delta-compress text parts** — consecutive `document.xml` versions differ by a
   few hundred bytes; store diffs against a base instead of full copies. A smaller
   second win, mainly for documents saved very often.
3. **Garbage collection (`vacuum`)** — coalescing replaces commits but orphans
   their parts; a sweep deletes any object no manifest references, then SQLite
   `VACUUM` reclaims pages. This is what stops slow creep over time. Must be safe:
   only delete objects unreferenced by *any* manifest/commit/model.

## Migration & safety (the catch)

- **Coexistence:** existing databases hold whole-file blobs. The part store must
  run **alongside** the old representation — `getFileBytes` checks for a manifest
  first, else falls back to the legacy whole-file object. New commits use parts.
- **Backfill:** a one-time/background re-pack can convert old whole-file versions
  into parts and then GC the originals — opt-in or automatic-when-idle, never
  blocking, and never deleting until the part representation is verified to
  reconstruct byte-identical output.
- **Round-trip guarantee:** before GC removes a legacy blob, assert
  `reconstruct(parts) == originalBytes`. No version's content is ever lost.
- **Interactions to respect:** content-addressed dedup already exists; the live
  links system and diff operate on the model JSON (unaffected); the backup/export
  (#57) still works since it copies the whole DB regardless of representation.

## Why this is its own project

It's a core-engine change (`packages/core/src/store`) with real migration care and
a strong correctness bar (byte-exact reconstruction + safe GC). It should get its
own spec → plan → implementation cycle with thorough tests (round-trip every
adapter: docx/xlsx/pptx; dedup across versions; GC never deletes referenced
objects). Not bundled with small features.

## Acceptance (when built)

- [ ] A media-heavy document saved N times stores embedded media once, not N times
      (measured: DB size grows ~by changed-part size, not whole-file size).
- [ ] Every version reconstructs byte-identical (or model-identical where byte-exact
      isn't required) across docx/xlsx/pptx.
- [ ] Legacy whole-file databases keep working; backfill is safe and resumable.
- [ ] GC removes only truly-orphaned objects; `VACUUM` reclaims space.
- [ ] Backup/export (#57) and diffs/links/branches are unaffected.
