// Gives the game page its version number (shown on the ONLINE screen; also used to spot version mismatches),
// lets OPTIONS switch the window between WINDOWED / BORDERLESS / FULLSCREEN, and passes on the in-game UPDATE status.
const { contextBridge, ipcRenderer } = require('electron');
const arg = name => { const a = (process.argv || []).find(x => x.startsWith('--' + name + '=')); return a ? a.split('=')[1] : null; };
let displayMode = arg('display-mode') || 'windowed';
let update = { state: 'idle' };
ipcRenderer.on('display-mode', (e, m) => { displayMode = m; });   // (F11 changes it from the app side)
ipcRenderer.on('update', (e, u) => { update = u || update; });    // checking / downloading (percent) / ready / latest / error
contextBridge.exposeInMainWorld('appInfo', {
  version: arg('app-version') || 'dev',
  desktop: true,
  getDisplayMode: () => displayMode,
  setDisplayMode: m => { displayMode = m; ipcRenderer.send('display-mode', m); },
  getUpdate: () => ({ ...update }),
  installUpdate: () => ipcRenderer.send('update-install'),
  checkUpdate: () => ipcRenderer.send('update-check'),
});
