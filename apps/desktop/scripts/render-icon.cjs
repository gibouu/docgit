/* Renders build/icon.svg to a 1024×1024 transparent PNG using Electron's
 * offscreen renderer — no image tooling dependencies needed.
 * Usage: electron scripts/render-icon.cjs <svg-in> <png-out>
 */
const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');

app.whenReady().then(async () => {
  try {
    const svg = readFileSync(process.argv[2], 'utf8');
    const html = `<!doctype html><body style="margin:0;background:transparent">${svg}</body>`;
    const win = new BrowserWindow({
      show: false,
      width: 1024,
      height: 1024,
      transparent: true,
      frame: false,
      webPreferences: { offscreen: true },
    });
    win.webContents.setFrameRate(1);
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    await new Promise((r) => setTimeout(r, 600));
    const image = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
    writeFileSync(process.argv[3], image.toPNG());
    console.log('icon rendered:', process.argv[3]);
    app.exit(0);
  } catch (err) {
    console.error(err);
    app.exit(1);
  }
});
