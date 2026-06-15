# Technical notes — known limits, risks, and future work

A living document. Every shipped feature's known rough edges land here so
they can be polished, fixed, or removed deliberately instead of being
forgotten. Add to it whenever a new limit is discovered.

## 1. iCloud / shared cloud folders with multiple users (issue #24)

DocGit is local-first: the version database lives on *one* Mac. When the
tracked file sits in an iCloud Drive folder **shared with another person who
also runs DocGit**, the file becomes a shared mutable object while each
user's history and branch state stay private. Consequences, roughly in order
of severity:

- **Branch switching is unsafe on shared files.** Switching branches rewrites
  the file on disk; iCloud syncs that rewrite to the other person's Mac as if
  it were an edit. If both users sit on different branches, the file
  ping-pongs between two heads and both databases record the other side's
  content as ordinary saves. *Planned mitigation: detect iCloud paths
  (`~/Library/Mobile Documents/…`) and warn or disable branch switching for
  shared files until DocGit has its own sharing layer (the optional sync
  server in the spec is the real fix).*
- **The other user's edits arrive as anonymous auto-saves.** B's work syncs
  down and A's watcher commits it as "Saved" with no author. Histories on the
  two Macs are *different trees that happen to sample the same file*. Send
  tags, branches, renames don't transfer.
- **Conflict copies are invisible.** When iCloud can't merge concurrent edits
  it creates `Contract 2.docx` next to the original. DocGit tracks the
  original path only — the conflict copy (possibly containing the other
  person's latest work) is silently untracked. *Planned mitigation: watch for
  conflict-copy siblings of tracked files and surface them.*
- **Eviction ("Optimize Mac Storage")** can replace the file with a
  placeholder; reads fail until iCloud re-downloads. The watcher and
  committer already skip unreadable files gracefully, but versioning silently
  pauses. *Possible mitigation: detect placeholder state and show it in the
  library.*
- **Live links double-fire.** If both users link the same workbook→document
  pair, both Macs rewrite the document on workbook changes. Content converges
  (same value, dedupe absorbs it) but the concurrent writes raise the odds of
  iCloud conflict copies.

**Practical guidance for now:** shared-folder use is fine for *one* DocGit
user per file (the other person's saves become versions — actually useful),
but avoid branch switching and restores on files other people edit live.

## 2. Storage growth — full-file snapshots (issue #25)

Every version currently stores the complete file bytes plus the normalized
model JSON, content-addressed (identical content is stored once, and
auto-save coalescing caps version count). For text-heavy documents this is
fine — a 300 KB contract × 200 versions ≈ 60 MB worst case.

It degrades with **embedded media**: OOXML files are ZIPs whose size is
usually dominated by images. A 10 MB deck saved 50 times stores ~500 MB even
though the images never changed.

Planned fix, in order:

1. **Part-level object store** (the git model, biggest win): unzip the OOXML
   container and store each *part* (`document.xml`, `media/image1.png`, …) as
   its own content-addressed object plus a per-version manifest. Unchanged
   images are stored exactly once across all versions. Fits the existing
   store cleanly.
2. **Delta/packfile compression** of consecutive XML parts (they differ by a
   few hundred bytes between saves) — optional second stage.
3. **Garbage collection.** Coalescing replaces commits but never deletes
   their orphaned objects; a `vacuum` pass should reap unreferenced hashes.

## 3. OOXML adapter limits

- **Live links: single-run text only.** A value can only be bound when it
  sits inside one text run. Word fragments runs unpredictably (spell-check
  history, formatting boundaries); if "Find" misses, retype the value in Word
  and save. *Future: run-merging normalization pass before matching.*
- **Excel row/column shifts read as mass cell edits.** Inserting a row above
  data shifts every reference below it; the diff reports all of them as
  modified. *Future: row-shift detection, like the paragraph move detection
  the text differ already has.*
- **Excel date cells show raw serial numbers** (e.g. `45292` for a date) —
  number-format-aware rendering not yet implemented.
- **Tracked changes are resolved to final state** on parse (insertions kept,
  deletions dropped). Pending-revision metadata (who proposed what) is not
  preserved in the model.

## 4. Grist integration limits

- **Polling, not webhooks.** Remote Grist documents are polled every 15 s;
  Grist webhooks need a reachable callback URL, which a desktop app doesn't
  naturally have. Webhook support (via a local listener) is future work.
- **Validated against a faithful API mock, not yet a live server.** The
  Electron smoke test runs the full flow (connect → change → version →
  link propagation) against an in-process mock of the documented REST API;
  first run against a real grist-core instance still pending.
- **Read-only**: DocGit never writes back to the Grist server — branch
  switching, restore and branching are disabled for remote documents.
- **API keys are stored in plaintext** in the local database. Acceptable for
  open local servers; should move to the macOS Keychain before use with
  hosted accounts.

## 5. App behaviors to know

- **Word holds files in memory.** Switching branches/restoring while the
  document is open in Word means Word's next save overwrites the new disk
  content with its stale buffer. The pre-overwrite safety snapshot rescues
  the data, but the working file may not be what you expect. *Planned: detect
  the document is open and warn before switching.*
- **Unlink keeps an inert content control** in the .docx (harmless, invisible
  in Word). *Future: unwrap the control on unlink.*
- **The version database** lives at `~/Library/Application Support/DocGit/`
  (migrated automatically from the pre-packaging Electron directory; the old
  copy is left in place as a backup and can be deleted manually).
- **Signing + notarization are LIVE as of v0.8.0.** Released DMGs are signed
  with the Developer ID Application certificate (team `U6Z87CS4W3`) and
  notarized by Apple — verified with `spctl -a` ("accepted, source=Notarized
  Developer ID") and `stapler validate`. Downloads open with a normal
  double-click, no Gatekeeper prompt. The build signs automatically when a
  "Developer ID Application" certificate is available and notarizes when
  Apple credentials are in the environment. The CI release secrets
  (Settings → Secrets → Actions) are:
  - `CSC_LINK` — the Developer ID Application certificate exported from
    Keychain Access as a `.p12`, base64-encoded (`base64 -i cert.p12`)
  - `CSC_KEY_PASSWORD` — the `.p12` export password
  - `APPLE_ID` — the Apple ID email of the developer account
  - `APPLE_APP_SPECIFIC_PASSWORD` — generated at appleid.apple.com →
    Sign-In & Security → App-Specific Passwords
  - `APPLE_TEAM_ID` — from developer.apple.com → Membership
  Locally, installing the certificate in the login keychain makes
  `pnpm dist` sign automatically (notarization additionally needs the three
  `APPLE_*` variables exported). Without credentials, builds are unsigned —
  downloaders must right-click → Open the first time.

## 6. Auto-update

- **electron-updater, GitHub provider, launch-only.** Packaged builds check
  the repo's Releases on startup, download a newer **notarized** build in the
  background, and prompt "Restart to update". The macOS code signature is
  verified before install. On by default; opt out under ⚙ Settings
  (`autoUpdate` in `settings.json`, stored next to the database).
- **Privacy exception.** This is the only network call DocGit makes on its own.
  It can be disabled; no telemetry is sent and no host other than GitHub
  Releases is contacted. (See the README privacy section.)
- **Release feed.** `release.yml` publishes the DMG (first install) plus the
  `zip` + `latest-mac.yml` (+ `.blockmap`) that electron-updater consumes. The
  `zip` target and the `publish:` block live in `electron-builder.yml`.
- **Bundling.** `electron-updater` is in the electron-vite `exclude` list so it
  is bundled into `out/main` (the packaged app ships no `node_modules`). The
  headless smoke test imports the main bundle, so a broken updater bundle fails
  CI.
- **Verification limit.** Real download-and-install is only exercisable via a
  live signed release cycle (tag `vN` → install → tag `vN+1` → observe the
  installed app self-update). There is no local or CI click-test for the actual
  update. Confirm on the next tagged release.
- **Dev/smoke are inert.** All update behaviour is guarded by `app.isPackaged`;
  `pnpm dev` and the headless smoke/boot checks never reach the network.
