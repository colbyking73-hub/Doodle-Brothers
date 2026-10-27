// QUICK UPDATES ("hot patches") for the installed game.
// Most updates only change the game files (index.html, net.js, sounds...), not the app shell around them (main.js,
// preload.js, this file, the Electron version). For those, there's no need to download and run a whole installer:
//   - release.ps1 writes patch.json (version + a hash of every game file + a "shell id") into the release commit
//   - the game reads patch.json from GitHub, downloads ONLY the files that changed (usually just index.html),
//     builds the new version in its own folder (in the user's AppData), and switches to it with a quick reload.
// If the shell changed (shell id differs), a quick patch isn't safe -> the normal full installer update is used.
// Plain Node (no Electron imports), so it can be tested outside the app.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');

const REPO = 'colbyking73-hub/Doodle-Brothers';
const MANIFEST_URL = `https://raw.githubusercontent.com/${REPO}/main/patch.json`;
const fileUrl = (version, rel) => `https://raw.githubusercontent.com/${REPO}/v${version}/${rel.split('/').map(encodeURIComponent).join('/')}`;
const SHELL_FILES = ['main.js', 'preload.js', 'updater.js'];
const TEXT = /\.(html|js|json|css|txt)$/i;

// Text files are hashed with line endings and a BOM stripped, so Windows (CRLF) and GitHub (LF) copies match.
function normalized(rel, buf) {
  if (!TEXT.test(rel)) return buf;
  return Buffer.from(buf.toString('utf8').replace(/^﻿/, '').replace(/\r/g, ''), 'utf8');
}
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
const hashFile = (rel, buf) => sha(normalized(rel, buf));
// Which app shell this is: the shell files + the Electron version. Game files only patch onto the same shell.
function shellId(dir, electronVersion) {
  const h = crypto.createHash('sha256');
  for (const f of SHELL_FILES) {
    let t = '';
    try { t = fs.readFileSync(path.join(dir, f), 'utf8'); } catch (e) {}
    h.update(t.replace(/^﻿/, '').replace(/\r/g, '') + '\n--\n', 'utf8');
  }
  h.update('electron@' + electronVersion, 'utf8');
  return h.digest('hex').slice(0, 16);
}
// 1.2.10 > 1.2.9
function newer(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); }
  return false;
}

// GET a URL into a Buffer (follows redirects; onBytes(n) as it arrives)
function get(url, onBytes, hops = 0) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': 'DoodleBrothers-Updater', 'Cache-Control': 'no-cache' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 5) {
        res.resume(); return resolve(get(new URL(res.headers.location, url).toString(), onBytes, hops + 1));
      }
      if (res.statusCode !== 200) { res.resume(); const e = new Error('HTTP ' + res.statusCode + ' for ' + url); e.status = res.statusCode; return reject(e); }
      const parts = [];
      res.on('data', c => { parts.push(c); if (onBytes) onBytes(c.length); });
      res.on('end', () => resolve(Buffer.concat(parts)));
      res.on('error', reject);
    });
    req.setTimeout(30000, () => req.destroy(new Error('timed out')));
    req.on('error', reject);
  });
}
async function fetchManifest(url = MANIFEST_URL) {
  const m = JSON.parse((await get(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now())).toString('utf8'));
  if (!m || !m.version || !m.shell || !m.files) throw new Error('bad patch.json');
  return m;
}

// Build version m.version into <root>/<version>: files whose hash matches the version running now are copied from
// it, the rest are downloaded (and checked against their hash). Returns the new folder.
//   current = { dir, hashes? }  (hashes: rel -> hash of the files in dir, if known - saves re-hashing them)
async function buildPatch({ root, manifest, current, fileUrlFor = fileUrl, onProgress }) {
  const ver = manifest.version, out = path.join(root, ver), tmp = out + '.part';
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const need = [];
  for (const [rel, info] of Object.entries(manifest.files)) {
    const src = path.join(current.dir, rel), dst = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    let have = current.hashes && current.hashes[rel];
    let buf = null;
    if (!have) { try { buf = fs.readFileSync(src); have = hashFile(rel, buf); } catch (e) { have = null; } }
    if (have === info.hash) {
      // same file: hard-link from an earlier patch folder (instant), or copy out of the installed app
      let done = false;
      if (!current.dir.includes('.asar')) { try { fs.linkSync(src, dst); done = true; } catch (e) {} }
      if (!done) fs.writeFileSync(dst, buf || fs.readFileSync(src));
    } else need.push([rel, info]);
  }
  const total = need.reduce((s, [, i]) => s + (i.size || 0), 0) || 1;
  let got = 0;
  for (const [rel, info] of need) {
    const buf = await get(fileUrlFor(ver, rel), n => { got += n; if (onProgress) onProgress(Math.min(99, Math.round(got / total * 100)), rel); });
    if (hashFile(rel, buf) !== info.hash) throw new Error('hash mismatch for ' + rel);
    fs.writeFileSync(path.join(tmp, rel), buf);
  }
  fs.writeFileSync(path.join(tmp, 'patch.json'), JSON.stringify(manifest));
  fs.rmSync(out, { recursive: true, force: true });
  fs.renameSync(tmp, out);
  if (onProgress) onProgress(100);
  return { dir: out, downloaded: need.map(([r]) => r), bytes: got };
}

// The patch to run at launch (or null = run the installed version): it must be newer than the installed app, built
// for this same shell, and complete.
function activePatch(root, appVersion, myShell) {
  try {
    const st = JSON.parse(fs.readFileSync(path.join(root, 'active.json'), 'utf8'));
    const dir = path.join(root, st.version);
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'patch.json'), 'utf8'));
    if (m.shell !== myShell || !newer(m.version, appVersion) || !fs.existsSync(path.join(dir, 'index.html'))) return null;
    const hashes = {}; for (const [rel, i] of Object.entries(m.files)) hashes[rel] = i.hash;
    return { dir, version: m.version, hashes };
  } catch (e) { return null; }
}
function setActive(root, version) { fs.writeFileSync(path.join(root, 'active.json'), JSON.stringify({ version })); }
// Remove every patch folder except the one(s) to keep
function cleanup(root, keep = []) {
  let names = []; try { names = fs.readdirSync(root); } catch (e) { return; }
  for (const n of names) if (n !== 'active.json' && !keep.includes(n)) { try { fs.rmSync(path.join(root, n), { recursive: true, force: true }); } catch (e) {} }
}

module.exports = { REPO, MANIFEST_URL, fileUrl, shellId, hashFile, newer, get, fetchManifest, buildPatch, activePatch, setActive, cleanup };
