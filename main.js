// Doodle Brothers - desktop app (Electron)
// Opens the game in its own window and keeps it up to date: every time it starts it checks GitHub
// Releases for a newer version, downloads it in the background, and offers to restart into it.
const { app, BrowserWindow, dialog, Menu } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 720,
    useContentSize: true,
    resizable: true,
    backgroundColor: '#0e0c0c',
    title: 'Doodle Brothers',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,   // keep the game running (and online matches in sync) when the window isn't focused
      additionalArguments: ['--app-version=' + app.getVersion()],
    },
  });
  Menu.setApplicationMenu(null);     // no File/Edit menu bar
  win.loadFile(path.join(__dirname, 'index.html'));
  // F11 = fullscreen
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
  });
}

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
  createWindow();
  setupUpdates();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
