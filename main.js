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
  win.loadFile(path.join(currentGame().dir, 'index.html'));     // (the newest quick update, if there is one)
  win.webContents.on('did-finish-load', () => sendUpdate({}));
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

// UPDATES - two kinds (see updater.js):
//   QUICK update: only the game files changed -> just the changed files download (usually ~1MB), and UPDATE NOW
//                 reloads the game into the new version in a second. No installer, no restart.
//   FULL update:  the app shell itself changed -> the whole installer downloads in the background, and UPDATE NOW
//                 installs it silently and restarts. (Quitting the game also installs it.)
// The game checks at launch and then every 2 minutes while it's open (and whenever CHECK FOR UPDATES is picked), so
// new versions show up mid-session. The status shows on the home screen and in a corner during play.
const upd = require('./updater');
const CHECK_EVERY = 2 * 60 * 1000;
const patchRoot = () => path.join(app.getPath('userData'), 'patches');
let myShell = null, game = null, pendingPatch = null, busy = false;
const currentGame = () => game || { dir: __dirname, version: app.getVersion(), hashes: null };
let updateState = { state: 'idle' };
function sendUpdate(s) {
  updateState = { ...updateState, ...s };
  if (win && !win.isDestroyed()) win.webContents.send('update', updateState);
}
ipcMain.on('app-version', e => { e.returnValue = currentGame().version; });   // (the version actually running)
function pickGame() {             // at launch: run the newest quick update, if it suits this app shell
  myShell = upd.shellId(__dirname, process.versions.electron);
  const p = app.isPackaged ? upd.activePatch(patchRoot(), app.getVersion(), myShell) : null;
  game = p;
  upd.cleanup(patchRoot(), p ? [p.version] : []);      // old/unneeded update folders
}
function fullUpdate(version) {    // the shell changed: fetch the whole installer
  if ((updateState.state === 'downloading' || updateState.state === 'ready') && !updateState.quick) return;
  sendUpdate({ state: 'building', version, quick: false });   // (GitHub takes ~5 min to build the installer - re-checked every 2 min)
  autoUpdater.autoDownload = true;
  autoUpdater.checkForUpdates().catch(() => {});
}
async function checkNow(manual) {
  if (busy || !app.isPackaged) return;
  if (updateState.state === 'downloading' && !updateState.quick) return;   // (the installer is downloading)
  busy = true;
  const ready = updateState.state === 'ready';
  try {
    if (!ready) sendUpdate({ state: 'checking' });
    const m = await upd.fetchManifest();
    const have = ready ? updateState.version : currentGame().version;
    if (!upd.newer(m.version, have)) { if (!ready) sendUpdate({ state: 'latest', checkedAt: Date.now() }); return; }
    if (m.shell !== myShell) { fullUpdate(m.version); return; }
    if (ready && !updateState.quick) return;          // (a full update is already waiting)
    sendUpdate({ state: 'downloading', version: m.version, percent: 0, quick: true });
    const cur = currentGame();
    const r = await upd.buildPatch({ root: patchRoot(), manifest: m, current: { dir: cur.dir, hashes: cur.hashes },
                                     onProgress: p => sendUpdate({ percent: p }) });
    const hashes = {}; for (const [rel, i] of Object.entries(m.files)) hashes[rel] = i.hash;
    pendingPatch = { dir: r.dir, version: m.version, hashes };
    sendUpdate({ state: 'ready', version: m.version, quick: true, percent: 100 });
  } catch (err) {
    console.error('[update]', err && err.message);
    if (err && err.status === 404) { autoUpdater.autoDownload = true; autoUpdater.checkForUpdates().catch(() => {}); }   // (no quick-update info: plain installer check)
    else if (updateState.state !== 'ready') sendUpdate({ state: manual ? 'error' : 'latest', checkedAt: Date.now() });
  } finally { busy = false; }
}
function installUpdate() {
  if (updateState.state !== 'ready') return;
  if (updateState.quick && pendingPatch) {             // QUICK: switch to the new files and reload - done
    upd.setActive(patchRoot(), pendingPatch.version);
    game = pendingPatch; pendingPatch = null;
    updateState = { state: 'latest', applied: game.version, checkedAt: Date.now() };
    if (win && !win.isDestroyed()) win.loadFile(path.join(game.dir, 'index.html'));
  } else autoUpdater.quitAndInstall(true, true);       // FULL: silent install, then restart
}
function setupUpdates() {
  ipcMain.on('update-install', installUpdate);
  ipcMain.on('update-check', () => checkNow(true));
  if (!app.isPackaged) { sendUpdate({ state: 'dev' }); return; }   // (only the installed game updates itself)
  autoUpdater.autoDownload = false;                                  // (only used for FULL updates - see fullUpdate)
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-available', info => sendUpdate({ state: 'downloading', version: info.version, percent: 0, quick: false }));
  autoUpdater.on('download-progress', p => { if (!updateState.quick) sendUpdate({ state: 'downloading', percent: Math.round(p.percent || 0) }); });
  autoUpdater.on('update-downloaded', info => sendUpdate({ state: 'ready', version: info.version, quick: false }));
  autoUpdater.on('error', err => { console.error('[update]', err && err.message); });   // (stays 'building' - tried again next check)
  checkNow(false);
  setInterval(() => checkNow(false), CHECK_EVERY);
}
app.whenReady().then(() => {
  pickGame();
  createWindow(loadMode());
  setupUpdates();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
