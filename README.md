# DocGit

Git-style version control for office documents — without the git.

DocGit gives professionals who iterate on high-stakes documents (contracts, business plans, CVs, per-client and multilingual variants) a visual version tree, branching, send-tracking, and trustworthy side-by-side diffs for Word, Excel and PowerPoint documents — plus La Suite Docs and Grist.

**Local-first:** documents and their history never leave your machine.

## Structure

| Package | Purpose |
| --- | --- |
| `packages/core` | The engine: document adapters (OOXML → normalized model), content-addressed snapshot store (SQLite), diff engine, version graph. No UI. Includes a `docgit` CLI for testing. |
| `apps/desktop` | macOS desktop app — the document hub. Open documents from the app, see the branch tree, diff any two versions, mark versions as sent. |
| `apps/office-addin` | Office.js task-pane add-in for Word / Excel / PowerPoint. |

## Development

```sh
pnpm install
pnpm build
pnpm test

# run the macOS app (dev mode, hot reload)
pnpm --filter @docgit/desktop dev

# headless verification of the app stack (used by CI)
pnpm --filter @docgit/desktop smoke
```

See [`docs/SPEC.md`](docs/SPEC.md) for the full product spec and milestone plan.
