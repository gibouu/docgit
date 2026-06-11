# DocGit — Product Spec

Git-like version control for office documents (Word, Excel, PowerPoint — plus the French government open-source suite: La Suite Docs and Grist). Target users are professionals who iterate on high-stakes documents: lawyers (contracts), founders (business plans), job seekers (CVs), and anyone managing multilingual or per-client document variants.

Two form factors sharing one core engine:

1. **A standalone desktop app** — **macOS only for now, fully local.** The app is the hub: users open documents *from* the app and see all their documents through it. No git jargon or commands are ever exposed — it's a friendly file version tracker with a beautiful branch tree. Ease of use is the top priority.
2. **An Office Add-in** (Office.js / manifest-based) inside Word, Excel and PowerPoint, so versioning, branching and diffing happen in the apps people already use.

Both share a common core library (document parsing, diffing, version graph, storage) so features stay in sync.

## Core features

### 1. Version tree ("branch view")

- Every document has a commit-graph visualization rendered as a tree with branches, like a git history graph (GitKraken / GitHub network graph), **not** a flat version list.
- Each node = a saved version (snapshot), with timestamp, author, optional message.
- Users can branch from any node: e.g., from the main CV, branch "CV — Marketing roles", "CV — French version", "Contract — Client B variant".
- Branches can be named, color-coded, archived, and merged (or at minimum, cherry-picked from).
- **Send tracking:** a version node can be tagged with "sent to [recipient] on [date] via [email/link]". The tree must visually show which exact version went to which person and when — e.g., "this is the CV I sent to Acme on March 3; main has had 15 commits since." Provide a per-recipient view ("show everything ever sent to X").

### 2. Git-style diffing (NOT Word track changes)

- Comparing two versions opens a side-by-side diff view, like a GitHub pull request — left pane old, right pane new, added/removed/modified blocks highlighted, summary header: "+12 additions, −4 deletions, 3 modified sections".
- Diff at the level of paragraphs/sentences for Word/Docs, cells/rows/formulas for Excel/Grist, slides/shapes/text for PowerPoint.
- A user must be able to select ANY two nodes in the tree and instantly see what changed and what stayed the same.
- Diff of formatting changes should be available but collapsible — content changes are the priority.

### 3. Re-branching from old versions

- From any historical node: open it read-only, restore it as the new head, or branch from it.
- When re-branching, show a pre-flight diff: "main has diverged by N changes since this version".

### 4. Cross-document live links (Excel/Grist → Word/Docs)

- Link values in a Word/Docs document to cells or named ranges in an Excel workbook or Grist table — including inline numbers inside sentences. Example: "We forecast revenue of €1.2M in 2027" where €1.2M is bound to `Forecast.xlsx!Summary!B14`.
- When the source spreadsheet changes, linked values update (on open / on demand / on save — configurable), and the update is recorded as a commit so it shows in diff history ("€1.0M → €1.2M, source: Forecast.xlsx v18").
- Support number formatting (currency, percentages, locale-aware formats for multilingual branches).
- Stale-link detection: warn if a document references a spreadsheet version older than the spreadsheet's current head.

### 5. Multilingual / variant branch workflows

- First-class "translation branches": branch "Contract (EN)" → "Contract (FR)". When the EN parent changes, flag the FR branch as "behind by N changes" and show exactly which paragraphs changed upstream.

## Platform & integration

### Microsoft Office path

- Office Add-ins using Office.js (Word, Excel, PowerPoint on Windows, Mac, web). One manifest per app or a unified manifest.
- Office JS API to read content; for full-fidelity snapshots, export/parse the underlying OOXML (.docx/.xlsx/.pptx are ZIP archives of XML — parse these for diffing, never binary comparison).
- Diff engine operates on a normalized intermediate representation (JSON document model) extracted from OOXML, so the same diff logic works across formats.
- Send-tracking: manual "mark as sent" first; optional Outlook integration later.

### La Suite (French government open-source) path

- **Docs** (https://github.com/suitenumerique/docs): BlockNote/Yjs collaborative editor with REST API, self-hostable. Integrate via API; investigate plugin/extension mechanism, otherwise integrate from the standalone app.
- **Grist** (https://github.com/gristlabs/grist-core): full REST API, webhooks, plugin/widget system — use webhooks to detect data changes that should propagate to linked documents.
- No open-source slides equivalent yet — scope slides to Microsoft, keep the adapter seam open for a future tool.

## Architecture

- **Core engine** (TypeScript library, no UI): document adapters (OOXML, Docs, Grist) → normalized model → snapshot store (content-addressed, like git objects) → diff engine → version graph. Local storage first (SQLite + content-addressed blobs); design for an optional sync server later.
- **Adapters pattern is mandatory:** `WordAdapter`, `ExcelAdapter`, `PowerPointAdapter`, `LaSuiteDocsAdapter`, `GristAdapter`, each implementing `parse()`, `serialize()`, `diff()` capabilities against the normalized model.
- **UI layer:** React components shared between the Office add-in task pane and the standalone app — especially the tree/branch graph and the side-by-side diff.
- **Tree visualization:** proper graph layout (d3 or a git-graph layout algorithm) — branches as diverging lines, merge/send events as labeled nodes.

## Milestones (in order)

1. **Core engine MVP:** parse .docx → normalized model → snapshot store → paragraph-level diff between two snapshots, with a CLI to test it.
2. **Standalone app MVP (macOS):** open a .docx, commit versions, render the branch tree, side-by-side diff of any two nodes, mark-as-sent tagging.
3. **Word add-in:** same features inside Word via Office.js task pane.
4. **Excel support:** .xlsx adapter, cell/formula diffing, then cross-document live links (Excel → Word inline numbers) with commits on linked-value updates.
5. **PowerPoint adapter** (slide/shape-level diff).
6. **La Suite adapters:** Docs API integration + Grist API/webhook integration in the standalone app.
7. **Polish:** translation-branch workflows, per-recipient send history view, merge/cherry-pick.

## Constraints & quality bar

- **Local-first:** documents and history never leave the user's machine unless they opt into sync (important for lawyers/confidentiality).
- **The diff must be trustworthy:** lawyers will rely on it — include tests with adversarial documents (moved paragraphs, tables, numbering changes, tracked-changes artifacts).
- **Performance:** diff two 50-page contracts in under 2 seconds.
- Write tests for the core engine first; the adapters are where the complexity lives.
- macOS only for the desktop app today; everything stays local.
