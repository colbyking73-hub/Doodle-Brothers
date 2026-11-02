// DOODLE BROTHERS - ANDROID. The app puts this at the top of index.html. It tells the game it's on Android
// (window.appInfo, like the PC app does) and runs QUICK UPDATES:
//   - every couple of minutes it reads patch.json from GitHub (the same one the PC version uses)
//   - a newer version: only the game files that changed are downloaded (checked against their hashes), saved, and
//     switched over all at once. The game's update screen then offers UPDATE NOW (a quick reload).
//   - if the ANDROID APP ITSELF changed (patch.json's "android" id differs), a quick update isn't enough: UPDATE NOW
//     opens the new APK's download instead (Android then asks to install it).
(() => {
  const B = window.AndroidBridge;
  if (!B) return;
  const REPO = 'colbyking73-hub/Doodle-Brothers';
  const MANIFEST = 'https://raw.githubusercontent.com/' + REPO + '/main/patch.json';
  const APK = 'https://github.com/' + REPO + '/releases/latest/download/DoodleBrothers.apk';
  const fileUrl = (v, rel) => 'https://raw.githubusercontent.com/' + REPO + '/v' + v + '/' + rel.split('/').map(encodeURIComponent).join('/');
  let info = {};
  try { info = JSON.parse(B.info()); } catch (e) {}
  let update = { state: 'idle' }, local = null, busy = false;
  const newer = (a, b) => {
    const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
    for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
    return false;
  };
  window.appInfo = {
    version: info.versionName || 'android',
    android: true,
    getUpdate: () => ({ ...update }),
    installUpdate() { if (update.state !== 'ready') return; if (update.full) B.openUrl(APK); else B.reload(); },
    checkUpdate: () => { check(); },
    getDisplayMode: () => 'fullscreen',
    setDisplayMode() {},
  };
  // hashes exactly like make-patch.ps1 / updater.js: text files without a BOM and without \r, sha256 hex
  const TEXT = /\.(html|js|json|css|txt)$/i;
  async function hash(rel, bytes) {
    let b = bytes;
    if (TEXT.test(rel)) {
      let t = new TextDecoder('utf-8').decode(bytes);
      if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
      b = new TextEncoder().encode(t.replace(/\r/g, ''));
    }
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', b));
    return Array.from(d, x => x.toString(16).padStart(2, '0')).join('');
  }
  function b64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  async function getLocal() {
    if (!local) local = await (await fetch('patch.json', { cache: 'no-store' })).json();
    window.appInfo.version = local.version || window.appInfo.version;
    return local;
  }
  async function check() {
    if (busy || update.state === 'ready') return;
    busy = true;
    try {
      const mine = await getLocal();
      update = { state: 'checking' };
      const remote = await (await fetch(MANIFEST + '?t=' + Date.now(), { cache: 'no-store' })).json();
      if (!remote || !remote.version || !newer(remote.version, mine.version)) { update = { state: 'latest' }; return; }
      if ((remote.android || '') !== (mine.android || '')) { update = { state: 'ready', version: remote.version, full: true }; return; }
      const todo = Object.keys(remote.files || {}).filter(rel => !mine.files[rel] || mine.files[rel].hash !== remote.files[rel].hash);
      B.clearStaged();
      update = { state: 'downloading', version: remote.version, quick: true, percent: 0 };
      let done = 0;
      for (const rel of todo) {
        const res = await fetch(fileUrl(remote.version, rel), { cache: 'no-store' });
        if (!res.ok) throw new Error('download failed: ' + rel);
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (await hash(rel, bytes) !== remote.files[rel].hash) throw new Error('damaged download: ' + rel);
        if (!B.writeFile(rel, b64(bytes))) throw new Error('could not save ' + rel);
        update.percent = Math.round(100 * ++done / (todo.length + 1));
      }
      if (!B.writeFile('patch.json', b64(new TextEncoder().encode(JSON.stringify(remote))))) throw new Error('could not save patch.json');
      if (!B.commitUpdate()) throw new Error('could not switch to the update');
      local = remote;
      update = { state: 'ready', version: remote.version, quick: true };
    } catch (e) {
      B.clearStaged();
      update = { state: 'error', message: String((e && e.message) || e) };
    } finally {
      busy = false;
    }
  }
  getLocal().catch(() => {});
  setTimeout(check, 4000);
  setInterval(check, 120000);
})();
