// Gives the game page its version number (shown on the ONLINE screen; also used to spot version mismatches)
const { contextBridge } = require('electron');
const arg = (process.argv || []).find(a => a.startsWith('--app-version='));
contextBridge.exposeInMainWorld('appInfo', { version: arg ? arg.split('=')[1] : 'dev', desktop: true });
