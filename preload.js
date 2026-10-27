// Gives the game page its version number (shown on the ONLINE screen; also used to spot version mismatches)
// and lets OPTIONS switch the window between WINDOWED / BORDERLESS / FULLSCREEN.
const { contextBridge, ipcRenderer } = require('electron');
const arg = name => { const a = (process.argv || []).find(x => x.startsWith('--' + name + '=')); return a ? a.split('=')[1] : null; };
let displayMode = arg('display-mode') || 'windowed';
ipcRenderer.on('display-mode', (e, m) => { displayMode = m; });   // (F11 changes it from the app side)
contextBridge.exposeInMainWorld('appInfo', {
  version: arg('app-version') || 'dev',
  desktop: true,
  getDisplayMode: () => displayMode,
  setDisplayMode: m => { displayMode = m; ipcRenderer.send('display-mode', m); },
});
