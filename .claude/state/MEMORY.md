# Project memory — stable facts & gotchas

- Repo gibouu/docgit, PUBLIC + MIT. NO signatures on commits/PRs/issues (user instruction, overrides global).
- Privacy guarantee in README is load-bearing: app must stay local-only, zero network except user-connected Grist. Don't add telemetry/network calls.
- Verify: `pnpm build && pnpm typecheck && pnpm test` (root) + `pnpm --filter @docgit/desktop smoke` (headless Electron full-stack + renderer boot check). CI runs all on macOS.
- Releases: signed + notarized. Developer ID team U6Z87CS4W3 (differs from old Apple Development cert 3MULA33RSG). 5 CI secrets set. Tag vX.Y.Z → CI builds notarized DMG.
- App installed at /Applications/DocGit.app; data at ~/Library/Application Support/DocGit/. After merging app changes: `pnpm --filter @docgit/desktop dist` + ditto to /Applications (NOT npx electron).
- window.prompt is DISABLED in Electron — use in-app modal dialogs.
- Link registry id MUST equal the in-document w:sdt tag id (join key for refresh).
- CI gotcha: GitHub macos runner pool serves MIXED image versions; older 20260527 drops rename stat events. Smoke has write-nudge fallback. NEVER pipe `gh pr checks --watch` through tail when gating a merge — swallows exit code (once caused a red merge).
- Milestones done: 1 core, 2 Mac app, 4 Excel+links, 5 pptx, 6-pt1 Grist, 7 polish. Remaining: M3 Word add-in (#3, deferred), M6-pt2 La Suite Docs (#6, needs live instance), storage #25, paragraph merge.
