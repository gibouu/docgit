# Architectural decisions (newest first)

[2026-06-13] dist: Developer ID + notarization (not App Store). Why: free direct distribution from GitHub Releases.
[2026-06-12] license: MIT, public repo. Why: user wants verifiable open source with no data-transfer claims.
[2026-06-12] cloud: detect via path prefixes (Mobile Documents, CloudStorage/*), warn not block on switch. Why: tracking stays useful; only switching is dangerous.
[2026-06-12] grist: read-only remote docs, never write back; poll 15s (no webhooks — desktop has no callback URL). Why: avoid clobbering shared server data.
[2026-06-11] store: node:sqlite not better-sqlite3. Why: zero native deps, same build in system Node + Electron.
[2026-06-11] shell: Electron not Tauri. Why: TS core runs natively in main process.
[2026-06-11] links: tagged w:sdt content controls + string surgery on document.xml. Why: survive Word edits, byte-stable untouched parts.
