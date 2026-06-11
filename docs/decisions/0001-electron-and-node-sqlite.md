# ADR 0001 — Electron (not Tauri) and node:sqlite (not better-sqlite3)

Date: 2026-06-11 · Status: accepted

## Desktop shell: Electron

Milestone 2 needs a macOS-only, local-first desktop app that runs the shared
TypeScript core (`@docgit/core`) directly.

- **Electron** runs the core in its Node-powered main process as-is: file
  watching, SQLite, OOXML parsing all stay in one language and one package.
- **Tauri** would put a Rust process in the middle: either re-expose the core
  through a Node sidecar (two runtimes) or rewrite parts in Rust (defeats the
  "one core library" requirement shared with the Office add-in).

Bundle size is a real Electron cost, but irrelevant next to keeping a single
core. Decision: **Electron**, revisit only if app size/footprint becomes a
user complaint.

## SQLite driver: node:sqlite

`better-sqlite3` is a native module compiled against a specific Node ABI.
Electron ships its own Node, so the same installed binary cannot serve both
`vitest` (system Node) and the app (Electron Node) without rebuild gymnastics
(`@electron/rebuild`, hoisting hacks, CI double-builds).

Node's built-in `node:sqlite` (DatabaseSync) has an equivalent synchronous
API, needs no compilation, and exists in both runtimes (system Node ≥ 22.5,
Electron ≥ 36). The core engine now depends on it instead — zero native
dependencies in the whole workspace.

Trade-off: `node:sqlite` is still marked experimental (warning on startup) and
has fewer features (no extensions, no backup API). Nothing DocGit needs today
uses those. If that changes, swapping the driver is contained in
`packages/core/src/store/store.ts`.
