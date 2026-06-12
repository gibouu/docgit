import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { join } from 'node:path';
import { DocumentService } from './service.js';

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
        { name: 'Documents', extensions: ['docx', 'xlsx'] },
        { name: 'Word documents', extensions: ['docx'] },
        { name: 'Excel workbooks', extensions: ['xlsx'] },
      ],
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return svc.addDocument(result.filePaths[0]!);
  });

  ipcMain.handle('docs:open', (_e, documentId: string) => shell.openPath(svc.documentPath(documentId)));
  ipcMain.handle('docs:graph', (_e, documentId: string) => svc.getGraph(documentId));

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

  ipcMain.handle('branch:create', (_e, documentId: string, name: string, fromCommitId: string) =>
    svc.createBranch(documentId, name, fromCommitId),
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

    const branch = svc.createBranch(doc.id, 'Client B variant', graph.commits[0]!.id);
    svc.markSent(doc.id, v2.commit.id, { recipient: 'Acme', channel: 'email' });
    const after = svc.getGraph(doc.id);
    if (after.branches.length !== 2) throw new Error('branch not created');
    if (after.sends.length !== 1) throw new Error('send not recorded');
    if (after.document.currentBranchId !== branch.id) throw new Error('branch not current');

    // Atomic-save regression (#14): Word saves via temp-file + rename, which
    // must still be noticed by the watcher and produce a version.
    await svc.whenWatchersReady();
    const { renameSync } = await import('node:fs');
    const before = svc.getGraph(doc.id).commits.length;
    const tmpPath = join(dir, 'smoke-atomic.tmp');
    writeFileSync(tmpPath, makeDocx(['Branch wording.', 'Clause two.', 'Added after atomic swap.']));
    renameSync(tmpPath, docPath);
    const noticed = await waitFor(() => svc.getGraph(doc.id).commits.length > before, 8000);
    if (!noticed) throw new Error('atomic save (rename over file) was not versioned');

    // Safety snapshot (#16): even if a save slips past the watcher entirely,
    // switching branches must rescue the disk content, never destroy it.
    const { parseDocx } = await import('@docgit/core');
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
