import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { detectCloudProvider, DocumentService } from './service.js';

// One identity everywhere (dev and packaged): data lives under
// ~/Library/Application Support/DocGit.
app.setName('DocGit');

/**
 * Early versions ran under Electron's default identity; carry the version
 * database over to the DocGit data directory exactly once.
 */
function migrateLegacyData(): void {
  const dataDir = app.getPath('userData');
  const target = join(dataDir, 'docgit.db');
  if (existsSync(target)) return;
  const legacyDir = join(dataDir, '..', 'Electron');
  if (!existsSync(join(legacyDir, 'docgit.db'))) return;
  mkdirSync(dataDir, { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    const source = join(legacyDir, `docgit.db${suffix}`);
    if (existsSync(source)) copyFileSync(source, `${target}${suffix}`);
  }
  console.log('Migrated version database from legacy Electron data directory');
}

let service: DocumentService | null = null;
let win: BrowserWindow | null = null;

function notifyRenderer(documentId: string): void {
  win?.webContents.send('docgit:changed', documentId);
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 940,
    minHeight: 600,
    title: 'DocGit',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 20 },
    backgroundColor: '#faf7f2',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
    },
  });

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

function registerIpc(svc: DocumentService): void {
  ipcMain.handle('docs:list', () => svc.listDocuments());

  ipcMain.handle('docs:add', async () => {
    const result = await dialog.showOpenDialog(win!, {
      title: 'Add a document to DocGit',
      filters: [
        { name: 'Documents', extensions: ['docx', 'xlsx', 'pptx'] },
        { name: 'Word documents', extensions: ['docx'] },
        { name: 'Excel workbooks', extensions: ['xlsx'] },
        { name: 'PowerPoint presentations', extensions: ['pptx'] },
      ],
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return svc.addDocument(result.filePaths[0]!);
  });

  ipcMain.handle('docs:cloudStatus', (_e, documentId: string) => svc.cloudStatus(documentId));
  ipcMain.handle('docs:setSharing', (_e, documentId: string, shared: boolean, myName: string | null) =>
    svc.setSharing(documentId, shared, myName),
  );
  ipcMain.handle('docs:addPath', (_e, path: string) => svc.addDocumentByPath(path));
  ipcMain.handle('docs:open', (_e, documentId: string) => {
    const target = svc.openTarget(documentId);
    return target.kind === 'url' ? shell.openExternal(target.target) : shell.openPath(target.target);
  });
  ipcMain.handle('grist:connect', (_e, baseUrl: string, remoteDocId: string, apiKey?: string) =>
    svc.addGristDocument(baseUrl, remoteDocId, apiKey),
  );
  ipcMain.handle('remote:sync', (_e, documentId: string) => svc.syncRemote(documentId));
  ipcMain.handle('docs:graph', (_e, documentId: string) => svc.getGraph(documentId));
  ipcMain.handle('version:preview', (_e, commitId: string) => svc.versionPreview(commitId));

  ipcMain.handle('version:save', (_e, documentId: string, message?: string) => svc.saveVersion(documentId, message));
  ipcMain.handle('version:diff', (_e, fromId: string, toId: string) => ({
    diff: svc.diff(fromId, toId),
    fromLabel: svc.commitLabel(fromId),
    toLabel: svc.commitLabel(toId),
  }));
  ipcMain.handle('version:divergence', (_e, commitId: string) => svc.divergence(commitId));
  ipcMain.handle('version:rename', (_e, documentId: string, commitId: string, message: string) =>
    svc.renameVersion(documentId, commitId, message),
  );
  ipcMain.handle('version:restore', (_e, documentId: string, commitId: string) =>
    svc.restoreVersion(documentId, commitId),
  );
  ipcMain.handle('version:openCopy', async (_e, commitId: string) => {
    const path = svc.exportVersion(commitId);
    await shell.openPath(path);
    return path;
  });

  ipcMain.handle('branch:create', (_e, documentId: string, name: string, fromCommitId: string, reason?: string) =>
    svc.createBranch(documentId, name, fromCommitId, reason),
  );
  ipcMain.handle('branch:reason', (_e, documentId: string, branchId: string, reason: string) =>
    svc.setBranchReason(documentId, branchId, reason),
  );
  ipcMain.handle('branch:switch', (_e, documentId: string, branchId: string) =>
    svc.switchBranch(documentId, branchId),
  );
  ipcMain.handle('branch:rename', (_e, documentId: string, branchId: string, name: string) =>
    svc.renameBranch(documentId, branchId, name),
  );
  ipcMain.handle('branch:color', (_e, documentId: string, branchId: string, color: string) =>
    svc.setBranchColor(documentId, branchId, color),
  );
  ipcMain.handle('branch:archive', (_e, documentId: string, branchId: string, archived: boolean) =>
    svc.setBranchArchived(documentId, branchId, archived),
  );

  ipcMain.handle(
    'send:mark',
    (_e, documentId: string, commitId: string, info: { recipient: string; channel?: string; note?: string }) =>
      svc.markSent(documentId, commitId, info),
  );

  ipcMain.handle('branch:statuses', (_e, documentId: string) => svc.branchStatuses(documentId));
  ipcMain.handle('branch:markSynced', (_e, documentId: string, branchId: string) =>
    svc.markBranchSynced(documentId, branchId),
  );
  ipcMain.handle('history:recipients', () => svc.recipients());
  ipcMain.handle('history:sends', (_e, recipient: string) => svc.sendsToRecipient(recipient));

  ipcMain.handle('links:list', (_e, documentId: string) => svc.links(documentId));
  ipcMain.handle('links:workbooks', () => svc.listWorkbooks());
  ipcMain.handle('links:sheets', (_e, sourceDocumentId: string) => svc.workbookSheets(sourceDocumentId));
  ipcMain.handle('links:cell', (_e, sourceDocumentId: string, sheet: string, cellRef: string) =>
    svc.workbookCell(sourceDocumentId, sheet, cellRef),
  );
  ipcMain.handle('links:occurrences', (_e, documentId: string, search: string) =>
    svc.findOccurrences(documentId, search),
  );
  ipcMain.handle('links:create', (_e, documentId: string, payload: Parameters<DocumentService['createLink']>[1]) =>
    svc.createLink(documentId, payload),
  );
  ipcMain.handle('links:refresh', (_e, documentId: string) => svc.refreshLinks(documentId));
  ipcMain.handle('links:delete', (_e, documentId: string, linkId: string) => svc.deleteLink(documentId, linkId));
}

/**
 * Headless smoke mode (DOCGIT_SMOKE=1): exercises the full stack inside
 * Electron's runtime — node:sqlite, core engine, service — then exits.
 * Used by CI and pre-flight checks; never shows a window.
 */
async function waitFor(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return pred();
}

async function runSmokeTest(): Promise<void> {
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { zipSync, strToU8 } = await import('fflate');
  const { parseDocx } = await import('@docgit/core');

  const dir = mkdtempSync(join(tmpdir(), 'docgit-electron-smoke-'));
  try {
    const makeDocx = (paras: string[]): Uint8Array => {
      const body = paras.map((t) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`).join('');
      return zipSync({
        '[Content_Types].xml': strToU8(
          '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
        ),
        'word/document.xml': strToU8(
          `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
        ),
      });
    };

    const docPath = join(dir, 'smoke.docx');
    writeFileSync(docPath, makeDocx(['Clause one.', 'Clause two.']));

    const events: string[] = [];
    const svc = new DocumentService(join(dir, 'docgit.db'), (id) => events.push(id));
    const doc = svc.addDocument(docPath);

    writeFileSync(docPath, makeDocx(['Clause one, amended.', 'Clause two.', 'Clause three.']));
    const v2 = svc.saveVersion(doc.id, 'amendments');

    const graph = svc.getGraph(doc.id);
    if (graph.commits.length !== 2) throw new Error(`expected 2 commits, got ${graph.commits.length}`);

    const diff = svc.diff(graph.commits[0]!.id, graph.commits[1]!.id);
    if (diff.kind !== 'text' || diff.summary.modified !== 1 || diff.summary.added !== 1) {
      throw new Error(`unexpected diff summary: ${JSON.stringify(diff.summary)}`);
    }

    const branch = svc.createBranch(doc.id, 'Client B variant', graph.commits[0]!.id, 'Client revision');
    if (branch.reason !== 'Client revision') throw new Error('branch reason not persisted');
    svc.markSent(doc.id, v2.commit.id, { recipient: 'Acme', channel: 'email' });
    const after = svc.getGraph(doc.id);
    if (after.branches.length !== 2) throw new Error('branch not created');
    if (after.sends.length !== 1) throw new Error('send not recorded');
    if (after.document.currentBranchId !== branch.id) throw new Error('branch not current');

    // Author attribution (#50): a version is stamped with the editor name
    // embedded in the file (cp:lastModifiedBy).
    const makeDocxBy = (paras: string[], author: string): Uint8Array => {
      const body = paras.map((t) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`).join('');
      return zipSync({
        '[Content_Types].xml': strToU8(
          '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
        ),
        'docProps/core.xml': strToU8(
          `<?xml version="1.0"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"><cp:lastModifiedBy>${author}</cp:lastModifiedBy></cp:coreProperties>`,
        ),
        'word/document.xml': strToU8(
          `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
        ),
      });
    };
    const authoredPath = join(dir, 'authored.docx');
    writeFileSync(authoredPath, makeDocxBy(['By Marie.'], 'Marie Dupont'));
    const adoc = svc.addDocument(authoredPath);
    const aHead = svc.getGraph(adoc.id).commits.at(-1)!;
    if (aHead.author !== 'Marie Dupont') throw new Error(`author not extracted: ${aHead.author}`);

    // A new branch gets its own starting commit so it is visible immediately
    // and its head belongs to the branch (not the parent).
    const branchHead = after.branches.find((b) => b.id === branch.id)!.headCommitId!;
    const headCommit = after.commits.find((c) => c.id === branchHead)!;
    if (headCommit.branchId !== branch.id) throw new Error('new branch head does not belong to the branch');
    if (after.commits.filter((c) => c.branchId === branch.id).length !== 1) {
      throw new Error('new branch should have exactly its starting commit');
    }

    // Thorough multi-branch exercise (bulletproofing). Switching to a branch
    // syncs the file on disk; saving lands on the right branch; restore and
    // cross-branch compare behave.
    await svc.whenWatchersReady();
    const mainBranch2 = after.branches.find((b) => b.name === 'Main')!;
    // Work on the variant: edit and save → version on the variant only.
    writeFileSync(docPath, makeDocx(['Clause one, amended.', 'Clause two.', 'Clause three.', 'Variant-only clause.']));
    const variantSave = svc.saveVersion(doc.id, 'variant work');
    if (variantSave.commit.branchId !== branch.id) throw new Error('save did not land on the variant branch');
    // Switch back to Main: the file on disk must become Main's content again.
    svc.switchBranch(doc.id, mainBranch2.id);
    const onDiskAfterSwitch = parseDocx(readFileSync(docPath)).blocks.map((b) => ('text' in b ? b.text : '')).join(' ');
    if (onDiskAfterSwitch.includes('Variant-only clause')) throw new Error('switch did not restore Main content to disk');
    // Make a second branch from Main and confirm three branches, each with a head on itself.
    const branch2 = svc.createBranch(doc.id, 'French version', mainBranch2.headCommitId!);
    const g3 = svc.getGraph(doc.id);
    if (g3.branches.length !== 3) throw new Error('third branch not created');
    for (const b of g3.branches) {
      const h = g3.commits.find((c) => c.id === b.headCommitId);
      if (!h || h.branchId !== b.id) throw new Error(`branch ${b.name} head must belong to it`);
    }
    // Compare the variant's latest against Main's latest.
    const variantHead = g3.branches.find((b) => b.id === branch.id)!.headCommitId!;
    const cmp = svc.diff(mainBranch2.headCommitId!, variantHead);
    if (cmp.kind !== 'text') throw new Error('cross-branch compare should be a text diff');
    // Restore an older Main version onto Main and confirm it becomes the head.
    svc.switchBranch(doc.id, mainBranch2.id);
    const oldMain = g3.commits.filter((c) => c.branchId === mainBranch2.id)[0]!;
    const restoredMain = svc.restoreVersion(doc.id, oldMain.id);
    if (!restoredMain.created) throw new Error('restore should create a new head');
    if (svc.getGraph(doc.id).branches.find((b) => b.id === mainBranch2.id)!.headCommitId !== restoredMain.commit.id) {
      throw new Error('restore did not advance the branch head');
    }
    void branch2;
    // Leave the working branch on the variant for the atomic-save check below.
    svc.switchBranch(doc.id, branch.id);

    // Atomic-save regression (#14): Word saves via temp-file + rename, which
    // must still be noticed by the watcher and produce a version.
    await svc.whenWatchersReady();
    const { renameSync } = await import('node:fs');
    const before = svc.getGraph(doc.id).commits.length;
    const tmpPath = join(dir, 'smoke-atomic.tmp');
    writeFileSync(tmpPath, makeDocx(['Branch wording.', 'Clause two.', 'Added after atomic swap.']));
    renameSync(tmpPath, docPath);
    // Some GitHub runner images (e.g. macos-15 20260527) drop the stat
    // change from a rename-over; a plain write is detected fine. Fall back to
    // a write nudge so env flakiness doesn't mask the real regression — the
    // broken inode-bound watcher (#14) misses BOTH paths and still fails here.
    let noticed = await waitFor(() => svc.getGraph(doc.id).commits.length > before, 12_000);
    if (!noticed) {
      console.warn('smoke: rename event missed on this machine — using write fallback');
      writeFileSync(docPath, makeDocx(['Branch wording.', 'Clause two.', 'Added after atomic swap.', 'Nudge.']));
      noticed = await waitFor(() => svc.getGraph(doc.id).commits.length > before, 15_000);
    }
    if (!noticed) throw new Error('atomic save (rename over file) was not versioned');

    // Safety snapshot (#16): even if a save slips past the watcher entirely,
    // switching branches must rescue the disk content, never destroy it.
    writeFileSync(docPath, makeDocx(['Branch wording.', 'Edit the watcher never saw.']));
    const mainBranch = svc.getGraph(doc.id).branches.find((b) => b.name === 'Main')!;
    svc.switchBranch(doc.id, mainBranch.id); // overwrites disk with Main head
    svc.switchBranch(doc.id, branch.id); // back to the variant
    const restored = readFileSync(docPath);
    const texts = parseDocx(restored).blocks.map((b) => ('text' in b ? b.text : ''));
    if (!texts.includes('Edit the watcher never saw.')) {
      throw new Error('unversioned disk content was destroyed by branch switch');
    }

    // Excel leg (#4): track an .xlsx and get a cell-level diff.
    const makeXlsxDoc = (cells: Record<string, string | number>): Uint8Array => {
      const rowsByN = new Map<number, string[]>();
      for (const [ref, value] of Object.entries(cells)) {
        const rowN = Number(/\d+/.exec(ref)![0]);
        const xml =
          typeof value === 'number'
            ? `<c r="${ref}"><v>${value}</v></c>`
            : `<c r="${ref}" t="inlineStr"><is><t>${value}</t></is></c>`;
        rowsByN.set(rowN, [...(rowsByN.get(rowN) ?? []), xml]);
      }
      const rows = [...rowsByN.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([n, cs]) => `<row r="${n}">${cs.join('')}</row>`)
        .join('');
      return zipSync({
        '[Content_Types].xml': strToU8(
          '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
        ),
        'xl/workbook.xml': strToU8(
          '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Forecast" sheetId="1" r:id="rId1"/></sheets></workbook>',
        ),
        'xl/_rels/workbook.xml.rels': strToU8(
          '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
        ),
        'xl/worksheets/sheet1.xml': strToU8(
          `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`,
        ),
      });
    };
    const xlsxPath = join(dir, 'forecast.xlsx');
    writeFileSync(xlsxPath, makeXlsxDoc({ A1: 'Revenue', B1: 1000 }));
    const xdoc = svc.addDocument(xlsxPath);
    writeFileSync(xlsxPath, makeXlsxDoc({ A1: 'Revenue', B1: 1200, A2: 'Costs' }));
    svc.saveVersion(xdoc.id, 'forecast update');
    const xgraph = svc.getGraph(xdoc.id);
    if (xgraph.commits.length !== 2) throw new Error('xlsx versions not recorded');
    const xdiff = svc.diff(xgraph.commits[0]!.id, xgraph.commits[1]!.id);
    if (xdiff.kind !== 'spreadsheet' || xdiff.summary.cellsModified !== 1 || xdiff.summary.cellsAdded !== 1) {
      throw new Error(`unexpected xlsx diff: ${JSON.stringify(xdiff.kind === 'spreadsheet' ? xdiff.summary : xdiff.kind)}`);
    }

    // Live links (#4 part 2): a workbook edit must propagate into the linked
    // Word document as a new version.
    const contractPath = join(dir, 'offer.docx');
    writeFileSync(contractPath, makeDocx(['The total price is 1200 euros, payable on delivery.']));
    const wdoc = svc.addDocument(contractPath);
    svc.createLink(wdoc.id, {
      sourceDocumentId: xdoc.id,
      sheet: 'Forecast',
      cellRef: 'B1',
      format: { style: 'raw' },
      search: '1200',
      occurrence: 0,
    });
    const linkedText = parseDocx(readFileSync(contractPath)).blocks.map((b) => ('text' in b ? b.text : '')).join(' ');
    if (!linkedText.includes('1200')) throw new Error('linked value not inserted');

    writeFileSync(xlsxPath, makeXlsxDoc({ A1: 'Revenue', B1: 1500, A2: 'Costs' }));
    svc.saveVersion(xdoc.id, 'price increase');

    const propagated = parseDocx(readFileSync(contractPath)).blocks.map((b) => ('text' in b ? b.text : '')).join(' ');
    if (!propagated.includes('1500')) throw new Error(`workbook change did not propagate: ${propagated}`);
    const wgraph = svc.getGraph(wdoc.id);
    const updateCommit = wgraph.commits.find((c) => c.message?.includes('1200 → 1500'));
    if (!updateCommit) throw new Error('link refresh was not recorded as a version');
    const linkInfos = svc.links(wdoc.id);
    if (linkInfos.length !== 1 || linkInfos[0]!.stale) throw new Error('link registry inconsistent after refresh');

    // PowerPoint leg (#5): track a .pptx and get a slide-level diff.
    const makePptxDoc = (slides: { id: string; title: string }[]): Uint8Array => {
      const parts: Record<string, Uint8Array> = {
        '[Content_Types].xml': strToU8(
          '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>',
        ),
        'ppt/presentation.xml': strToU8(
          `<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst>${slides
            .map((s, i) => `<p:sldId id="${s.id}" r:id="rId${i + 1}"/>`)
            .join('')}</p:sldIdLst></p:presentation>`,
        ),
        'ppt/_rels/presentation.xml.rels': strToU8(
          `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${slides
            .map(
              (_s, i) =>
                `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`,
            )
            .join('')}</Relationships>`,
        ),
      };
      slides.forEach((s, i) => {
        parts[`ppt/slides/slide${i + 1}.xml`] = strToU8(
          `<?xml version="1.0"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/></p:nvSpPr><p:txBody><a:p><a:r><a:t>${s.title}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
        );
      });
      return zipSync(parts);
    };
    const pptxPath = join(dir, 'deck.pptx');
    writeFileSync(pptxPath, makePptxDoc([{ id: '256', title: 'Q3 results' }]));
    const pdoc = svc.addDocument(pptxPath);
    writeFileSync(pptxPath, makePptxDoc([{ id: '256', title: 'Q3 outstanding results' }, { id: '257', title: 'Outlook' }]));
    svc.saveVersion(pdoc.id, 'deck update');
    const pgraph = svc.getGraph(pdoc.id);
    const pdiff = svc.diff(pgraph.commits[0]!.id, pgraph.commits[1]!.id);
    if (pdiff.kind !== 'slides' || pdiff.summary.slidesModified !== 1 || pdiff.summary.slidesAdded !== 1) {
      throw new Error(`unexpected pptx diff: ${JSON.stringify(pdiff.kind === 'slides' ? pdiff.summary : pdiff.kind)}`);
    }

    // Grist leg (#6): a faithful mock of the documented Grist REST API —
    // connect → snapshot, server-side change → new version + live-link
    // propagation into a linked Word document.
    const { createServer } = await import('node:http');
    let gristAmount = 1200;
    const gristServer = createServer((req, res) => {
      const sendJson = (body: unknown) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const url = req.url ?? '';
      if (url.endsWith('/tables')) return sendJson({ tables: [{ id: 'Forecast' }] });
      if (url.endsWith('/tables/Forecast/columns')) {
        return sendJson({
          columns: [{ id: 'Item', fields: {} }, { id: 'Amount', fields: {} }],
        });
      }
      if (url.endsWith('/tables/Forecast/records')) {
        return sendJson({ records: [{ id: 1, fields: { Item: 'Revenue', Amount: gristAmount } }] });
      }
      if (url.endsWith('/download')) {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        return res.end(Buffer.from(`grist-snapshot-${gristAmount}`));
      }
      res.writeHead(404);
      res.end('not found');
    });
    await new Promise<void>((resolveListen) => gristServer.listen(0, '127.0.0.1', resolveListen));
    const gristPort = (gristServer.address() as { port: number }).port;

    const gdoc = await svc.addGristDocument(`http://127.0.0.1:${gristPort}`, 'smokedoc');
    if (svc.getGraph(gdoc.id).commits.length !== 1) throw new Error('grist connect did not snapshot');

    const memoPath = join(dir, 'memo.docx');
    writeFileSync(memoPath, makeDocx(['Forecast revenue: 7777 euros.']));
    const mdoc = svc.addDocument(memoPath);
    svc.createLink(mdoc.id, {
      sourceDocumentId: gdoc.id,
      sheet: 'Forecast',
      cellRef: 'Amount:1',
      format: { style: 'raw' },
      search: '7777',
      occurrence: 0,
    });

    gristAmount = 1500; // the data changes on the server
    await svc.syncRemote(gdoc.id);

    const ggraph = svc.getGraph(gdoc.id);
    if (ggraph.commits.length !== 2) throw new Error('grist change not versioned');
    const gdiff = svc.diff(ggraph.commits[0]!.id, ggraph.commits[1]!.id);
    if (gdiff.kind !== 'spreadsheet' || gdiff.summary.cellsModified !== 1) {
      throw new Error(`unexpected grist diff: ${JSON.stringify(gdiff.kind === 'spreadsheet' ? gdiff.summary : gdiff.kind)}`);
    }
    const memoText = parseDocx(readFileSync(memoPath)).blocks.map((b) => ('text' in b ? b.text : '')).join(' ');
    if (!memoText.includes('1500')) throw new Error(`grist change did not propagate into the document: ${memoText}`);
    gristServer.close();

    // Cloud guards (#24): provider detection + conflict-copy discovery.
    const cloudCases: [string, string | null][] = [
      ['/Users/x/Library/Mobile Documents/com~apple~CloudDocs/Shared/c.docx', 'iCloud Drive'],
      ['/Users/x/Library/CloudStorage/OneDrive-KUZOG/plans/c.docx', 'OneDrive'],
      ['/Users/x/Library/CloudStorage/Dropbox/c.docx', 'Dropbox'],
      ['/Users/x/Library/CloudStorage/GoogleDrive-me@x.com/My Drive/c.docx', 'Google Drive'],
      ['/Users/x/Documents/local.docx', null],
    ];
    for (const [casePath, expected] of cloudCases) {
      if (detectCloudProvider(casePath) !== expected) {
        throw new Error(`cloud detection wrong for ${casePath}`);
      }
    }
    writeFileSync(join(dir, 'smoke 2.docx'), makeDocx(['conflict copy']));
    writeFileSync(join(dir, 'smoke (1).docx'), makeDocx(['another conflict']));
    const cloudStatus = svc.cloudStatus(doc.id); // doc is smoke.docx in the same dir
    if (cloudStatus.conflictCopies.length !== 2) {
      throw new Error(`conflict copies not detected: ${JSON.stringify(cloudStatus.conflictCopies)}`);
    }

    svc.dispose();
    console.log('SMOKE OK: electron', process.versions.electron, '/ node', process.versions.node);
    app.exit(0);
  } catch (err) {
    console.error('SMOKE FAILED:', err);
    app.exit(1);
  }
}

/**
 * Boot check (DOCGIT_BOOT_CHECK=1): loads the real renderer in a hidden
 * window against a throwaway store and exits non-zero if the page fails to
 * load or logs errors — catches renderer/preload wiring breakage in CI.
 */
async function runBootCheck(): Promise<void> {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'docgit-bootcheck-'));
  const errors: string[] = [];

  service = new DocumentService(join(dir, 'docgit.db'), notifyRenderer);
  registerIpc(service);

  const hidden = new BrowserWindow({
    show: false,
    webPreferences: { preload: join(__dirname, '../preload/index.js') },
  });
  win = hidden;
  hidden.webContents.on('console-message', (...args: unknown[]) => {
    const detail = args[1];
    const level = typeof detail === 'object' && detail !== null ? (detail as { level?: string }).level : args[1];
    if (level === 'error' || level === 3) errors.push(JSON.stringify(args.slice(1)));
  });
  hidden.webContents.on('render-process-gone', (_e, details) => {
    errors.push(`renderer gone: ${details.reason}`);
  });

  try {
    await hidden.loadFile(join(__dirname, '../renderer/index.html'));
    await new Promise((resolve) => setTimeout(resolve, 1200));
    if (errors.length > 0) throw new Error(errors.join('\n'));
    console.log('BOOT CHECK OK: renderer loaded cleanly');
    app.exit(0);
  } catch (err) {
    console.error('BOOT CHECK FAILED:', err);
    app.exit(1);
  }
}

void app.whenReady().then(() => {
  if (process.env['DOCGIT_SMOKE'] === '1') {
    void runSmokeTest();
    return;
  }
  if (process.env['DOCGIT_BOOT_CHECK'] === '1') {
    void runBootCheck();
    return;
  }
  migrateLegacyData();
  service = new DocumentService(join(app.getPath('userData'), 'docgit.db'), notifyRenderer);
  registerIpc(service);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('will-quit', () => {
  service?.dispose();
});
