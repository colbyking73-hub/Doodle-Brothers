// =====================================================================
//  DOODLE BROTHERS - ONLINE PLAY (up to 4 players, teams)
//
//  Peer-to-peer: one player HOSTS (gets a 5-letter code), up to 3 friends JOIN with that code. Everyone
//  connects to the host (WebRTC, through PeerJS's free matchmaking server). The host runs the lobby:
//  4 player slots (P1 = host), which can also be filled with CPUs, plus stage / stocks / TEAMS.
//
//  Netcode = LOCKSTEP with input delay: only button presses are sent, never positions. Every game runs
//  the exact same fight from the exact same inputs (and the same shared random numbers), so they stay
//  identical. Guests send their presses to the host, and the host RELAYS everyone's presses to everyone.
//  Your own presses are applied a few game steps late (the "delay", set from the worst ping) so everyone
//  else's presses for that step have time to arrive. If they haven't arrived, the game waits.
//  CPUs need no inputs: their AI runs inside the shared fight, identically on every computer.
//  A checksum of the fight is compared every second to catch the games drifting apart (DESYNC).
// =====================================================================
(() => {
  const PREFIX = 'stickman-brawl-v1-';            // PeerJS ids: PREFIX + 5-letter room code
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';  // (no I / O, they look like 1 / 0)
  const HASH_EVERY = 120;                          // compare fight checksums every 120 steps (1 second)
  const STALL_DROP = 10;                           // seconds of waiting for a player before giving up
  const SLOTS = 4;

  // Which version of the game this is: everyone must run the same one (any change to the game
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

  // ---------- inputs: packed small to send, unpacked the same way everywhere ----------
  const BITS = ['up', 'down', 'jumpTap', 'jumpHeld', 'blockTap', 'blockHeld', 'dirTap', 'downTap',
                'atkTap', 'atkHeld', 'spcTap', 'spcHeld', 'grabTap', 'ultTap'];
  function enc(inp) {
    let b = 0;
    BITS.forEach((k, i) => { if (inp[k]) b |= 1 << i; });
    const c = inp.cFlick ? [inp.cFlick.btn === 'atk' ? 1 : 2, inp.cFlick.dir | 0, inp.cFlick.up ? 1 : 0, inp.cFlick.down ? 1 : 0] : 0;
    return [b, inp.dir | 0, inp.flyTap | 0, c, inp.taunt | 0];
  }
  function dec(e) {
    const inp = emptyInput();
    BITS.forEach((k, i) => { inp[k] = !!(e[0] & (1 << i)); });
    inp.dir = e[1]; inp.flyTap = e[2];
    if (e[3]) inp.cFlick = { btn: e[3][0] === 1 ? 'atk' : 'spc', dir: e[3][1], up: !!e[3][2], down: !!e[3][3] };
    inp.taunt = e[4] | 0;
    return inp;
  }
  // Inputs that arrive during a hit-freeze are saved up and used on the next real step (like offline)
  function mergeIn(a, b) {
    if (!a) return b;
    const m = { ...b };
    for (const k of BITS) if (k.endsWith('Tap') && a[k]) m[k] = true;
    if (!m.flyTap && a.flyTap) m.flyTap = a.flyTap;
    if (!m.cFlick && a.cFlick) m.cFlick = a.cFlick;
    if (!m.taunt && a.taunt) m.taunt = a.taunt;
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

  // ---------- the lobby: 4 slots ----------
  // slot = { kind: 'human' | 'cpu' | 'empty', name, char, ready, team, level, build, ping }
  const emptySlot = i => ({ kind: 'empty', name: 'P' + (i + 1), char: null, ready: false, team: i % 2, level: 'AI NORMAL', build: null, ping: 0 });
  function newState(role) {
    return {
      role, me: role === 'host' ? 0 : -1, peer: null, conn: null, conns: new Map(), connected: false, active: false,
      code: '', ping: 0, name: loadName(), dev: 'keyboard',
      slots: Array.from({ length: SLOTS }, (_, i) => emptySlot(i)),
      opts: { stage: gameOptions.stage || 0, stocks: gameOptions.stocks || 3, teams: !!gameOptions.teams },
    };
  }
  function loadName() { try { return (localStorage.getItem('stickman-brawl-name') || 'PLAYER').slice(0, 12); } catch (e) { return 'PLAYER'; } }
  function saveName(n) { try { localStorage.setItem('stickman-brawl-name', n); } catch (e) {} }

  // Local test mode (?nettest in the address): tabs / frames on this computer talk through BroadcastChannels
  const LOCAL_TEST = /[?&]nettest/.test(location.search);
  function localPeer(id) {
    // a tiny fake of the bits of PeerJS we use
    const handlers = {};
    const peer = { id, open: true, on: (ev, fn) => { handlers[ev] = fn; }, destroy() { if (peer.bc) peer.bc.close(); }, connect(target) { return localConn(id, target, true); } };
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

  // ---------- HOST ----------
  function host() {
    leave(true);
    netplay = newState('host');
    const N = netplay;
    N.code = randomCode();
    N.connected = true;                                   // (the host is "in" its own room straight away)
    Object.assign(N.slots[0], { kind: 'human', name: N.name, build: BUILD });
    ui.show('lobby');
    let peer;
    try { peer = makePeer(PREFIX + N.code); } catch (e) { return fail('Could not start online play: ' + e.message); }
    N.peer = peer;
    peer.on('open', () => ui.render());
    peer.on('connection', conn => {
      const slot = N.slots.findIndex((s, i) => i > 0 && s.kind === 'empty');
      if (slot < 0 || N.active) {                         // room full (or mid-match)
        conn.on('open', () => { try { conn.send({ k: 'full' }); } catch (e) {} setTimeout(() => { try { conn.close(); } catch (e) {} }, 300); });
        return;
      }
      N.slots[slot] = { ...emptySlot(slot), kind: 'human', name: 'P' + (slot + 1) };   // reserve it
      N.conns.set(slot, conn);
      conn.on('open', () => { conn.send({ k: 'welcome', slot }); broadcastRoster(); menuSfx('pick'); });
      conn.on('data', m => hostData(slot, m));
      const gone = () => { if (netplay === N && N.conns.get(slot) === conn) guestLeft(slot); };
      conn.on('close', gone); conn.on('error', gone);
    });
    peer.on('error', err => {
      if (err && err.type === 'unavailable-id') { leave(true); return host(); }   // code already taken: make a new one
      if (err && err.type === 'peer-unavailable') return;                         // (a guest that vanished)
      fail(netError(err));
    });
    N.pinger = setInterval(() => { for (const c of N.conns.values()) try { c.send({ k: 'ping', t: performance.now() }); } catch (e) {} }, 1000);
  }
  function sendTo(slot, m) { const c = netplay && netplay.conns.get(slot); if (c) { try { c.send(m); } catch (e) {} } }
  function broadcast(m, except = -1) { const N = netplay; if (!N) return; for (const [slot, c] of N.conns) if (slot !== except) { try { c.send(m); } catch (e) {} } }
  function broadcastRoster() {
    const N = netplay;
    broadcast({ k: 'roster', slots: N.slots.map(s => ({ ...s })), opts: { ...N.opts } });
    ui.render();
  }
  function hostData(slot, m) {
    const N = netplay;
    if (!N || !m || typeof m !== 'object') return;
    const S = N.slots[slot];
    switch (m.k) {
      case 'hello': S.name = String(m.name || 'P' + (slot + 1)).slice(0, 12); S.build = m.build; broadcastRoster(); break;
      case 'ping': sendTo(slot, { k: 'pong', t: m.t }); break;
      case 'pong': S.ping = Math.round(performance.now() - m.t); ui.render(); break;
      case 'pick':
        if (N.active) break;
        S.char = ROSTER.includes(m.char) ? m.char : null; S.ready = !!m.ready && !!S.char;
        if (m.team === 0 || m.team === 1) S.team = m.team;
        broadcastRoster(); break;
      case 'in':                                          // a guest's presses: keep them, and pass them on to everyone else
        storeInputs(slot, m.t0, m.list);
        broadcast({ k: 'in', p: slot, t0: m.t0, list: m.list }, slot);
        break;
      case 'hash': if (N.active) checkHash(m.t, m.h); break;
      case 'lobby': S.ready = false; broadcastRoster(); break;
      case 'leave': guestLeft(slot); break;
    }
  }
  function guestLeft(slot) {
    const N = netplay;
    const c = N.conns.get(slot);
    N.conns.delete(slot);
    if (c) { try { c.close(); } catch (e) {} }
    const name = N.slots[slot].name;
    N.slots[slot] = emptySlot(slot);
    if (N.active) {                                       // mid-match: the match is over for everyone
      broadcast({ k: 'abort', why: name + ' left the match.' });
      endMatchBack(name + ' left the match.');
    } else { broadcastRoster(); ui.flash(name + ' left.'); }
  }

  // ---------- GUEST ----------
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
      N.conn = conn;
      conn.on('open', () => {
        N.connected = true;
        conn.send({ k: 'hello', build: BUILD, version: APP_VERSION, name: N.name });
        N.pinger = setInterval(() => { try { conn.send({ k: 'ping', t: performance.now() }); } catch (e) {} }, 1000);
      });
      conn.on('data', guestData);
      conn.on('close', () => { if (netplay === N) dropped('The host closed the room.'); });
      conn.on('error', () => { if (netplay === N) dropped('Lost the connection to the host.'); });
      setTimeout(() => { if (netplay === N && N.me < 0) fail('Could not reach that room. Check the code, and that your friend is still hosting.'); }, 12000);
    });
    peer.on('error', err => fail(netError(err)));
  }
  function toHost(m) { const N = netplay; if (N && N.conn && N.connected) { try { N.conn.send(m); } catch (e) {} } }
  function guestData(m) {
    const N = netplay;
    if (!N || !m || typeof m !== 'object') return;
    switch (m.k) {
      case 'welcome': N.me = m.slot; ui.show('lobby'); menuSfx('pick'); sendPick(); break;
      case 'full': fail('That room is full (4 players).'); break;
      case 'roster': N.slots = m.slots; N.opts = m.opts; ui.render(); break;
      case 'ping': toHost({ k: 'pong', t: m.t }); break;
      case 'pong': N.ping = Math.round(performance.now() - m.t); ui.render(); break;
      case 'start': beginMatch(m); break;
      case 'in': storeInputs(m.p, m.t0, m.list); break;
      case 'hash': if (N.active) checkHash(m.t, m.h); break;
      case 'abort': endMatchBack(m.why || 'The match was stopped.'); break;
    }
  }
  function netError(err) {
    const t = err && err.type;
    if (t === 'peer-unavailable') return 'No room with that code. Check the code and that your friend is hosting.';
    if (t === 'network' || t === 'server-error' || t === 'socket-error') return 'Could not reach the matchmaking server. Check your internet connection.';
    if (t === 'browser-incompatible') return 'Online play is not supported here.';
    return 'Connection problem' + (t ? ' (' + t + ')' : '') + '.';
  }
  // my lobby choices -> the host (the host just changes its own slot)
  function sendPick() {
    const N = netplay, S = N.slots[N.me];
    if (!S) return;
    if (N.role === 'host') broadcastRoster();
    else toHost({ k: 'pick', char: S.char, ready: S.ready, team: S.team });
  }

  // ---------- the match ----------
  function canStart() {
    const N = netplay;
    if (!N || N.role !== 'host') return false;
    const inMatch = N.slots.filter(s => s.kind !== 'empty');
    if (inMatch.length < 2) return false;
    if (!inMatch.every(s => s.char)) return false;
    if (!N.slots.every(s => s.kind !== 'human' || s.ready || s === N.slots[0])) return false;
    if (N.opts.teams && new Set(inMatch.map(s => s.team)).size < 2) return false;
    return true;
  }
  function versionProblem() { const N = netplay; return N.slots.find(s => s.kind === 'human' && s.build && s.build !== BUILD); }
  function hostStart() {
    const N = netplay;
    if (!canStart()) return;
    const bad = versionProblem();
    if (bad) { ui.flash(bad.name + ' has a different version of the game - everyone update first'); return; }
    // input delay: a guest's presses go guest -> host -> other guests, so allow for the worst round trip
    const worst = Math.max(80, ...N.slots.filter(s => s.kind === 'human').map(s => s.ping || 0));
    const relay = N.conns.size > 1 ? worst : worst / 2;
    const delay = clamp(Math.ceil((relay + 25) / (STEP * 1000)), 4, 36);
    const m = { k: 'start', seed: (realRandom() * 2 ** 32) >>> 0, slots: N.slots.map(s => ({ ...s })), opts: { ...N.opts }, gore, delay };
    broadcast(m);
    beginMatch(m);
  }
  let saved = null;                                 // your own settings, put back after playing online
  function beginMatch(m) {
    const N = netplay;
    if (!saved) saved = { turbo, gore, stage: gameOptions.stage, stocks: gameOptions.stocks, teams: gameOptions.teams,
                          players: players.map(p => ({ ...p })), showControls };
    N.slots = m.slots; N.opts = m.opts;
    N.humans = m.slots.map((s, i) => s.kind === 'human' ? i : -1).filter(i => i >= 0);
    // rebuild every fighter from scratch, so nothing left over from earlier games can differ
    fighterPool.forEach((f, i) => {
      for (const k of Object.keys(f)) delete f[k];
      Object.assign(f, makeFighter(FIGHTER_INIT[i])); f.slot = i;
    });
    m.slots.forEach((s, i) => {
      const p = players[i];
      p.off = s.kind === 'empty'; p.char = s.char; p.team = s.team;
      p.cpu = s.kind === 'cpu'; p.level = s.level || 'AI NORMAL'; p.dev = s.kind === 'human' ? 'net' : null;
      p.name = String(s.kind === 'cpu' ? 'CPU' : s.name || 'P' + (i + 1)).slice(0, 12);
    });
    gameOptions.stage = m.opts.stage; gameOptions.stocks = m.opts.stocks; gameOptions.teams = !!m.opts.teams; gore = !!m.gore;
    turbo = false; cannon.on = false; demo = null; showHitboxes = false; showControls = false;
    time = 0; simRng = null; dummyMode = 0;
    cam.x = W / 2; cam.y = 390; cam.z = 1;
    startMatch();
    for (const i of N.humans) fighterPool[i].controller = 'net';
    const inputs = {}, carry = {};
    for (const i of N.humans) { inputs[i] = new Map(); carry[i] = null; for (let t = 0; t < m.delay; t++) inputs[i].set(t, emptyInput()); }
    Object.assign(N, {
      active: true, tick: 0, delay: m.delay, rng: makeRng(m.seed),
      inputs, carry, sentUpTo: m.delay - 1, outbox: [], outStart: null,
      cur: null, hashes: new Map(), theirHashes: new Map(), desynced: false,
      stalledSince: 0, escAt: 0, waitingOn: null,
    });
    ui.hide();
  }
  function storeInputs(slot, t0, list) {
    const N = netplay, map = N && N.inputs && N.inputs[slot];
    if (!map) return;
    list.forEach((e, i) => { const t = t0 + i; if (t >= N.tick) map.set(t, dec(e)); });
  }
  // One game step online. Returns false (and the game waits) if someone's inputs aren't here yet.
  function netTick() {
    const N = netplay, t = N.tick;
    while (N.sentUpTo < t + N.delay) {                 // record + send your own input for a step a little in the future
      const ti = ++N.sentUpTo;
      const e = enc(sampleLocal(N));
      for (const k in pressed) delete pressed[k];
      N.inputs[N.me].set(ti, dec(e));                  // (decoded, exactly like everyone else will see it)
      if (N.outStart === null) N.outStart = ti;
      N.outbox.push(e);
    }
    const missing = N.humans.find(i => !N.inputs[i].has(t));
    if (missing !== undefined) {
      if (!N.stalledSince) N.stalledSince = performance.now();
      N.waitingOn = missing;
      return false;
    }
    N.stalledSince = 0; N.waitingOn = null;
    const ins = {};
    for (const i of N.humans) ins[i] = N.inputs[i].get(t);
    if (hitstop > 0) {
      hitstop -= STEP;                                // hit-freeze: save the presses for after
      for (const i of N.humans) N.carry[i] = mergeIn(N.carry[i], ins[i]);
    } else {
      N.cur = {};
      for (const i of N.humans) { N.cur[i] = mergeIn(N.carry[i], ins[i]); N.carry[i] = null; }
      simRng = N.rng;
      try { update(STEP); } finally { simRng = null; }
      N.cur = null;
    }
    for (const i of N.humans) N.inputs[i].delete(t);
    N.tick++;
    if (N.tick % HASH_EVERY === 0) {
      const h = simHash();
      N.hashes.set(N.tick, h);
      if (N.role === 'host') broadcast({ k: 'hash', t: N.tick, h }); else toHost({ k: 'hash', t: N.tick, h });
      const theirsH = N.theirHashes.get(N.tick);
      if (theirsH !== undefined && theirsH !== h) desync(N.tick);
      for (const k of N.hashes.keys()) if (k < N.tick - HASH_EVERY * 10) { N.hashes.delete(k); N.theirHashes.delete(k); }
    }
    return true;
  }
  function checkHash(t, h) {
    const N = netplay;
    const mine = N.hashes.get(t);
    if (mine !== undefined) { if (mine !== h) desync(t); }
    else N.theirHashes.set(t, h);
  }
  function netAfterFrame() {
    const N = netplay;
    if (N.outbox.length) {
      const m = { k: 'in', t0: N.outStart, list: N.outbox };
      if (N.role === 'host') broadcast({ ...m, p: 0 }); else toHost(m);
      N.outbox = []; N.outStart = null;
    }
    if (N.stalledSince && performance.now() - N.stalledSince > STALL_DROP * 1000) {
      const who = N.slots[N.waitingOn] ? N.slots[N.waitingOn].name : 'a player';
      if (N.role === 'host') { if (N.waitingOn > 0) guestLeft(N.waitingOn); }
      else dropped('Lost the connection to ' + who + '.');
    }
  }
  function netInputFor(f) {
    const N = netplay;
    return (N && N.cur && N.cur[f.slot]) || emptyInput();
  }
  function desync(t) {
    const N = netplay;
    if (N.desynced) return;
    N.desynced = true;
    console.warn('[online] DESYNC at step', t);
  }
  function netEscape() {
    const N = netplay, now = performance.now();
    if (now - N.escAt < 1500) {
      if (N.role === 'host') { broadcast({ k: 'abort', why: 'The host left the match.' }); endMatchBack('You left the match'); }
      else { toHost({ k: 'leave' }); leave(false); backToSelect(); ui.show('menu'); ui.flash('You left the match'); }
      return;
    }
    N.escAt = now;
  }
  // after the results screen (or a stopped match): everyone goes back to the online lobby
  function netBackToLobby() {
    const N = netplay;
    if (!N) return;
    N.active = false;
    if (!N.connected) { leave(false); return; }
    for (const s of N.slots) s.ready = false;
    if (N.role === 'host') broadcastRoster(); else toHost({ k: 'lobby' });
    ui.show('lobby');
  }
  function endMatchBack(why) {
    const N = netplay;
    if (N && N.active) { N.active = false; backToSelect(); }
    if (N) for (const s of N.slots) s.ready = false;
    ui.show('lobby'); ui.flash(why);
    if (N && N.role === 'host') broadcastRoster();
  }
  // Lost the room
  function dropped(why) {
    const wasActive = netplay && netplay.active;
    leave(false);
    if (wasActive) backToSelect();
    ui.show('menu');
    ui.flash(why);
  }
  function fail(why) { leave(false); ui.show('menu'); ui.flash(why); }
  // Close the connections and put your own settings back
  function leave(quiet) {
    const N = netplay;
    if (N) {
      if (N.pinger) clearInterval(N.pinger);
      if (N.conn) { try { N.conn.close(); } catch (e) {} }
      for (const c of N.conns.values()) { try { c.close(); } catch (e) {} }
      if (N.peer) { try { N.peer.destroy(); } catch (e) {} }
    }
    netplay = null;
    if (saved) {
      turbo = saved.turbo; gore = saved.gore; gameOptions.stage = saved.stage; gameOptions.stocks = saved.stocks; gameOptions.teams = saved.teams;
      saved.players.forEach((p, i) => Object.assign(players[i], p, { char: null }));
      showControls = saved.showControls;
      saved = null;
      for (const f of fighterPool) if (f.controller === 'net') f.controller = 'dummy';
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
    sctx.fillText('ONLINE  ' + (N.role === 'guest' && N.ping ? N.ping + 'ms  ' : '') + 'DELAY ' + Math.round(N.delay * STEP * 1000) + 'ms', W - 12, H - 10);
    if (N.escAt && performance.now() - N.escAt < 1500) {
      sctx.textAlign = 'center'; sctx.fillStyle = '#ffd23f'; sctx.font = '14px "Press Start 2P", monospace';
      sctx.fillText('PRESS ESC AGAIN TO LEAVE THE MATCH', W / 2, 60);
    }
    if (N.stalledSince && performance.now() - N.stalledSince > 400) {
      sctx.fillStyle = 'rgba(0,0,0,0.55)'; sctx.fillRect(0, H / 2 - 40, W, 80);
      sctx.textAlign = 'center'; sctx.fillStyle = '#ffffff'; sctx.font = '18px "Press Start 2P", monospace';
      const who = N.slots[N.waitingOn] ? N.slots[N.waitingOn].name : 'OPPONENT';
      sctx.fillText('WAITING FOR ' + String(who).toUpperCase() + '...', W / 2, H / 2 + 8);
    }
    if (N.desynced) {
      sctx.textAlign = 'left'; sctx.fillStyle = '#ff5a3c'; sctx.font = '10px "Press Start 2P", monospace';
      sctx.fillText('DESYNC - the games no longer match. Leave and rematch.', 12, H - 10);
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
      #sbNet .box { background: #1d1716; border: 3px solid #ffd23f; padding: 18px 20px; width: min(760px, calc(100vw - 32px));
        max-height: calc(100vh - 32px); overflow: auto; box-shadow: 6px 6px 0 #000; }
      #sbNet h2 { margin: 0 0 10px; font-size: 16px; color: #ffd23f; }
      #sbNet p { margin: 8px 0; color: #cbbfb1; }
      #sbNet button { font: 10px "Press Start 2P", monospace; padding: 8px 10px; margin: 3px 5px 3px 0; cursor: pointer;
        background: #3a302c; color: #f3ece4; border: 2px solid #6d5f57; }
      #sbNet button:hover:not(:disabled) { border-color: #ffd23f; }
      #sbNet button.on { background: #ffd23f; color: #1a1408; border-color: #ffd23f; }
      #sbNet button.go { background: #d63a2a; border-color: #ff7a5c; color: #fff; }
      #sbNet button.red { background: #e8433a; border-color: #e8433a; color: #fff; }
      #sbNet button.blue { background: #3a8ee8; border-color: #3a8ee8; color: #fff; }
      #sbNet button:disabled { opacity: 0.4; cursor: default; }
      #sbNet input { font: 14px "Press Start 2P", monospace; padding: 8px; width: 9em; text-transform: uppercase;
        background: #0e0b0b; color: #ffd23f; border: 2px solid #6d5f57; }
      #sbNet .code { font-size: 26px; color: #ffd23f; letter-spacing: 6px; user-select: all; }
      #sbNet .row { margin: 10px 0; }
      #sbNet .lbl { color: #8f8278; display: block; margin-bottom: 4px; }
      #sbNet .flash { color: #ff7a5c; min-height: 1.7em; }
      #sbNet .slots { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 10px 0; }
      #sbNet .slot { background: #120e0d; border: 2px solid #3a302c; padding: 8px 10px; min-height: 76px; }
      #sbNet .slot.mine { border-color: #ffd23f; }
      #sbNet .slot .nm { font-size: 11px; }
      #sbNet .ok { color: #7be08a; }
      #sbNet .warn { color: #ff7a5c; }
      #sbNet .dim { color: #6d5f57; }
      #sbNet .ver { color: #6d5f57; font-size: 9px; margin-top: 10px; }
      @media (max-width: 620px) { #sbNet .slots { grid-template-columns: 1fr; } }`;
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
    const SLOT_COL = ['#f0a818', '#45b6e8', '#5fd068', '#e85ad6'];
    function slotHtml(N, s, i) {
      const isHost = N.role === 'host', mine = i === N.me, teams = N.opts.teams;
      const tag = `<span style="color:${SLOT_COL[i]}">P${i + 1}</span>`;
      if (s.kind === 'empty') {
        return `<div class="slot">${tag} <span class="dim">EMPTY</span><br>
          ${isHost ? `<button data-a="addcpu" data-v="${i}">ADD CPU</button>` : '<span class="dim">waiting for a player...</span>'}</div>`;
      }
      const team = teams ? `<button data-a="team" data-v="${i}" class="${s.team ? 'blue' : 'red'}" ${(mine || (isHost && s.kind === 'cpu')) ? '' : 'disabled'}>${s.team ? 'BLUE' : 'RED'}</button>` : '';
      if (s.kind === 'cpu') {
        return `<div class="slot">${tag} <span class="nm">CPU</span> ${team}<br>
          ${isHost ? `<button data-a="cpuchar" data-v="${i}">${esc(s.char || 'PICK')} ></button><button data-a="cpulv" data-v="${i}">${esc(s.level.slice(3))} ></button><button data-a="remove" data-v="${i}">X</button>`
                   : `${esc(s.char || '...')} <span class="dim">${esc(s.level.slice(3))}</span>`}</div>`;
      }
      const ping = i === 0 ? '' : ` <span class="${s.ping > 150 ? 'warn' : 'ok'}">${s.ping ? s.ping + 'ms' : ''}</span>`;
      const ver = s.build && s.build !== BUILD ? ' <span class="warn">OLD VERSION</span>' : '';
      return `<div class="slot ${mine ? 'mine' : ''}">${tag} <span class="nm">${esc(s.name)}${mine ? ' (YOU)' : ''}</span>${i === 0 ? ' <span class="dim">HOST</span>' : ''}${ping}${ver} ${team}<br>
        ${s.char ? esc(s.char) : '<span class="dim">picking...</span>'} ${s.ready || i === 0 && s.char ? '<span class="ok">READY</span>' : ''}</div>`;
    }
    function render() {
      const N = netplay;
      const fl = flashMsg && performance.now() - flashT < 8000 ? `<p class="flash">${esc(flashMsg)}</p>` : '<p class="flash"></p>';
      const ver = `<div class="ver">VERSION ${esc(APP_VERSION)} · BUILD ${esc(BUILD)}${LOCAL_TEST ? ' · LOCAL TEST MODE' : ''}</div>`;
      let h = '';
      if (view === 'menu' || !N) {
        h = `<h2>ONLINE PLAY</h2>
          <p>Fight up to 3 friends over the internet. One of you hosts and gets a code; the others join with it.</p>
          <div class="row"><span class="lbl">YOUR NAME</span><input id="sbName" maxlength="12" value="${esc(loadName())}"></div>
          <div class="row"><button class="go" data-a="host">HOST A GAME</button></div>
          <div class="row"><span class="lbl">JOIN WITH A CODE</span><input id="sbCode" maxlength="5" placeholder="ABCDE"> <button data-a="join">JOIN</button></div>
          ${fl}<div class="row"><button data-a="close">BACK</button></div>${ver}`;
      } else if (view === 'connecting' || N.me < 0) {
        h = `<h2>JOINING ${esc(N.code)}</h2><p>Connecting...</p>${fl}<div class="row"><button data-a="cancel">CANCEL</button></div>${ver}`;
      } else {
        const isHost = N.role === 'host', me = N.slots[N.me] || {};
        const chars = ROSTER.filter(Boolean).map(c => `<button data-a="char" data-v="${c}" class="${me.char === c ? 'on' : ''}">${c}</button>`).join('');
        const stages = STAGE_LIST.map((s, i) => `<button data-a="stage" data-v="${i}" class="${N.opts.stage === i ? 'on' : ''}" ${isHost ? '' : 'disabled'}>${s.name}</button>`).join('');
        const pads = getPads().map((g, k) => g && g.connected ? 'pad' + k : null).filter(Boolean);
        const devs = ['keyboard', ...pads].map(d => `<button data-a="dev" data-v="${d}" class="${N.dev === d ? 'on' : ''}">${d === 'keyboard' ? 'KEYBOARD' : 'CONTROLLER ' + (+d.slice(3) + 1)}</button>`).join('');
        const ready = N.me === 0 ? '' : `<button data-a="ready" class="${me.ready ? 'on' : ''}" ${me.char ? '' : 'disabled'}>${me.ready ? 'READY!' : 'READY?'}</button>`;
        h = `<h2>ONLINE LOBBY</h2>
          <p>Room <span class="code">${esc(N.code)}</span> ${isHost ? '<button data-a="copy">COPY</button>' : ''}
             ${isHost ? '<br>Send the code to up to 3 friends.' : ` · ping <span class="${N.ping > 150 ? 'warn' : 'ok'}">${N.ping ? N.ping + 'ms' : '...'}</span>`}</p>
          <div class="slots">${N.slots.map((s, i) => slotHtml(N, s, i)).join('')}</div>
          <div class="row"><span class="lbl">YOUR FIGHTER</span>${chars}</div>
          <div class="row"><span class="lbl">STAGE ${isHost ? '' : '(HOST PICKS)'}</span>${stages}</div>
          <div class="row"><span class="lbl">STOCKS / TEAMS ${isHost ? '' : '(HOST PICKS)'}</span>
            <button data-a="stocks" data-v="-1" ${isHost ? '' : 'disabled'}>-</button> ${N.opts.stocks > 0 ? N.opts.stocks : 'FREE PLAY'} <button data-a="stocks" data-v="1" ${isHost ? '' : 'disabled'}>+</button>
            &nbsp; <button data-a="teams" class="${N.opts.teams ? 'on' : ''}" ${isHost ? '' : 'disabled'}>TEAMS ${N.opts.teams ? 'ON' : 'OFF'}</button></div>
          <div class="row"><span class="lbl">YOUR CONTROLS</span>${devs}</div>
          ${fl}
          <div class="row">${ready}
            ${isHost ? `<button class="go" data-a="start" ${canStart() ? '' : 'disabled'}>START MATCH</button>` : '<span class="lbl" style="display:inline">the host starts the match</span>'}
            <button data-a="leave">LEAVE</button></div>
          <p>Online tip: ESC twice leaves a match.</p>${ver}`;
      }
      box.innerHTML = h;
      const nameIn = box.querySelector('#sbName');
      if (nameIn) nameIn.addEventListener('input', () => saveName(nameIn.value.trim().slice(0, 12) || 'PLAYER'));
      const codeIn = box.querySelector('#sbCode');
      if (codeIn) codeIn.addEventListener('keydown', e => { if (e.key === 'Enter') join(codeIn.value); });
    }
    const cycle = (list, v) => list[(list.indexOf(v) + 1) % list.length];
    box.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b || b.disabled) return;
      const a = b.dataset.a, v = b.dataset.v, N = netplay;
      if (a === 'host') host();
      else if (a === 'join') join(box.querySelector('#sbCode').value);
      else if (a === 'close') { open = false; render(); }
      else if (a === 'cancel' || a === 'leave') {
        if (N && N.role === 'guest') toHost({ k: 'leave' });
        leave(false); show('menu');
      }
      else if (a === 'copy') { try { navigator.clipboard.writeText(N.code); flash('Code copied'); } catch (err) {} }
      else if (!N || N.me < 0) return;
      else if (a === 'char') { const S = N.slots[N.me]; S.char = v; if (N.me !== 0) S.ready = false; sendPick(); menuSfx('pick'); render(); }
      else if (a === 'ready') { const S = N.slots[N.me]; S.ready = !S.ready && !!S.char; sendPick(); menuSfx('move'); render(); }
      else if (a === 'team') {
        const i = +v, S = N.slots[i];
        if (i === N.me) { S.team = 1 - S.team; sendPick(); }
        else if (N.role === 'host' && S.kind === 'cpu') { S.team = 1 - S.team; broadcastRoster(); }
        render();
      }
      else if (N.role !== 'host') { if (a === 'dev') { N.dev = v; render(); } return; }
      // ----- host-only controls -----
      else if (a === 'stage') { N.opts.stage = +v; broadcastRoster(); }
      else if (a === 'stocks') { N.opts.stocks = (N.opts.stocks + (+v) + 100) % 100; broadcastRoster(); }
      else if (a === 'teams') { N.opts.teams = !N.opts.teams; broadcastRoster(); }
      else if (a === 'addcpu') { const i = +v; N.slots[i] = { ...emptySlot(i), kind: 'cpu', char: ROSTER.filter(Boolean)[i % ROSTER.filter(Boolean).length] }; broadcastRoster(); }
      else if (a === 'cpuchar') { const S = N.slots[+v]; S.char = cycle(ROSTER.filter(Boolean), S.char); broadcastRoster(); }
      else if (a === 'cpulv') { const S = N.slots[+v]; S.level = cycle(CPU_LEVELS, S.level); broadcastRoster(); }
      else if (a === 'remove') { N.slots[+v] = emptySlot(+v); broadcastRoster(); }
      else if (a === 'dev') { N.dev = v; render(); }
      else if (a === 'start') hostStart();
    });
    return { show, hide, flash, render };
  })();

  // hooks the game calls
  Object.assign(window, { netTick, netAfterFrame, netInputFor, netEscape, netBackToLobby, netDrawOverlay,
                          sbNet: { host, join, leave, BUILD, ui, enc, dec, simHash } });
})();
