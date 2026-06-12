# DocGit — repo conventions

- **No signatures or AI footers** on commits, PRs, or issues in this repo.
- **`docs/TECH-NOTES.md` is a living document.** Whenever a feature ships
  with a known limit, risk, or deliberate MVP shortcut, add it there (and
  file a tracking issue for the significant ones). Remove entries when fixed.
- Full product spec: `docs/SPEC.md`. Architecture decisions: `docs/decisions/`.
- Verify with `pnpm build && pnpm typecheck && pnpm test` at the root, plus
  `pnpm --filter @docgit/desktop smoke` (headless Electron: full-stack smoke
  + renderer boot check). CI runs all of it on macOS.
