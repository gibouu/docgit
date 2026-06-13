# DocGit

Git-style version control for office documents — without the git.

DocGit gives professionals who iterate on high-stakes documents (contracts, business plans, CVs, per-client and multilingual variants) a visual version tree, branching, send-tracking, and trustworthy side-by-side diffs for Word, Excel and PowerPoint documents — plus La Suite Docs and Grist.

## Download

Grab the latest **[DocGit.app DMG from Releases](https://github.com/gibouu/docgit/releases/latest)** (Apple silicon). The app is **signed and notarized by Apple** — open the DMG, drag DocGit to Applications, and double-click. No security prompts, no right-click ritual.

New here? Read the **[one-page tutorial](docs/TUTORIAL.md)**.

## Privacy: local only, no exceptions

DocGit transfers nothing and keeps nothing outside your Mac:

- **No servers, no accounts, no telemetry, no analytics, no crash reporting.** The app makes zero network calls of its own.
- **Your documents and their entire version history live in one place:** `~/Library/Application Support/DocGit/` on your machine. Delete that folder and the app's data is gone.
- The **only** network activity ever performed is to servers **you explicitly connect** (e.g. your own Grist instance via "Connect Grist…"), and that connection is read-only.
- Fonts and all assets are bundled — nothing is fetched at runtime.

This is verifiable in the source: the codebase is open under the [MIT license](LICENSE).

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

# package DocGit.app + DMG (unsigned local build) into apps/desktop/release/
pnpm --filter @docgit/desktop dist
```

## Releases

Push a tag (`git tag v0.9.0 && git push origin v0.9.0`) and CI builds the DMG
on an Apple-silicon runner, **signs it with the Developer ID certificate and
notarizes it with Apple**, then attaches it to a GitHub Release. The signing
secrets are configured on the repo — see [`docs/TECH-NOTES.md`](docs/TECH-NOTES.md)
for the credential checklist.

See [`docs/SPEC.md`](docs/SPEC.md) for the full product spec and milestone plan.
