import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { detectCloudProvider, DocumentService } from './service.js';
import { Settings } from './settings.js';
import { backupDatabase, restoreDatabase, assertDocgitDb } from './backup.js';
import { initUpdater, getUpdateState, checkForUpdatesNow, quitAndInstall, type UpdateState } from './updater.js';
import { findOldInstallers, type OldInstaller } from './cleanup.js';

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
let settings: Settings;
/** Leftover installers found after a version bump; the renderer offers to trash them. */
let pendingCleanup: OldInstaller[] = [];

function notifyRenderer(documentId: string): void {
  win?.webContents.send('docgit:changed', documentId);
}

function sendUpdateState(state: UpdateState): void {
  win?.webContents.send('docgit:update', state);
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

  // Only honor the dev-server URL in unpackaged builds. In a shipped app this
  // env var must never redirect the renderer to a remote origin (which would
  // run with the preload bridge + IPC access) — always load the bundled file.
  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
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
  ipcMain.handle('docs:addPaths', (_e, paths: string[]) => svc.addDocuments(paths));
  ipcMain.handle('docs:rename', (_e, documentId: string, newBaseName: string) =>
    svc.renameDocument(documentId, newBaseName),
  );
  ipcMain.handle('docs:delete', (_e, documentId: string, opts: { trashFile: boolean }) =>
    svc.deleteDocument(documentId, opts),
  );
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

  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('update:getState', () => getUpdateState());
  ipcMain.handle('update:check', () => checkForUpdatesNow());
  ipcMain.handle('update:install', () => quitAndInstall());
  ipcMain.handle('update:settings', () =>
    settings ? settings.get() : { autoUpdate: true, seenUpdateNote: false, lastRunVersion: null, workspaceRoot: null, createdFolders: [] },
  );
  ipcMain.handle('update:setEnabled', (_e, enabled: boolean) => {
    if (!settings) return { autoUpdate: enabled, seenUpdateNote: false, lastRunVersion: null, workspaceRoot: null, createdFolders: [], persistError: false };
    let persistError = false;
    try {
      settings.set('autoUpdate', enabled);
    } catch {
      persistError = true; // cache reflects the choice, but it couldn't be saved
    }
    if (enabled && !persistError) checkForUpdatesNow();
    return { ...settings.get(), persistError };
  });
  ipcMain.handle('update:markNoteSeen', () => {
    if (!settings) return { autoUpdate: true, seenUpdateNote: true, lastRunVersion: null, workspaceRoot: null, createdFolders: [] };
    try {
      settings.set('seenUpdateNote', true);
    } catch {
      // a one-time note being shown again next launch is harmless
    }
    return settings.get();
  });

  ipcMain.handle('backup:run', async () => {
    const res = await dialog.showSaveDialog(win!, {
      title: 'Back up DocGit',
      defaultPath: `DocGit-backup-${new Date().toISOString().slice(0, 10)}.docgitdb`,
    });
    if (res.canceled || !res.filePath) return null;
    service?.checkpoint(); // flush WAL → main file so the copy is complete (WAL mode)
    return backupDatabase(join(app.getPath('userData'), 'docgit.db'), res.filePath);
  });

  ipcMain.handle('backup:restore', async () => {
    const res = await dialog.showOpenDialog(win!, {
      title: 'Restore DocGit from a backup',
      filters: [{ name: 'DocGit backup', extensions: ['docgitdb', 'db'] }],
      properties: ['openFile'],
    });
    if (res.canceled || !res.filePaths[0]) return;
    const src = res.filePaths[0];
    assertDocgitDb(src); // validate BEFORE touching anything; throws -> renderer shows error, nothing changed
    const dbPath = join(app.getPath('userData'), 'docgit.db');
    service?.dispose(); // close the live DB before swapping the file
    service = null; // prevent a second dispose() on the closed handle (quit path)
    restoreDatabase(dbPath, src); // saves docgit.db.bak, then overwrites
    app.relaunch();
    app.exit(0);
  });

  ipcMain.handle('data:reveal', () => {
    shell.showItemInFolder(join(app.getPath('userData'), 'docgit.db'));
  });

  ipcMain.handle('cleanup:candidates', () => pendingCleanup);
  ipcMain.handle('cleanup:trash', async (_e, paths: string[]) => {
    // Only ever trash paths we actually offered — the renderer can't ask us to
    // delete an arbitrary file. Moves to Trash (recoverable), never unlinks.
    const offered = new Set(pendingCleanup.map((c) => c.path));
    for (const path of paths) {
      if (!offered.has(path)) continue;
      try {
        await shell.trashItem(path);
      } catch {
        // already gone or no permission — drop it from the list regardless
      }
    }
    pendingCleanup = pendingCleanup.filter((c) => !paths.includes(c.path));
  });

  // Workspace root (#52): the single folder whose disk tree the library mirrors.
  ipcMain.handle('workspace:get', () => settings?.get().workspaceRoot ?? null);
  ipcMain.handle('workspace:set', async () => {
    const res = await dialog.showOpenDialog(win!, {
      title: 'Choose your DocGit workspace folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) return settings?.get().workspaceRoot ?? null;
    const root = res.filePaths[0];
    try {
      settings?.set('workspaceRoot', root);
    } catch {
      // persistence is best-effort; the in-memory value still applies this session
    }
    return root;
  });
  ipcMain.handle('workspace:clear', () => {
    try {
      settings?.set('workspaceRoot', null);
    } catch {
      // best-effort
    }
    return null;
  });
  ipcMain.handle('workspace:scan', () => {
    const root = settings?.get().workspaceRoot;
    if (!root) return { files: [], folders: [] };
    const folders = (settings?.get().createdFolders ?? []).filter((f) => f === root || f.startsWith(root + '/'));
    return { files: svc.scanWorkspace(root), folders };
  });
  ipcMain.handle('workspace:createFolder', (_e, parentPath: string, name: string) => {
    const root = settings?.get().workspaceRoot;
    if (!root) throw new Error('Set a workspace folder first.');
    const path = svc.createFolder(root, parentPath, name);
    try {
      const next = [...new Set([...(settings?.get().createdFolders ?? []), path])];
      settings?.set('createdFolders', next);
    } catch {
      // best-effort persistence of the created-folder list
    }
    return path;
  });
  ipcMain.handle('workspace:moveDocument', (_e, documentId: string, targetDir: string) => {
    const root = settings?.get().workspaceRoot;
    if (!root) throw new Error('Set a workspace folder first.');
    return svc.moveDocument(documentId, targetDir, root);
  });
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

    // Settings store: defaults, persistence, and corrupt-file tolerance.
    const s1 = new Settings(dir);
    if (s1.get().autoUpdate !== true || s1.get().seenUpdateNote !== false) {
      throw new Error('settings defaults wrong');
    }
    s1.set('autoUpdate', false);
    s1.set('seenUpdateNote', true);
    const s2 = new Settings(dir); // re-read from disk
    if (s2.get().autoUpdate !== false || s2.get().seenUpdateNote !== true) {
      throw new Error('settings did not persist');
    }
    writeFileSync(join(dir, 'settings.json'), '{ this is not json');
    if (new Settings(dir).get().autoUpdate !== true) {
      throw new Error('corrupt settings should fall back to defaults');
    }

    // #88: a settings write that can't persist throws (surfaced), not swallowed.
    const notADir = join(dir, 'settings-not-a-dir');
    writeFileSync(notADir, 'x'); // a file where Settings expects a directory
    let settingsThrew = false;
    try {
      new Settings(notADir).set('autoUpdate', false);
    } catch {
      settingsThrew = true;
    }
    if (!settingsThrew) throw new Error('#88: settings.set must throw when it cannot persist');

    // #65: adding an unreadable file rolls back — no zero-version document left.
    const badPath = join(dir, 'not-a-doc.docx');
    writeFileSync(badPath, 'this is not a zip');
    let addRejected = false;
    try {
      svc.addDocument(badPath);
    } catch {
      addRejected = true;
    }
    if (!addRejected) throw new Error('#65: adding an unparseable file should throw');
    if (svc.listDocuments().some((d) => d.path === badPath)) throw new Error('#65: zero-version document left behind');

    // #64: when the current file can't be snapshotted, restore aborts — no overwrite.
    const guardPath = join(dir, 'guard.docx');
    writeFileSync(guardPath, makeDocx(['guard v1']));
    const guardDoc = svc.addDocument(guardPath);
    const guardV1 = svc.getGraph(guardDoc.id).commits[0]!;
    writeFileSync(guardPath, 'corrupt-not-a-zip'); // disk now unparseable
    let restoreAborted = false;
    try {
      svc.restoreVersion(guardDoc.id, guardV1.id);
    } catch {
      restoreAborted = true;
    }
    if (!restoreAborted) throw new Error('#64: restore must abort when the safety snapshot fails');
    if (readFileSync(guardPath, 'utf8') !== 'corrupt-not-a-zip') throw new Error('#64: file overwritten despite snapshot failure');

    // #82: a rename with path separators is rejected and moves nothing.
    let renameRejected = false;
    try {
      svc.renameDocument(guardDoc.id, '../escaped');
    } catch {
      renameRejected = true;
    }
    if (!renameRejected) throw new Error('#82: rename must reject path-separator names');
    if (existsSync(join(dir, '..', 'escaped.docx'))) throw new Error('#82: rejected rename moved the file');

    // #157: scanWorkspace lists supported files and marks which are tracked.
    const wsDir = mkdtempSync(join(tmpdir(), 'docgit-ws-'));
    const trackedFile = join(wsDir, 'tracked.docx');
    writeFileSync(trackedFile, makeDocx(['workspace doc']));
    svc.addDocument(trackedFile);
    writeFileSync(join(wsDir, 'untracked.xlsx'), 'x'); // a supported file we did NOT add
    writeFileSync(join(wsDir, 'ignore.txt'), 'x'); // unsupported — must be excluded
    const scan = svc.scanWorkspace(wsDir);
    const byName = new Map(scan.map((f) => [f.name, f]));
    if (byName.get('tracked.docx')?.tracked !== true) throw new Error('#157: tracked file not marked tracked');
    if (byName.get('untracked.xlsx')?.tracked !== false) throw new Error('#157: untracked file not listed as untracked');
    if (byName.has('ignore.txt')) throw new Error('#157: unsupported file should be excluded from the scan');

    // #52: create a folder (mkdir) and move a tracked doc into it (fs.rename).
    const subDir = svc.createFolder(wsDir, wsDir, 'Archive');
    if (!existsSync(subDir)) throw new Error('#52: createFolder did not mkdir');
    const trackedId = svc.listDocuments().find((d) => d.path === trackedFile)!.id;
    const moved = svc.moveDocument(trackedId, subDir, wsDir);
    if (moved.path !== join(subDir, 'tracked.docx')) throw new Error('#52: moveDocument did not update the path');
    if (existsSync(trackedFile)) throw new Error('#52: original file should be gone after the move');
    if (!existsSync(join(subDir, 'tracked.docx'))) throw new Error('#52: file not at its new location after the move');
    rmSync(wsDir, { recursive: true, force: true });

    // Live backup (store still open) must capture data despite WAL mode.
    {
      const { backupDatabase: liveBackup, assertDocgitDb: liveAssert } = await import('./backup.js');
      const { SnapshotStore: LiveStore } = await import('@docgit/core');
      svc.checkpoint();
      const livePath = join(dir, 'live-backup.docgitdb');
      liveBackup(join(dir, 'docgit.db'), livePath);
      liveAssert(livePath);
      const ls = new LiveStore(livePath);
      if (ls.listDocuments().length === 0) throw new Error('live backup (WAL) lost documents');
      ls.close();
    }

    svc.dispose();

    // Backup / restore round-trip + validation.
    const { backupDatabase, restoreDatabase, assertDocgitDb } = await import('./backup.js');
    const { SnapshotStore } = await import('@docgit/core');
    const backupPath = join(dir, 'backup.docgitdb');
    backupDatabase(join(dir, 'docgit.db'), backupPath);
    assertDocgitDb(backupPath); // valid DocGit db → no throw
    const restoreDir = mkdtempSync(join(tmpdir(), 'docgit-restore-'));
    const restoredDb = join(restoreDir, 'docgit.db');
    restoreDatabase(restoredDb, backupPath);
    const restoredStore = new SnapshotStore(restoredDb);
    if (restoredStore.listDocuments().length === 0) throw new Error('restore lost documents');
    restoredStore.close();
    writeFileSync(join(dir, 'notadb.txt'), 'hello');
    let rejected = false;
    try {
      assertDocgitDb(join(dir, 'notadb.txt'));
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error('assertDocgitDb should reject a non-DocGit file');

    // #75: a failed restore leaves the target database intact and no temp behind.
    let restoreFailed = false;
    try {
      restoreDatabase(restoredDb, join(dir, 'notadb.txt'));
    } catch {
      restoreFailed = true;
    }
    if (!restoreFailed) throw new Error('#75: restore from a non-DocGit file should throw');
    if (existsSync(`${restoredDb}.restore-tmp`)) throw new Error('#75: staged restore temp left behind');
    const afterFail = new SnapshotStore(restoredDb);
    if (afterFail.listDocuments().length === 0) throw new Error('#75: failed restore corrupted the target db');
    afterFail.close();

    // Old-installer detection (update-cleanup): only DocGit *.dmg/*.zip are
    // surfaced; unrelated files in the same folder are left alone.
    const dlDir = mkdtempSync(join(tmpdir(), 'docgit-downloads-'));
    writeFileSync(join(dlDir, 'DocGit-0.9.0.dmg'), 'x');
    writeFileSync(join(dlDir, 'DocGit-0.9.0-mac.zip'), 'x');
    writeFileSync(join(dlDir, 'NotDocGit-notes.txt'), 'x');
    const installers = findOldInstallers(dlDir);
    if (installers.length !== 2) throw new Error(`cleanup: expected 2 installers, got ${installers.length}`);
    if (!installers.every((i) => /DocGit/i.test(i.path))) throw new Error('cleanup matched a non-DocGit file');
    rmSync(dlDir, { recursive: true, force: true });

    // Log rotation: once the file passes the cap, it rotates to <path>.1.
    const { appendLog } = await import('./log.js');
    const logFile = join(dir, 'rotate.log');
    appendLog(logFile, 'x'.repeat(120), 50); // first write: file now exceeds the 50-byte cap
    appendLog(logFile, 'second entry', 50); // size > cap → rotate to .1, fresh file
    if (!existsSync(`${logFile}.1`)) throw new Error('activity.log did not rotate past the cap');

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

  // One GUI instance per machine: a second launch would open a second writer
  // against the same docgit.db. SQLite WAL allows only one writer at a time, so
  // hand off to the running window instead of racing it. (Headless smoke and
  // boot-check return above, so they never take the lock.)
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  migrateLegacyData();
  service = new DocumentService(join(app.getPath('userData'), 'docgit.db'), notifyRenderer);
  registerIpc(service);
  createWindow();

  settings = new Settings(app.getPath('userData'));
  initUpdater(sendUpdateState, join(app.getPath('userData'), 'activity.log'), settings.get().autoUpdate);

  // After a fresh update, offer to move the now-useless installer(s) out of
  // Downloads. Gated on an actual version change so we never nag on a normal
  // relaunch, and skipped on the very first run (no prior version recorded).
  const previousVersion = settings.get().lastRunVersion;
  const currentVersion = app.getVersion();
  if (previousVersion && previousVersion !== currentVersion) {
    pendingCleanup = findOldInstallers(app.getPath('downloads'));
  }
  try {
    settings.set('lastRunVersion', currentVersion);
  } catch {
    // non-critical: at worst the cleanup banner re-evaluates next launch
  }

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
