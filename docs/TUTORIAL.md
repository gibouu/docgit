# DocGit — Getting started

DocGit keeps a complete history of your important documents — every save is a
version you can go back to, compare, branch, and track who you sent it to.
No accounts, no cloud, nothing leaves your Mac.

---

## 1. Install (1 minute)

1. Download the latest **DocGit DMG** from the
   [Releases page](https://github.com/gibouu/docgit/releases/latest).
2. Open the DMG and drag **DocGit** into your **Applications** folder.
3. Double-click DocGit to open it.

That's it — it's signed and notarized by Apple, so it opens like any normal app.

---

## 2. Add a document

Click **+ Add document** and choose a Word (`.docx`), Excel (`.xlsx`) or
PowerPoint (`.pptx`) file. It now lives in your DocGit library.

> Your files stay exactly where they are on disk. DocGit just watches them and
> remembers every version.

---

## 3. Edit it — versions save themselves

1. Click the document to open it, then click **Open in Word** (top-right).
2. Edit in Word as usual and press **⌘S** to save.
3. Switch back to DocGit — a new version appears on the timeline, and the
   header briefly flashes **✓ version captured**.

**That's the golden rule: to edit, always use “Open in Word.”** It opens the
real file, so your saves are tracked automatically. (The “View a copy” button
on old versions is only for *looking* — changes to a copy are not saved.)

A flurry of quick saves is grouped into one version so your history stays
readable. Want to pin a milestone? Click a version and **✎ Rename** it
(e.g. “Sent to client”).

---

## 4. Compare any two versions

This is the heart of DocGit — see exactly what changed, like a lawyer's redline
but cleaner.

- Click one version in the tree, then **⌘-click** a second.
- Open the **Changes** tab in the panel below.

You get a side-by-side view: additions in green, removals struck through,
with a summary like *+12 −4, 3 modified*. Works for paragraphs (Word), cells
and formulas (Excel), and slides (PowerPoint).

---

## 5. Branches — keep variants without “Final_v3_FINAL.docx”

A **branch** is a named variant of the same document that lives its own life:
*CV — Marketing roles*, *Contract — Client B*, *French version*.

- Select a version → **Branch from here** → give it a purpose-name.
- You jump straight onto the new branch (it appears as its own colored line in
  the tree). Edit and save as normal — those saves go to the branch.
- Switch between variants from the **Branches** list on the left, or click a
  branch name in the tree.
- A branch that has fallen behind its parent shows **“behind by N”** with a
  one-click view of exactly what changed upstream — perfect for keeping a
  translation in sync.

The tree reads left → right in time, with **Main** as the trunk and branches
fanning out. Drag to pan around.

---

## 6. Track what you sent to whom

When you email a version to someone, select it → **Mark as sent…** and note the
recipient. The tree shows a ✉ badge, and the **✉ Sent history** button (in your
library) answers *“which exact version does Acme have?”* across all your
documents.

---

## 7. Going back

- **Restore a version:** select an older version → **Restore & edit** to make it
  your current one again. Nothing is ever lost — today's content stays in the
  history.
- **Just peek:** **View a copy** opens a throwaway copy to look at, without
  touching anything.

---

## Shared / cloud folders & who edited what

DocGit works on files in iCloud, OneDrive, Dropbox or Google Drive, and it'll
even capture a collaborator's saves as versions.

When you add a document that's in a cloud folder, DocGit asks whether it's
**shared with other people** and what name to show for your edits. From then on
each version shows **who edited it** — DocGit reads the editor's name that
Word/Excel/PowerPoint save inside the file, so it works for your collaborators'
edits too, no setup needed on their side. You'll see *“last edit by Marie D.”*
on a branch and *“Edited by …”* on each version.

One caution: avoid **switching branches** on a file someone else is editing
live — DocGit warns you before it does anything that would sync to others. Full
details are in [`docs/TECH-NOTES.md`](TECH-NOTES.md).

---

## Privacy

DocGit's only network call of its own is the **update check**: on launch it asks
GitHub Releases whether a newer version exists (switchable off under ⚙ Settings).
Connecting a **Grist** document also uses the network, but only when you choose to.
Otherwise there are no servers, accounts, telemetry or analytics — your documents
and their entire history live only on your Mac, in
`~/Library/Application Support/DocGit/`. The source is open under the
[MIT license](../LICENSE), so anyone can verify it.
