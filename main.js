// Doodle Brothers - desktop app (Electron)
// Opens the game in its own window and keeps it up to date: every time it starts it checks GitHub
// Releases for a newer version, downloads it in the background, and offers to restart into it.
const { app, BrowserWindow, dialog, Menu, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');

// DISPLAY MODE (picked in OPTIONS, remembered between launches):
//   windowed   = a normal window with a title bar
//   borderless = no title bar or border, covering the whole screen (easy to alt-tab out of)
//   fullscreen = true fullscreen (F11 also switches between this and windowed)
const MODES = ['windowed', 'borderless', 'fullscreen'];
const modeFile = () => path.join(app.getPath('userData'), 'display.json');
function loadMode() { try { const m = JSON.parse(fs.readFileSync(modeFile(), 'utf8')).mode; return MODES.includes(m) ? m : 'windowed'; } catch (e) { return 'windowed'; } }
function saveMode(m) { try { fs.writeFileSync(modeFile(), JSON.stringify({ mode: m })); } catch (e) {} }
let mode = 'windowed';
const { autoUpdater } = require('electron-updater');

let win = null;

function createWindow(m = mode, onDisplay = null) {
  mode = m;
  const borderless = m === 'borderless';
  const disp = onDisplay || screen.getPrimaryDisplay();
  win = new BrowserWindow({
    width: 1280,
    height: 720,
    useContentSize: true,
    resizable: !borderless,
    frame: !borderless,
    ...(borderless ? { ...disp.bounds, useContentSize: false } : {}),   // borderless: exactly covers the screen
    backgroundColor: '#0e0c0c',
    title: 'Doodle Brothers',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,   // keep the game running (and online matches in sync) when the window isn't focused
      autoplayPolicy: 'no-user-gesture-required',   // the menu music can start on the title screen straight away
      additionalArguments: ['--app-version=' + app.getVersion(), '--display-mode=' + m],
    },
  });
  Menu.setApplicationMenu(null);     // no File/Edit menu bar
  if (m === 'fullscreen') win.setFullScreen(true);
  win.loadFile(path.join(__dirname, 'index.html'));
  // F11 = fullscreen <-> windowed
  const w = win;
  w.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') { e.preventDefault(); setMode(mode === 'fullscreen' ? 'windowed' : 'fullscreen'); }
  });
}
// Switch display mode. Windowed <-> fullscreen happens in place; borderless needs a window without a frame, so the
// game window is re-made (the game reloads to the home screen - every setting is kept).
function setMode(m) {
  if (!MODES.includes(m) || m === mode || !win) return;
  saveMode(m);
  if ((m === 'borderless') === (mode === 'borderless')) {
    mode = m;
    const w = win, wasFull = w.isFullScreen();
    const toWindow = () => { if (!w.isDestroyed()) { w.setContentSize(1280, 720); w.center(); } };
    if (m === 'windowed' && wasFull) w.once('leave-full-screen', toWindow);   // (resize once it's actually left fullscreen)
    w.setFullScreen(m === 'fullscreen');
    if (m === 'windowed' && !wasFull) toWindow();
    win.webContents.send('display-mode', m);
    return;
  }
  const old = win, onDisplay = screen.getDisplayMatching(old.getBounds());
  createWindow(m, onDisplay);
  old.destroy();
}
ipcMain.on('display-mode', (e, m) => setMode(m));

function setupUpdates() {
  if (!app.isPackaged) return;       // only the installed game updates itself
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-downloaded', async info => {
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update ready',
      message: `Doodle Brothers ${info.version} is ready.`,
      detail: 'Restart to play the new version. (If you pick Later, it installs the next time you close the game.)\n\nOnline matches need both players on the same version.',
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });
  autoUpdater.on('error', err => console.error('[update]', err && err.message));
  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 30 * 60 * 1000);   // and every 30 minutes
}

app.whenReady().then(() => {
  createWindow(loadMode());
  setupUpdates();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
