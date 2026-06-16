# Storage #25 — Stage 1: Part-Level Object Store (Concrete Design)

Date: 2026-06-16
Status: Approved direction (content-identical reconstruction confirmed by user). Ready for plan.
Issue: #25 · Parent design: `docs/superpowers/specs/2026-06-16-storage-growth-design.md`

This is the concrete, build-ready design for **Stage 1** (the part-level store). Stages 2
(delta-compress text parts) and 3 (garbage collection) remain separate, later projects.

## Decision locked

**Reconstruction is content-identical, not byte-identical.** Re-zipping OOXML with fflate
cannot reproduce Microsoft's exact container bytes (entry order is preserved, but DEFLATE
output/timestamps/central-directory differ). DocGit already ships fflate-rezipped `.docx`
to users via the live-links feature (`links/word-links.ts` `zipSync` → written to disk →
Word reopens it), so this is proven-safe in production. Nothing in DocGit depends on
byte-identity: no-op/coalesce detection and `restore` key on `model_hash`, diffs run on the
model, author attribution is captured at commit time. (See investigation in the parent
issue thread.)

## What changes (grounded in the current code)

Current flow (`packages/core/src/store/store.ts`):
- `commit()` computes `fileHash = sha256(fileBytes)` and `modelHash = sha256(modelJson)`,
  stores both whole blobs via `putObject` (`INSERT OR IGNORE INTO objects`), and records
  them on the `commits` row. Dedup is whole-file only → a 1-word edit in a media-heavy
  file re-stores the entire file.
- `getFileBytes(commit)` = `getObject(commit.fileHash)` (single blob).

Stage 1 keeps `model_hash` and the `commits` schema **unchanged**; it only changes how the
bytes behind `file_hash` are stored and reconstructed for OOXML files.

## Schema

New table (parts reuse `objects` for their bytes; manifest rows map a file to its parts):
```sql
CREATE TABLE IF NOT EXISTS file_parts (
  manifest_hash TEXT NOT NULL,      -- == commits.file_hash (sha256 of the ORIGINAL bytes)
  part_path     TEXT NOT NULL,      -- zip entry name, e.g. "word/media/image1.png"
  part_hash     TEXT NOT NULL REFERENCES objects(hash),  -- sha256 of the part's RAW (decompressed) bytes
  ordinal       INTEGER NOT NULL,   -- original entry order (stable re-zip)
  PRIMARY KEY (manifest_hash, part_path)
);
CREATE INDEX IF NOT EXISTS idx_file_parts_manifest ON file_parts(manifest_hash);
```
Bump `PRAGMA user_version` (currently 4 → 5) and add the table in `migrate()` (idempotent,
alongside the existing `CREATE TABLE IF NOT EXISTS` block). Keying the manifest by the
existing `file_hash` means **no `commits` change** and legacy rows keep their meaning.

## Commit path

Core must stay OOXML-agnostic (it already takes pre-parsed models). Pass an optional
decomposition into the store rather than unzipping inside core:
- Add an optional param to `commit(...)`: `parts?: { path: string; bytes: Uint8Array }[]`.
  The caller (the desktop/adapter layer, which ALREADY unzips via fflate in
  `adapters/*/parse.ts`) supplies the ordered part list for `.docx/.xlsx/.pptx`; for
  non-OOXML (a `.grist` SQLite snapshot, or anything not a zip) it passes nothing.
- In `commit()`, after computing `fileHash`:
  - If `parts` provided: for each part, `partHash = sha256(bytes)`, `putObject(partHash,
    bytes)` (dedup), insert `file_parts(fileHash, path, partHash, ordinal++)`. Do **not**
    `putObject(fileHash, fileBytes)` — skipping the whole-file blob is where the space is
    saved. Presence of `file_parts[fileHash]` is the "part-stored" signal.
  - Else (no parts): legacy `putObject(fileHash, fileBytes)` exactly as today.
- Helper to surface parts from a file: a small `decomposeOoxml(bytes): {path,bytes}[] | null`
  in core adapters (returns null for non-zip / non-OOXML), used by the commit caller. It
  reuses `unzipSync` and preserves entry order.

## Read path

`getFileBytes(commit)`:
```
parts = SELECT part_path, part_hash FROM file_parts WHERE manifest_hash = commit.fileHash ORDER BY ordinal
if parts.length:
    files = { path: getObject(part_hash) for each }
    return zipSync(files)          // content-identical container, Office-openable
else:
    return getObject(commit.fileHash)   // legacy whole-file blob
```
Manifest-first, legacy-fallback — both representations coexist permanently.

## Coexistence, migration, safety

- **Legacy commits** (existing DBs) have an `objects(file_hash)` blob and no `file_parts`
  rows → served by the fallback branch forever. New commits store parts. One DB, both.
- **No backfill in Stage 1.** Converting old whole-file commits to parts + dropping the
  originals belongs with **Stage 3 (GC)**, gated on a **content-identical** check
  (decompress the reconstructed zip and compare each part's bytes to the stored parts; or
  re-derive `model_hash`) — NOT byte-equality (the parent design's "byte-exact" assertion
  is corrected to content-identical here).
- **`writeFileFromCommit`** (service.ts) writes `getFileBytes` back to the user's disk on
  restore / branch-create / branch-switch / export. After Stage 1 those deliver the
  reconstructed (content-identical) file — already DocGit's behavior via links. The smoke
  must confirm a reconstructed file re-parses to the same model.
- **Non-OOXML guard:** `.grist` snapshots are SQLite, not zips → always legacy path. The
  decompose helper returns null for non-zip input; the commit caller must not force parts.

## Testing (the correctness bar)

Core vitest (`packages/core/test/`):
- **Round-trip per format (docx, xlsx, pptx):** commit a file with parts → `getFileBytes`
  → re-parse → assert `model_hash` unchanged, and each stored part's bytes match the input
  part bytes (content-identical).
- **Dedup across versions (the headline metric):** commit a media-heavy file, then commit
  a version with only the text part changed → assert the `objects` row count grows by ~the
  text part only (not the whole file). This is the acceptance proof for #25.
- **Legacy fallback:** a commit stored the old whole-file way still reconstructs via
  `getFileBytes`.
- **Non-OOXML:** a non-zip "file" commits via the legacy path (no `file_parts` rows) and
  reconstructs byte-for-byte.
- Existing `store.test.ts` / `branching.test.ts` (restore, branch-switch, `getFileBytes`)
  must keep passing.

Desktop smoke: extend `runSmokeTest` to commit a real `.docx` with parts, reconstruct, and
confirm it re-parses (the live, full-stack proof).

## Out of scope for Stage 1

- Delta compression of text parts (Stage 2).
- Garbage collection + backfill of legacy whole-file blobs (Stage 3).
- Any `commits`/`model_hash` change. Stage 1 is purely a `file_hash` storage swap.

## Risks to keep in view

- **Re-zip CPU on read** — `getFileBytes` now re-zips; only restore/branch-switch/export
  call it (not hot paths). Worth a quick benchmark in the plan.
- **fflate determinism** — entry order from `unzipSync` is preserved via `ordinal`; parts
  are stored decompressed so dedup is robust to re-compression differences.
- **Adapter coverage** — the decompose helper must handle all three OOXML kinds and reject
  non-zip cleanly.
