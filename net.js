// =====================================================================
//  DOODLE BROTHERS - ONLINE PLAY
//
//  Peer-to-peer: one player HOSTS (gets a 5-letter code), the other JOINS with that code. The two games
//  connect straight to each other (WebRTC, through PeerJS's free matchmaking server).
//
//  Netcode = LOCKSTEP with input delay: only button presses are sent, never positions. Both games run
//  the exact same fight from the exact same inputs (and the same shared random numbers), so they stay
//  identical. Your own presses are applied a few game steps late (the "delay", set from your ping) so the
//  other player's presses for that step have time to arrive. If they haven't arrived, the game waits.
//  A checksum of the fight is compared every second to catch the games drifting apart (DESYNC).
// =====================================================================
(() => {
  const PREFIX = 'stickman-brawl-v1-';            // PeerJS ids: PREFIX + 5-letter room code
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';  // (no I / O, they look like 1 / 0)
  const HASH_EVERY = 120;                          // compare fight checksums every 120 steps (1 second)
  const STALL_DROP = 10;                           // seconds of waiting for the other player before giving up

  // Which version of the game this is: both players must run the same one (any change to the game
  // changes the fight, so mismatched versions would drift apart)
  const BUILD = (() => {
    let txt = '';
    for (const s of document.scripts) if (!s.src && s.textContent.length > txt.length) txt = s.textContent;
    txt = txt.replace(/\r/g, '');                   // (same game whatever line endings the file was saved with)
    let h = 5381;
    for (let i = 0; i < txt.length; i++) h = ((h * 33) ^ txt.charCodeAt(i)) >>> 0;
    return h.toString(36);
  })();
  const APP_VERSION = (window.appInfo && window.appInfo.version) || 'dev';

  // ---------- shared random numbers ----------
  function makeRng(seed) {
    let a = seed >>> 0;
    const r = () => {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    r.state = () => a;
    return r;
  }

  // ---------- inputs: packed small to send, unpacked the same way on both sides ----------
  const BITS = ['up', 'down', 'jumpTap', 'jumpHeld', 'blockTap', 'blockHeld', 'dirTap', 'downTap',
                'atkTap', 'atkHeld', 'spcTap', 'spcHeld', 'grabTap', 'ultTap'];
  function enc(inp) {
    let b = 0;
    BITS.forEach((k, i) => { if (inp[k]) b |= 1 << i; });
    const c = inp.cFlick ? [inp.cFlick.btn === 'atk' ? 1 : 2, inp.cFlick.dir | 0, inp.cFlick.up ? 1 : 0, inp.cFlick.down ? 1 : 0] : 0;
    return [b, inp.dir | 0, inp.flyTap | 0, c];
  }
  function dec(e) {
    const inp = emptyInput();
    BITS.forEach((k, i) => { inp[k] = !!(e[0] & (1 << i)); });
    inp.dir = e[1]; inp.flyTap = e[2];
    if (e[3]) inp.cFlick = { btn: e[3][0] === 1 ? 'atk' : 'spc', dir: e[3][1], up: !!e[3][2], down: !!e[3][3] };
    return inp;
  }
  // Inputs that arrive during a hit-freeze are saved up and used on the next real step (like offline)
  function mergeIn(a, b) {
    if (!a) return b;
    const m = { ...b };
    for (const k of BITS) if (k.endsWith('Tap') && a[k]) m[k] = true;
    if (!m.flyTap && a.flyTap) m.flyTap = a.flyTap;
    if (!m.cFlick && a.cFlick) m.cFlick = a.cFlick;
    return m;
  }
  function sampleLocal(N) {
    if (N.dev && N.dev.startsWith('pad')) return padInput(+N.dev.slice(3));
    return keyboardInput();
  }

  // A checksum of everything that matters in the fight (positions, damage, lives, meters, the random numbers)
  function simHash() {
    let s = '' + time.toFixed(4) + '|' + simRngState();
    for (const f of fighters) {
      s += '|' + [f.x, f.y, f.vx, f.vy, f.damage, f.stocks, f.ult, f.face, f.action ? f.action.type : '-']
        .map(v => typeof v === 'number' ? (isFinite(v) ? v.toFixed(3) : String(v)) : v).join(',');
    }
    s += '|' + projectiles.length;
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return h;
  }
  const simRngState = () => (netplay && netplay.rng ? netplay.rng.state() : 0);

  // ---------- connection ----------
  function newState(role) {
    return {
      role, me: role === 'host' ? 0 : 1, peer: null, conn: null, connected: false, active: false,
      code: '', ping: 0, theirBuild: null, theirVersion: null,
      name: loadName(), theirName: role === 'host' ? 'P2' : 'P1',
      dev: 'keyboard',
      lobby: { myChar: null, theirChar: null, myReady: false, theirReady: false, stage: gameOptions.stage || 0, stocks: gameOptions.stocks || 3 },
      overlayText: null,
    };
  }
  function loadName() { try { return (localStorage.getItem('stickman-brawl-name') || 'PLAYER').slice(0, 12); } catch (e) { return 'PLAYER'; } }
  function saveName(n) { try { localStorage.setItem('stickman-brawl-name', n); } catch (e) {} }

  // Local test mode (?nettest in the address): two tabs on this computer talk through a BroadcastChannel
  const LOCAL_TEST = /[?&]nettest/.test(location.search);
  function localPeer(id) {
    // a tiny fake of the bits of PeerJS we use
    const handlers = {};
    const peer = { id, on: (ev, fn) => { handlers[ev] = fn; }, destroy() { if (peer.bc) peer.bc.close(); }, connect(target) { return localConn(id, target, true); } };
    peer.bc = new BroadcastChannel('sb-lobby-' + id);
    peer.bc.onmessage = e => { if (e.data.hello && handlers.connection) handlers.connection(localConn(id, e.data.from, false)); };
    setTimeout(() => handlers.open && handlers.open(id), 50);
    return peer;
  }
  function localConn(me, them, initiator) {
    const h = {};
    const ch = new BroadcastChannel('sb-conn-' + [me, them].sort().join('-'));
    const c = { open: false, on: (ev, fn) => { h[ev] = fn; }, send: d => ch.postMessage({ from: me, d }), close() { ch.postMessage({ from: me, bye: 1 }); ch.close(); h.close && h.close(); } };
    ch.onmessage = e => {
      if (e.data.from === me) return;
      if (e.data.bye) { h.close && h.close(); return; }
      if (e.data.syn) { if (!c.open) { c.open = true; ch.postMessage({ from: me, syn: 1 }); h.open && h.open(); } return; }
      h.data && h.data(e.data.d);
    };
    if (initiator) {
      const lobby = new BroadcastChannel('sb-lobby-' + them);
      lobby.postMessage({ hello: 1, from: me }); lobby.close();
      const knock = () => { if (!c.open) { ch.postMessage({ from: me, syn: 1 }); setTimeout(knock, 150); } };
      setTimeout(knock, 100);
    }
    return c;
  }
  function makePeer(id) {
    if (LOCAL_TEST) return localPeer(id || ('guest' + Math.floor(realRandom() * 1e6)));
    if (typeof Peer === 'undefined') throw new Error('PeerJS did not load');
    return id ? new Peer(id, { debug: 1 }) : new Peer({ debug: 1 });
  }
  const randomCode = () => Array.from({ length: 5 }, () => CODE_CHARS[Math.floor(realRandom() * CODE_CHARS.length)]).join('');

  function host() {
    leave(true);
    netplay = newState('host');
    const N = netplay;
    N.code = randomCode();
    ui.show('hosting');
    let peer;
    try { peer = makePeer(PREFIX + N.code); } catch (e) { return fail('Could not start online play: ' + e.message); }
    N.peer = peer;
    peer.on('open', () => ui.render());
    peer.on('connection', conn => {
      if (N.conn) { try { conn.close(); } catch (e) {} return; }           // room is full
      attach(conn);
    });
    peer.on('error', err => {
      if (err && err.type === 'unavailable-id') { leave(true); return host(); }   // code already taken: make a new one
      fail(netError(err));
    });
  }
  function join(code) {
    code = (code || '').toUpperCase().replace(/[^A-Z]/g, '');
    if (code.length !== 5) { ui.flash('Codes are 5 letters'); return; }
    leave(true);
    netplay = newState('guest');
    const N = netplay;
    N.code = code;
    ui.show('connecting');
    let peer;
    try { peer = makePeer(null); } catch (e) { return fail('Could not start online play: ' + e.message); }
    N.peer = peer;
    peer.on('open', () => {
      const conn = peer.connect(PREFIX + code, { reliable: true, serialization: 'json' });
      attach(conn);
      setTimeout(() => { if (netplay === N && !N.connected) fail('Could not reach that room. Check the code, and that your friend is still hosting.'); }, 12000);
    });
    peer.on('error', err => fail(netError(err)));
  }
  function netError(err) {
    const t = err && err.type;
    if (t === 'peer-unavailable') return 'No room with that code. Check the code and that your friend is hosting.';
    if (t === 'network' || t === 'server-error' || t === 'socket-error') return 'Could not reach the matchmaking server. Check your internet connection.';
    if (t === 'browser-incompatible') return 'Online play is not supported here.';
    return 'Connection problem' + (t ? ' (' + t + ')' : '') + '.';
  }
  function attach(conn) {
    const N = netplay;
    N.conn = conn;
    conn.on('open', () => {
      N.connected = true;
      send({ k: 'hello', build: BUILD, version: APP_VERSION, name: N.name });
      if (N.role === 'host') sendOpts();
      N.pinger = setInterval(() => send({ k: 'ping', t: performance.now() }), 1000);
      ui.show('lobby');
      menuSfx('pick');
    });
    conn.on('data', onData);
    conn.on('close', () => { if (netplay === N) dropped('Your opponent left.'); });
    conn.on('error', () => { if (netplay === N) dropped('Lost the connection to your opponent.'); });
  }
  function send(m) { const N = netplay; if (N && N.conn && N.connected) { try { N.conn.send(m); } catch (e) {} } }
  function sendOpts() { const L = netplay.lobby; send({ k: 'opts', stage: L.stage, stocks: L.stocks }); }
  function sendPick() { const L = netplay.lobby; send({ k: 'pick', char: L.myChar, ready: L.myReady }); }

  function onData(m) {
    const N = netplay;
    if (!N || !m || typeof m !== 'object') return;
    switch (m.k) {
      case 'hello':
        N.theirBuild = m.build; N.theirVersion = m.version; N.theirName = String(m.name || 'PLAYER').slice(0, 12);
        ui.render(); break;
      case 'ping': send({ k: 'pong', t: m.t }); break;
      case 'pong': N.ping = Math.round(performance.now() - m.t); ui.render(); break;
      case 'opts': if (N.role === 'guest') { N.lobby.stage = m.stage | 0; N.lobby.stocks = m.stocks | 0; ui.render(); } break;
      case 'pick': N.lobby.theirChar = ROSTER.includes(m.char) ? m.char : null; N.lobby.theirReady = !!m.ready; ui.render(); break;
      case 'start': if (N.role === 'guest') beginMatch(m); break;
      case 'in': {
        const map = N.inputs && N.inputs[1 - N.me];
        if (!map) break;
        m.list.forEach((e, i) => { const t = m.t0 + i; if (t >= N.tick) map.set(t, dec(e)); });
        break;
      }
      case 'hash': {
        if (!N.active) break;
        const mine = N.hashes.get(m.t);
        if (mine !== undefined) { if (mine !== m.h) desync(m.t); }
        else N.theirHashes.set(m.t, m.h);
        break;
      }
      case 'leave': dropped(N.active ? 'Your opponent left the match.' : 'Your opponent left.'); break;
      case 'lobby': N.lobby.theirChar = null; N.lobby.theirReady = false; ui.render(); break;
    }
  }

  // ---------- the match ----------
  function hostStart() {
    const N = netplay, L = N.lobby;
    if (!N || N.role !== 'host' || !L.myChar || !L.theirChar || !L.myReady || !L.theirReady) return;
    if (N.theirBuild && N.theirBuild !== BUILD) { ui.flash('You are on different versions of the game - both update first'); return; }
    const oneWay = (N.ping || 80) / 2;
    const delay = clamp(Math.ceil((oneWay + 25) / (STEP * 1000)), 4, 30);   // input delay in game steps (120 per second)
    const m = { k: 'start', seed: (realRandom() * 2 ** 32) >>> 0, chars: [L.myChar, L.theirChar], names: [N.name, N.theirName],
                stage: L.stage, stocks: L.stocks, gore, delay };
    send(m);
    beginMatch(m);
  }
  let saved = null;                                 // your own settings, put back after playing online
  function beginMatch(m) {
    const N = netplay;
    if (!saved) saved = { turbo, gore, stage: gameOptions.stage, stocks: gameOptions.stocks, players: players.map(p => ({ ...p })), showControls };
    // rebuild both fighters from scratch, so nothing left over from earlier games can differ
    fighters.slice(0, REAL_FIGHTERS).forEach((f, i) => {
      for (const k of Object.keys(f)) delete f[k];
      Object.assign(f, makeFighter(FIGHTER_INIT[i]));
    });
    players.forEach((p, i) => { p.char = m.chars[i]; p.cpu = false; p.dev = 'net'; p.name = String(m.names[i] || 'P' + (i + 1)).slice(0, 12); });
    gameOptions.stage = m.stage; gameOptions.stocks = m.stocks; gore = !!m.gore;
    turbo = false; cannon.on = false; demo = null; showHitboxes = false; showControls = false;
    time = 0; simRng = null; dummyMode = 0;
    cam.x = W / 2; cam.y = 390; cam.z = 1;
    startMatch();
    for (const f of fighters.slice(0, REAL_FIGHTERS)) f.controller = 'net';
    Object.assign(N, {
      active: true, tick: 0, delay: m.delay, rng: makeRng(m.seed),
      inputs: [new Map(), new Map()], sentUpTo: m.delay - 1, outbox: [], outStart: null,
      carry: [null, null], cur: null, hashes: new Map(), theirHashes: new Map(), desynced: false,
      stalledSince: 0, escAt: 0,
    });
    for (let t = 0; t < m.delay; t++) { N.inputs[0].set(t, emptyInput()); N.inputs[1].set(t, emptyInput()); }
    ui.hide();
  }
  // One game step online. Returns false (and the game waits) if the other player's inputs aren't here yet.
  function netTick() {
    const N = netplay, t = N.tick;
    while (N.sentUpTo < t + N.delay) {                 // record + send your own input for a step a little in the future
      const ti = ++N.sentUpTo;
      const e = enc(sampleLocal(N));
      for (const k in pressed) delete pressed[k];
      N.inputs[N.me].set(ti, dec(e));                  // (decoded, exactly like the other side will see it)
      if (N.outStart === null) N.outStart = ti;
      N.outbox.push(e);
    }
    const theirs = N.inputs[1 - N.me].get(t);
    if (!theirs) {
      if (!N.stalledSince) N.stalledSince = performance.now();
      return false;
    }
    N.stalledSince = 0;
    const ins = [N.inputs[0].get(t), N.inputs[1].get(t)];
    if (hitstop > 0) {
      hitstop -= STEP;                                // hit-freeze: save the presses for after
      N.carry = ins.map((x, i) => mergeIn(N.carry[i], x));
    } else {
      N.cur = ins.map((x, i) => mergeIn(N.carry[i], x));
      N.carry = [null, null];
      simRng = N.rng;
      try { update(STEP); } finally { simRng = null; }
      N.cur = null;
    }
    N.inputs[0].delete(t); N.inputs[1].delete(t);
    N.tick++;
    if (N.tick % HASH_EVERY === 0) {
      const h = simHash();
      N.hashes.set(N.tick, h);
      send({ k: 'hash', t: N.tick, h });
      const theirsH = N.theirHashes.get(N.tick);
      if (theirsH !== undefined && theirsH !== h) desync(N.tick);
      for (const k of N.hashes.keys()) if (k < N.tick - HASH_EVERY * 10) { N.hashes.delete(k); N.theirHashes.delete(k); }
    }
    return true;
  }
  function netAfterFrame() {
    const N = netplay;
    if (N.outbox.length) { send({ k: 'in', t0: N.outStart, list: N.outbox }); N.outbox = []; N.outStart = null; }
    if (N.stalledSince && performance.now() - N.stalledSince > STALL_DROP * 1000) dropped('Lost the connection to your opponent.');
  }
  function netInputFor(f) {
    const N = netplay, i = fighters.indexOf(f);
    return (N && N.cur && N.cur[i]) || emptyInput();
  }
  function desync(t) {
    const N = netplay;
    if (N.desynced) return;
    N.desynced = true;
    console.warn('[online] DESYNC at step', t);
  }
  function netEscape() {
    const N = netplay, now = performance.now();
    if (now - N.escAt < 1500) { send({ k: 'leave' }); leave(false); backToSelect(); ui.flash('You left the match'); return; }
    N.escAt = now;
  }
  function netBackToLobby() {
    const N = netplay;
    if (!N) return;
    N.active = false;
    if (!N.connected) { leave(false); return; }
    N.lobby.myReady = false; N.lobby.theirReady = false;
    send({ k: 'lobby' });
    ui.show('lobby');
  }
  // The other player is gone (or we gave up waiting)
  function dropped(why) {
    const wasActive = netplay && netplay.active;
    leave(false);
    if (wasActive) backToSelect();
    ui.show('menu');
    ui.flash(why);
  }
  function fail(why) { leave(false); ui.show('menu'); ui.flash(why); }
  // Close the connection and put your own settings back
  function leave(quiet) {
    const N = netplay;
    if (N) {
      if (N.pinger) clearInterval(N.pinger);
      if (N.conn) { try { N.conn.close(); } catch (e) {} }
      if (N.peer) { try { N.peer.destroy(); } catch (e) {} }
    }
    netplay = null;
    if (saved) {
      turbo = saved.turbo; gore = saved.gore; gameOptions.stage = saved.stage; gameOptions.stocks = saved.stocks;
      saved.players.forEach((p, i) => Object.assign(players[i], p, { char: null }));
      showControls = saved.showControls;
      saved = null;
      for (const f of fighters.slice(0, REAL_FIGHTERS)) if (f.controller === 'net') f.controller = 'dummy';
    }
    if (!quiet) ui.render();
  }

  // On-screen extras during an online match: waiting message, ping, desync warning
  function netDrawOverlay() {
    const N = netplay;
    if (!N || !N.active || scene !== 'fight') return;
    sctx.save();
    sctx.font = '10px "Press Start 2P", monospace';
    sctx.textAlign = 'right'; sctx.fillStyle = 'rgba(255,255,255,0.55)';
    sctx.fillText('ONLINE  ' + (N.ping ? N.ping + 'ms' : '') + '  DELAY ' + Math.round(N.delay * STEP * 1000) + 'ms', W - 12, H - 10);
    if (N.escAt && performance.now() - N.escAt < 1500) {
      sctx.textAlign = 'center'; sctx.fillStyle = '#ffd23f'; sctx.font = '14px "Press Start 2P", monospace';
      sctx.fillText('PRESS ESC AGAIN TO LEAVE THE MATCH', W / 2, 60);
    }
    if (N.stalledSince && performance.now() - N.stalledSince > 400) {
      sctx.fillStyle = 'rgba(0,0,0,0.55)'; sctx.fillRect(0, H / 2 - 40, W, 80);
      sctx.textAlign = 'center'; sctx.fillStyle = '#ffffff'; sctx.font = '18px "Press Start 2P", monospace';
      sctx.fillText('WAITING FOR OPPONENT...', W / 2, H / 2 + 8);
    }
    if (N.desynced) {
      sctx.textAlign = 'left'; sctx.fillStyle = '#ff5a3c'; sctx.font = '10px "Press Start 2P", monospace';
      sctx.fillText('DESYNC - the two games no longer match. Leave and rematch.', 12, H - 10);
    }
    sctx.restore();
  }

  // =====================================================================
  //  The ONLINE screens (plain HTML over the game)
  // =====================================================================
  const ui = (() => {
    const css = `
      #sbNetBtn { position: fixed; left: 12px; top: 12px; z-index: 20; font: 12px "Press Start 2P", monospace; color: #1a1408;
        background: #ffd23f; border: 3px solid #1a1408; padding: 9px 12px; cursor: pointer; box-shadow: 3px 3px 0 #1a1408; }
      #sbNetBtn:hover { background: #ffe27a; }
      #sbNet { position: fixed; inset: 0; z-index: 30; display: none; align-items: center; justify-content: center;
        background: rgba(8,6,6,0.72); font: 11px/1.7 "Press Start 2P", monospace; color: #f3ece4; }
      #sbNet .box { background: #1d1716; border: 3px solid #ffd23f; padding: 20px 22px; width: min(640px, calc(100vw - 32px));
        max-height: calc(100vh - 32px); overflow: auto; box-shadow: 6px 6px 0 #000; }
      #sbNet h2 { margin: 0 0 12px; font-size: 16px; color: #ffd23f; }
      #sbNet p { margin: 8px 0; color: #cbbfb1; }
      #sbNet button { font: 11px "Press Start 2P", monospace; padding: 9px 12px; margin: 4px 6px 4px 0; cursor: pointer;
        background: #3a302c; color: #f3ece4; border: 2px solid #6d5f57; }
      #sbNet button:hover:not(:disabled) { border-color: #ffd23f; }
      #sbNet button.on { background: #ffd23f; color: #1a1408; border-color: #ffd23f; }
      #sbNet button.go { background: #d63a2a; border-color: #ff7a5c; color: #fff; }
      #sbNet button:disabled { opacity: 0.4; cursor: default; }
      #sbNet input { font: 14px "Press Start 2P", monospace; padding: 8px; width: 9em; text-transform: uppercase;
        background: #0e0b0b; color: #ffd23f; border: 2px solid #6d5f57; }
      #sbNet .code { font-size: 30px; color: #ffd23f; letter-spacing: 6px; margin: 10px 0; user-select: all; }
      #sbNet .row { margin: 12px 0; }
      #sbNet .lbl { color: #8f8278; display: block; margin-bottom: 4px; }
      #sbNet .flash { color: #ff7a5c; min-height: 1.7em; }
      #sbNet .two { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
      #sbNet .card { background: #120e0d; border: 2px solid #3a302c; padding: 10px; }
      #sbNet .ok { color: #7be08a; }
      #sbNet .warn { color: #ff7a5c; }
      #sbNet .ver { color: #6d5f57; font-size: 9px; margin-top: 12px; }
      @media (max-width: 560px) { #sbNet .two { grid-template-columns: 1fr; } }`;
    const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    const btn = document.createElement('button'); btn.id = 'sbNetBtn'; btn.textContent = 'ONLINE';
    const wrap = document.createElement('div'); wrap.id = 'sbNet';
    const box = document.createElement('div'); box.className = 'box'; wrap.appendChild(box);
    document.body.append(btn, wrap);
    // keep the game from seeing clicks / keys meant for these screens
    for (const ev of ['keydown', 'keyup', 'mousedown', 'mouseup', 'click', 'wheel']) {
      wrap.addEventListener(ev, e => e.stopPropagation());
      btn.addEventListener(ev, e => e.stopPropagation());
    }
    btn.addEventListener('click', () => { open = true; show(netplay ? (netplay.connected ? 'lobby' : view) : 'menu'); });

    let view = 'menu', open = false, flashMsg = '', flashT = 0;
    function show(v) { view = v; open = true; render(); }
    function hide() { open = false; render(); }
    function flash(msg) { flashMsg = msg; flashT = performance.now(); open = true; render(); }
    // the ONLINE button only on the character select screen
    (function tick() {
      btn.style.display = scene === 'select' && !open ? 'block' : 'none';
      window.sbNetOpen = open && scene !== 'fight';
      if (open && scene === 'fight') { wrap.style.display = 'none'; } else wrap.style.display = open ? 'flex' : 'none';
      requestAnimationFrame(tick);
    })();

    const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    function render() {
      const N = netplay;
      const fl = flashMsg && performance.now() - flashT < 8000 ? `<p class="flash">${esc(flashMsg)}</p>` : '<p class="flash"></p>';
      const ver = `<div class="ver">VERSION ${esc(APP_VERSION)} · BUILD ${esc(BUILD)}${LOCAL_TEST ? ' · LOCAL TEST MODE' : ''}</div>`;
      let h = '';
      if (view === 'menu' || !N) {
        h = `<h2>ONLINE PLAY</h2>
          <p>Fight a friend over the internet. One of you hosts and gets a code; the other joins with it.</p>
          <div class="row"><span class="lbl">YOUR NAME</span><input id="sbName" maxlength="12" value="${esc(loadName())}"></div>
          <div class="row"><button class="go" data-a="host">HOST A GAME</button></div>
          <div class="row"><span class="lbl">JOIN WITH A CODE</span><input id="sbCode" maxlength="5" placeholder="ABCDE"> <button data-a="join">JOIN</button></div>
          ${fl}<div class="row"><button data-a="close">BACK</button></div>${ver}`;
      } else if (view === 'hosting') {
        h = `<h2>HOSTING</h2>
          <p>${N.peer && (N.peer.open || LOCAL_TEST) ? 'Send this code to your friend:' : 'Getting a code...'}</p>
          <div class="code">${N.peer ? esc(N.code) : '.....'}</div>
          <p>Waiting for them to join...</p>${fl}
          <div class="row"><button data-a="copy">COPY CODE</button><button data-a="cancel">CANCEL</button></div>${ver}`;
      } else if (view === 'connecting') {
        h = `<h2>JOINING ${esc(N.code)}</h2><p>Connecting...</p>${fl}<div class="row"><button data-a="cancel">CANCEL</button></div>${ver}`;
      } else if (view === 'lobby') {
        const L = N.lobby, isHost = N.role === 'host';
        const mismatch = N.theirBuild && N.theirBuild !== BUILD;
        const chars = ROSTER.filter(Boolean).map(c => `<button data-a="char" data-v="${c}" class="${L.myChar === c ? 'on' : ''}">${c}</button>`).join('');
        const stages = STAGE_LIST.map((s, i) => `<button data-a="stage" data-v="${i}" class="${L.stage === i ? 'on' : ''}" ${isHost ? '' : 'disabled'}>${s.name}</button>`).join('');
        const pads = getPads().map((g, k) => g && g.connected ? 'pad' + k : null).filter(Boolean);
        const devs = ['keyboard', ...pads].map(d => `<button data-a="dev" data-v="${d}" class="${N.dev === d ? 'on' : ''}">${d === 'keyboard' ? 'KEYBOARD' : 'CONTROLLER ' + (+d.slice(3) + 1)}</button>`).join('');
        const canStart = isHost && L.myChar && L.theirChar && L.myReady && L.theirReady && !mismatch;
        h = `<h2>ONLINE LOBBY</h2>
          <p>${isHost ? 'Hosting' : 'Joined'} room <span style="color:#ffd23f">${esc(N.code)}</span> · ping <span class="${N.ping > 150 ? 'warn' : 'ok'}">${N.ping ? N.ping + 'ms' : '...'}</span></p>
          ${mismatch ? `<p class="warn">You and ${esc(N.theirName)} have different versions of the game. Both of you need the latest version to play.</p>` : ''}
          <div class="two">
            <div class="card"><span class="lbl">YOU (${esc(N.name)})</span>${L.myChar ? esc(L.myChar) : '<span class="warn">pick a fighter</span>'} ${L.myReady ? '<span class="ok">READY</span>' : ''}</div>
            <div class="card"><span class="lbl">${esc(N.theirName)}</span>${L.theirChar ? esc(L.theirChar) : 'picking...'} ${L.theirReady ? '<span class="ok">READY</span>' : ''}</div>
          </div>
          <div class="row"><span class="lbl">YOUR FIGHTER</span>${chars}</div>
          <div class="row"><span class="lbl">STAGE ${isHost ? '' : '(HOST PICKS)'}</span>${stages}</div>
          <div class="row"><span class="lbl">STOCKS ${isHost ? '' : '(HOST PICKS)'}</span>
            <button data-a="stocks" data-v="-1" ${isHost ? '' : 'disabled'}>-</button> ${L.stocks > 0 ? L.stocks : 'FREE PLAY'} <button data-a="stocks" data-v="1" ${isHost ? '' : 'disabled'}>+</button></div>
          <div class="row"><span class="lbl">YOUR CONTROLS</span>${devs}</div>
          ${fl}
          <div class="row">
            <button data-a="ready" class="${L.myReady ? 'on' : ''}" ${L.myChar ? '' : 'disabled'}>${L.myReady ? 'READY!' : 'READY?'}</button>
            ${isHost ? `<button class="go" data-a="start" ${canStart ? '' : 'disabled'}>START MATCH</button>` : '<span class="lbl" style="display:inline">the host starts the match</span>'}
            <button data-a="leave">LEAVE</button>
          </div>
          <p>Online tip: ESC twice leaves a match.</p>${ver}`;
      }
      box.innerHTML = h;
      const nameIn = box.querySelector('#sbName');
      if (nameIn) nameIn.addEventListener('input', () => saveName(nameIn.value.trim().slice(0, 12) || 'PLAYER'));
      const codeIn = box.querySelector('#sbCode');
      if (codeIn) codeIn.addEventListener('keydown', e => { if (e.key === 'Enter') join(codeIn.value); });
    }
    box.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b || b.disabled) return;
      const a = b.dataset.a, v = b.dataset.v, N = netplay;
      if (a === 'host') host();
      else if (a === 'join') join(box.querySelector('#sbCode').value);
      else if (a === 'close') { open = false; render(); }
      else if (a === 'cancel' || a === 'leave') { send({ k: 'leave' }); leave(false); show('menu'); }
      else if (a === 'copy') { try { navigator.clipboard.writeText(N.code); flash('Code copied'); } catch (err) {} }
      else if (!N) return;
      else if (a === 'char') { N.lobby.myChar = v; N.lobby.myReady = false; sendPick(); menuSfx('pick'); render(); }
      else if (a === 'ready') { N.lobby.myReady = !N.lobby.myReady; sendPick(); menuSfx('move'); render(); }
      else if (a === 'stage' && N.role === 'host') { N.lobby.stage = +v; sendOpts(); render(); }
      else if (a === 'stocks' && N.role === 'host') { N.lobby.stocks = (N.lobby.stocks + (+v) + 100) % 100; sendOpts(); render(); }
      else if (a === 'dev') { N.dev = v; render(); }
      else if (a === 'start') hostStart();
    });
    return { show, hide, flash, render };
  })();

  // hooks the game calls
  Object.assign(window, { netTick, netAfterFrame, netInputFor, netEscape, netBackToLobby, netDrawOverlay,
                          sbNet: { host, join, leave, BUILD, ui, enc, dec, simHash } });
})();
