// TEST-ONLY deterministic renderer channel. Not production backend/network/Minecraft proof.
const { app, BrowserWindow, ipcMain, clipboard } = require('electron');
const path = require('node:path');
const root = process.argv.find(a => a.startsWith('--profile-root='));
if (!root) throw new Error('Isolated --profile-root required');
app.setPath('userData', root.slice('--profile-root='.length));
app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 1240, height: 860, minWidth: 1000, minHeight: 700, frame: false, fullscreen: true, show: true, webPreferences: { preload: path.join(__dirname, 'dashboard-fixture-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  ipcMain.handle('fixture:window', (_e, method) => {
    if (method === 'windowToggleFullscreen') w.setFullScreen(!w.isFullScreen());
    return { fullScreen: w.isFullScreen(), maximized: w.isMaximized() };
  });
  // TEST-ONLY clipboard readback so tests can verify copy completion against the OS clipboard itself.
  ipcMain.handle('fixture:clipboard', (_e, op, text) => { if (op === 'write') clipboard.writeText(String(text)); return clipboard.readText(); });
  await w.loadFile(path.join(__dirname, '../apps/desktop/index.html'));
});
app.on('window-all-closed', () => app.quit());
