# DocGit

Git-style version control for office documents — without the git.

DocGit gives professionals who iterate on high-stakes documents (contracts, business plans, CVs, per-client and multilingual variants) a visual version tree, branching, send-tracking, and trustworthy side-by-side diffs for Word, Excel and PowerPoint documents — plus La Suite Docs and Grist.

## Download & install

### ⬇︎ [Download DocGit for Mac](https://github.com/gibouu/docgit/releases/latest) (Apple silicon)

**First time:**

1. Open the download link above. Under **Assets**, click the file ending in **`.dmg`** (it looks like `DocGit-0.10.0-arm64.dmg`). *Ignore the `.zip` and other files — those are only for automatic updates.*
2. Open the downloaded **`.dmg`** (double-click it in your Downloads).
3. In the window that appears, **drag the DocGit icon onto the Applications folder.**
4. Open **Applications** and double-click **DocGit**. It opens straight away — the app is signed and notarized by Apple, so there are no security warnings.

**Already have an older version (e.g. 0.9)?** Your documents and history are stored separately from the app, so updating never touches them — you just drop the new one on top:

1. **Quit DocGit** if it's open (⌘Q).
2. Download the latest **`.dmg`** and open it, exactly as above.
3. Drag **DocGit** onto **Applications**; when macOS asks *"An item named 'DocGit' already exists,"* click **Replace**.
4. Open DocGit — your documents, versions, and branches are all exactly where you left them.

> **Automatic updates are on the way.** From an upcoming version onward, DocGit checks for new releases on its own and simply shows a **"Restart to update"** button — so this manual download is only needed once to get there.

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
