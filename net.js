// =====================================================================
//  DOODLE BROTHERS - ONLINE PLAY (up to 4 players, teams, couch players + online friends together)
//
//  Peer-to-peer: one player HOSTS (gets a 5-letter code), friends JOIN with that code. Everyone connects
//  to the host (WebRTC, through PeerJS's free matchmaking server). The online lobby IS the normal character
//  select screen: the 4 player cards are the room's 4 seats. Each computer can bring more than one player
//  (couch players: press A on another controller), friends online fill the other seats, and the host
//  fills any empty seat with a CPU. The host picks stage / stocks / TEAMS.
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
  // one of THIS computer's players: their own device + their own CONTROLS PRESET
  function sampleLocal(p) {
    const binds = profileOf(p.profile);
    if (p.dev && p.dev.startsWith('pad')) return padInput(+p.dev.slice(3), binds);
    return keyboardInput(binds);
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

  // ---------- the room: 4 seats ----------
  // slot = { kind: 'human' | 'cpu' | 'empty', owner (which computer: 0 = host), name, char, team, level, build, ping }
  const emptySlot = i => ({ kind: 'empty', owner: null, name: 'P' + (i + 1), char: null, team: i % 4, level: 'AI NORMAL', build: null, ping: 0 });
  function newState(role) {
    return {
      role, mid: role === 'host' ? 0 : -1, me: role === 'host' ? 0 : -1, inRoom: false,
      peer: null, conn: null, conns: new Map(), nextMid: 1, connected: false, active: false,
      code: '', ping: 0, name: loadName(),
      slots: Array.from({ length: SLOTS }, (_, i) => emptySlot(i)),
      opts: { stage: gameOptions.stage || 0, stocks: gameOptions.stocks || 3, teams: !!gameOptions.teams },
      pendingDevs: [], sent: {}, lastRoster: '',
    };
  }
  function loadName() { try { return (localStorage.getItem('stickman-brawl-name') || 'PLAYER').slice(0, 12); } catch (e) { return 'PLAYER'; } }
  function saveName(n) { try { localStorage.setItem('stickman-brawl-name', n); } catch (e) {} }
  const isMine = (N, s) => s.kind === 'human' && s.owner === N.mid;
  const mySlots = N => N.slots.map((s, i) => isMine(N, s) ? i : -1).filter(i => i >= 0);

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

  // Your own couch setup + options are kept while you're online, and put back when you leave the room
  let saved = null;
  function saveLocalSetup() {
    if (saved) return;
    saved = { turbo, gore, stage: gameOptions.stage, stocks: gameOptions.stocks, teams: gameOptions.teams,
              players: players.map(p => ({ ...p, cur: { ...p.cur } })), showControls };
    if (watchMode) setWatchMode(false);
  }

  // ---------- HOST ----------
  function host() {
    leave(true);
    saveLocalSetup();
    netplay = newState('host');
    const N = netplay;
    N.code = randomCode();
    N.connected = true; N.inRoom = true;                  // (the host is "in" its own room straight away)
    // everyone already sitting at this computer keeps their seat; CPUs stay too (friends who join take a CPU's seat)
    syncFromPlayers();
    ui.show('room');
    let peer;
    try { peer = makePeer(PREFIX + N.code); } catch (e) { return fail('Could not start online play: ' + e.message); }
    N.peer = peer;
    peer.on('open', () => flash('ROOM ' + N.code + ' IS OPEN - CLICK INVITE TO COPY AN INVITE FOR YOUR FRIENDS'));
    peer.on('connection', conn => {
      const slot = freeSeat();
      if (slot < 0 || N.active) {                         // room full (or mid-match)
        conn.on('open', () => { try { conn.send({ k: 'full', why: N.active ? 'busy' : 'full' }); } catch (e) {} setTimeout(() => { try { conn.close(); } catch (e) {} }, 300); });
        return;
      }
      const mid = N.nextMid++;
      N.slots[slot] = { ...emptySlot(slot), kind: 'human', owner: mid, name: 'P' + (slot + 1), team: N.slots[slot].team };   // reserve a seat
      N.conns.set(mid, conn);
      roomChanged();
      // a connection that never finishes opening gives the seat back (the guest will retry on a new one)
      setTimeout(() => {
        if (netplay === N && N.conns.get(mid) === conn && !conn.open && !N.active) machineLeft(mid, true);
      }, 8000);
      conn.on('data', m => hostData(mid, m));
      const gone = () => { if (netplay === N && N.conns.get(mid) === conn) machineLeft(mid); };
      conn.on('close', gone); conn.on('error', gone);
    });
    peer.on('error', err => {
      if (err && err.type === 'unavailable-id') { const keep = saved; saved = null; leave(true); saved = keep; return host(); }   // code taken: new one
      if (err && err.type === 'peer-unavailable') return;                         // (a guest that vanished)
      fail(netError(err));
    });
    N.pinger = setInterval(() => { for (const c of N.conns.values()) if (c.open !== false) try { c.send({ k: 'ping', t: performance.now() }); } catch (e) {} }, 1000);
  }
  // a seat for someone joining: an empty one first, otherwise a CPU's
  function freeSeat() {
    const N = netplay;
    const e = N.slots.findIndex(s => s.kind === 'empty');
    return e >= 0 ? e : N.slots.findIndex(s => s.kind === 'cpu');
  }
  function sendTo(mid, m) { const c = netplay && netplay.conns.get(mid); if (c) { try { c.send(m); } catch (e) {} } }
  function broadcast(m, exceptMid = -1) { const N = netplay; if (!N) return; for (const [mid, c] of N.conns) if (mid !== exceptMid && c.open !== false) { try { c.send(m); } catch (e) {} } }
  function broadcastRoster() {
    const N = netplay;
    N.lastRoster = JSON.stringify([N.slots, N.opts]);
    broadcast({ k: 'roster', slots: N.slots.map(s => ({ ...s })), opts: { ...N.opts } });
  }
  function hostData(mid, m) {
    const N = netplay;
    if (!N || !m || typeof m !== 'object') return;
    const owned = i => N.slots[i] && N.slots[i].kind === 'human' && N.slots[i].owner === mid;
    switch (m.k) {
      case 'hello': {
        const name = String(m.name || '').toUpperCase().slice(0, 12) || 'PLAYER';
        N.slots.forEach((s, i) => { if (owned(i)) { s.name = name; s.build = m.build; } });
        // more players at that computer (couch players): give them seats too, while there are any
        for (let k = 0; k < Math.min(3, m.extra | 0); k++) {
          const i = freeSeat(); if (i < 0) break;
          N.slots[i] = { ...emptySlot(i), kind: 'human', owner: mid, name: 'P' + (i + 1), build: m.build, team: N.slots[i].team };
        }
        sendTo(mid, { k: 'welcome', mid });
        roomChanged(); broadcastRoster(); menuSfx('pick');
        flash(name + ' JOINED THE ROOM');
        break;
      }
      case 'addlocal': {                                  // another controller at that computer wants in
        const i = N.active ? -1 : freeSeat();
        if (i < 0) { sendTo(mid, { k: 'flash', text: 'THE ROOM IS FULL' }); break; }
        const b = N.slots.find((s, k) => owned(k));
        N.slots[i] = { ...emptySlot(i), kind: 'human', owner: mid, name: 'P' + (i + 1), build: b ? b.build : null, team: N.slots[i].team };
        roomChanged(); broadcastRoster(); break;
      }
      case 'droplocal':                                   // a couch player at that computer stepped out
        if (!N.active && owned(m.p) && N.slots.filter((s, k) => owned(k)).length > 1) { N.slots[m.p] = emptySlot(m.p); roomChanged(); broadcastRoster(); }
        break;
      case 'ping': sendTo(mid, { k: 'pong', t: m.t }); break;
      case 'pong': { const ping = Math.round(performance.now() - m.t); N.slots.forEach((s, i) => { if (owned(i)) s.ping = ping; }); break; }
      case 'pick':
        if (N.active || !owned(m.p)) break;
        N.slots[m.p].char = ROSTER.includes(m.char) ? m.char : null;
        if ([0, 1, 2, 3].includes(m.team)) N.slots[m.p].team = m.team;
        roomChanged(); broadcastRoster(); break;
      case 'in': {                                        // a guest's presses: keep them, and pass them on to everyone else
        const ps = {};
        for (const k in m.ps) if (owned(+k)) ps[k] = m.ps[k];
        storeInputs(m.t0, ps);
        broadcast({ k: 'in', t0: m.t0, ps }, mid);
        break;
      }
      case 'hash': if (N.active) checkHash(m.t, m.h); break;
      case 'leave': machineLeft(mid); break;
    }
  }
  // a whole computer left (closed the game / lost the connection): its seats empty out
  function machineLeft(mid, quiet) {
    const N = netplay;
    const c = N.conns.get(mid);
    N.conns.delete(mid);
    if (c) { try { c.close(); } catch (e) {} }
    const theirs = N.slots.map((s, i) => s.kind === 'human' && s.owner === mid ? i : -1).filter(i => i >= 0);
    const name = theirs.length ? N.slots[theirs[0]].name : 'A player';
    for (const i of theirs) N.slots[i] = emptySlot(i);
    if (N.active) {                                       // mid-match: the match is over for everyone
      broadcast({ k: 'abort', why: name + ' left the match.' });
      endMatchBack(name + ' left the match.');
    } else { roomChanged(); broadcastRoster(); if (!quiet) flash(name + ' LEFT THE ROOM'); }
  }

  // ---------- GUEST ----------
  function join(code) {
    // accepts the bare code, or a whole pasted invite ("...CODE: ABCDE")
    const up = String(code || '').toUpperCase();
    const m = up.match(/CODE[^A-Z]*([A-Z]{5})\b/);
    code = m ? m[1] : up.replace(/[^A-Z]/g, '');
    if (code.length !== 5) { flash('Codes are 5 letters'); return; }
    leave(true);
    saveLocalSetup();
    netplay = newState('guest');
    const N = netplay;
    N.code = code;
    // everyone at this computer comes along (couch players), each with their own controller + preset
    N.pendingDevs = players.filter(localHuman).map(p => ({ dev: p.dev, profile: p.profile }));
    if (!N.pendingDevs.length) N.pendingDevs = [{ dev: 'keyboard', profile: 'DEFAULT' }];
    ui.show('connecting');
    let peer;
    try { peer = makePeer(null); } catch (e) { return fail('Could not start online play: ' + e.message); }
    N.peer = peer;
    // Connecting peer-to-peer sometimes needs a second try: if we're not in the room after a few seconds,
    // drop that attempt and try again (5 tries before giving up)
    const attempt = n => {
      if (netplay !== N || N.inRoom) return;
      const conn = peer.connect(PREFIX + code, { reliable: true, serialization: 'json' });
      N.conn = conn;
      const mine = () => netplay === N && N.conn === conn;
      conn.on('open', () => {
        if (!mine()) return;
        N.connected = true;
        conn.send({ k: 'hello', build: BUILD, version: APP_VERSION, name: N.name, extra: N.pendingDevs.length - 1 });
        if (N.pinger) clearInterval(N.pinger);
        N.pinger = setInterval(() => { try { conn.send({ k: 'ping', t: performance.now() }); } catch (e) {} }, 1000);
      });
      conn.on('data', m => { if (mine()) guestData(m); });
      conn.on('close', () => { if (mine() && N.inRoom) dropped('The host closed the room.'); });
      conn.on('error', () => { if (mine() && N.inRoom) dropped('Lost the connection to the host.'); });
      setTimeout(() => {
        if (!mine() || N.inRoom) return;
        try { conn.close(); } catch (e) {}
        N.connected = false;
        if (n < 5) { flash('Still connecting... (try ' + (n + 1) + ' of 5)'); attempt(n + 1); }
        else fail('Could not reach that room. Check the code, and that your friend is still hosting.');
      }, 6000);
    };
    peer.on('open', () => attempt(1));
    peer.on('error', err => fail(netError(err)));
  }
  function toHost(m) { const N = netplay; if (N && N.conn && N.connected) { try { N.conn.send(m); } catch (e) {} } }
  function guestData(m) {
    const N = netplay;
    if (!N || !m || typeof m !== 'object') return;
    switch (m.k) {
      case 'welcome': N.mid = m.mid; N.inRoom = true; ui.show('room'); menuSfx('pick'); flash('YOU JOINED ROOM ' + N.code + ' - PICK YOUR FIGHTER'); break;
      case 'full': fail(m.why === 'busy' ? 'That room is in the middle of a match - try again in a minute.' : 'That room is full (4 players).'); break;
      case 'roster': N.slots = m.slots; N.opts = m.opts; if (N.inRoom && !N.active) roomChanged(); break;
      case 'flash': flash(m.text); break;
      case 'ping': toHost({ k: 'pong', t: m.t }); break;
      case 'pong': N.ping = Math.round(performance.now() - m.t); break;
      case 'start': beginMatch(m); break;
      case 'in': storeInputs(m.t0, m.ps); break;
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

  // ---------- keeping the select screen and the room in step ----------
  // room -> the select screen's 4 player cards
  function roomChanged() {
    const N = netplay;
    if (!N) return;
    const fresh = [];
    N.slots.forEach((s, i) => {
      const p = players[i];
      if (isMine(N, s)) {
        if (N.role === 'host') return;                    // (the host's own seats are driven by its select screen)
        if (!p.mineSeat) {                                 // a seat that just became ours: hand it a controller
          fresh.push(i);
          Object.assign(p, { mineSeat: true, remote: false, off: false, cpu: false, char: s.char, team: s.team, carry: i,
                             cur: { x: cardRect(i).x + cardRect(i).w / 2, y: 300 } });
        }
        p.name = s.name;
        return;
      }
      p.mineSeat = false;
      if (s.kind === 'human') {
        Object.assign(p, { remote: true, cpu: false, off: false, dev: null, char: s.char, team: s.team, name: s.name, carry: i });
      } else if (N.role === 'host') {
        if (p.remote) Object.assign(p, { remote: false, cpu: true, off: s.kind === 'empty', dev: null, char: s.char, name: 'P' + (i + 1), carry: i });
      } else {
        Object.assign(p, { remote: false, cpu: true, off: s.kind === 'empty', dev: null, char: s.char, team: s.team, level: s.level,
                           name: s.kind === 'cpu' ? 'CPU' : 'P' + (i + 1), carry: i });
      }
    });
    for (const i of fresh) {                                // our new seats get the controllers waiting for them
      const d = N.pendingDevs.shift() || { dev: players.some(q => q.dev === 'keyboard' && localHuman(q)) ? null : 'keyboard', profile: 'DEFAULT' };
      players[i].dev = d.dev; players[i].profile = d.profile || 'DEFAULT';
      if (!d.dev) players[i].off = true;                    // (nothing left to play it with)
    }
    N.me = mySlots(N)[0] !== undefined ? mySlots(N)[0] : N.me;
    if (N.role === 'guest') { gameOptions.stage = N.opts.stage; gameOptions.stocks = N.opts.stocks; gameOptions.teams = !!N.opts.teams; }
  }
  // the select screen -> the room (run every frame on the select screen while in a room)
  function syncFromPlayers() {
    const N = netplay;
    if (!N || !N.inRoom || N.active) return;
    if (N.role === 'host') {
      let firstLocal = true;
      players.forEach((p, i) => {
        const s = N.slots[i];
        if (s.kind === 'human' && s.owner !== 0) return;  // a guest's seat: theirs to change
        if (p.off) { if (s.kind !== 'empty') N.slots[i] = emptySlot(i); N.slots[i].team = p.team || 0; return; }
        if (p.cpu) { N.slots[i] = { ...emptySlot(i), kind: 'cpu', name: 'CPU', char: p.char, team: p.team || 0, level: p.level }; return; }
        const name = firstLocal ? N.name : 'P' + (i + 1);
        firstLocal = false;
        p.name = name;
        N.slots[i] = { ...emptySlot(i), kind: 'human', owner: 0, name, char: p.char, team: p.team || 0, build: BUILD };
      });
      N.opts = { stage: gameOptions.stage || 0, stocks: gameOptions.stocks, teams: !!gameOptions.teams };
      if (JSON.stringify([N.slots, N.opts]) !== N.lastRoster) broadcastRoster();
    } else {
      for (const i of mySlots(N)) {
        const p = players[i];
        if (p.off) { if (!N.sent[i] || !N.sent[i].drop) { N.sent[i] = { drop: true }; toHost({ k: 'droplocal', p: i }); } continue; }
        const want = { char: p.char || null, team: p.team || 0 };
        const was = N.sent[i];
        if (!was || was.char !== want.char || was.team !== want.team) { N.sent[i] = want; toHost({ k: 'pick', p: i, ...want }); }
      }
    }
  }
  // a new controller pressed A on a guest's computer: ask the host for another seat
  function addLocal(dev) {
    const N = netplay;
    if (!N || N.role !== 'guest' || !N.inRoom) return;
    if (N.pendingDevs.some(d => d.dev === dev)) return;
    N.pendingDevs.push({ dev, profile: 'DEFAULT' });
    toHost({ k: 'addlocal' });
    flash((dev === 'keyboard' ? 'KEYBOARD' : 'CONTROLLER ' + (+dev.slice(3) + 1)) + ' IS JOINING THE ROOM...');
  }
  function invite() {
    const N = netplay;
    if (!N) return;
    const msg = 'Come fight me in Doodle Brothers! Open the game, click ONLINE, then JOIN with CODE: ' + N.code;
    try { navigator.clipboard.writeText(msg); flash('INVITE COPIED - PASTE IT TO YOUR FRIENDS (ROOM CODE ' + N.code + ')'); }
    catch (e) { flash('ROOM CODE: ' + N.code + ' - SEND IT TO YOUR FRIENDS'); }
    menuSfx('pick');
  }
  function leaveRoom() {
    const N = netplay;
    if (!N) return;
    if (N.role === 'guest') toHost({ k: 'leave' });
    leave(false);
    flash('YOU LEFT THE ONLINE ROOM');
    menuSfx('back');
  }

  // ---------- the match ----------
  function versionProblem() { const N = netplay; return N.slots.find(s => s.kind === 'human' && s.build && s.build !== BUILD); }
  function hostStart() {
    const N = netplay;
    if (!N || N.role !== 'host' || N.active) return;
    syncFromPlayers();
    if (!allReady()) return;
    const bad = versionProblem();
    if (bad) { flash(bad.name + ' HAS A DIFFERENT VERSION OF THE GAME - EVERYONE UPDATE FIRST'); return; }
    // input delay: a guest's presses go guest -> host -> other guests, so allow for the worst round trip
    const worst = Math.max(80, ...N.slots.filter(s => s.kind === 'human').map(s => s.ping || 0));
    const relay = N.conns.size > 1 ? worst : worst / 2;
    const delay = clamp(Math.ceil((relay + 25) / (STEP * 1000)), 4, 36);
    const m = { k: 'start', seed: (realRandom() * 2 ** 32) >>> 0, slots: N.slots.map(s => ({ ...s })), opts: { ...N.opts }, gore, delay };
    broadcast(m);
    beginMatch(m);
  }
  function beginMatch(m) {
    const N = netplay;
    N.slots = m.slots; N.opts = m.opts;
    N.humans = m.slots.map((s, i) => s.kind === 'human' ? i : -1).filter(i => i >= 0);
    N.mine = mySlots(N);
    // rebuild every fighter from scratch, so nothing left over from earlier games can differ
    fighterPool.forEach((f, i) => {
      for (const k of Object.keys(f)) delete f[k];
      Object.assign(f, makeFighter(FIGHTER_INIT[i])); f.slot = i;
    });
    m.slots.forEach((s, i) => {
      const p = players[i];
      p.off = s.kind === 'empty'; p.char = s.char; p.team = s.team;
      p.cpu = s.kind === 'cpu'; p.level = s.level || 'AI NORMAL';
      if (!N.mine.includes(i)) p.dev = s.kind === 'human' ? 'net' : null;   // (our own players keep their controllers)
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
      inputs, carry, sentUpTo: m.delay - 1, outbox: {}, outStart: null,
      cur: null, hashes: new Map(), theirHashes: new Map(), desynced: false,
      stalledSince: 0, escAt: 0, waitingOn: null,
    });
    ui.hide();
  }
  function storeInputs(t0, ps) {
    const N = netplay;
    if (!N || !N.inputs || !ps) return;
    for (const k in ps) {
      const map = N.inputs[k];
      if (!map) continue;
      ps[k].forEach((e, i) => { const t = t0 + i; if (t >= N.tick) map.set(t, dec(e)); });
    }
  }
  // One game step online. Returns false (and the game waits) if someone's inputs aren't here yet.
  function netTick() {
    const N = netplay, t = N.tick;
    while (N.sentUpTo < t + N.delay) {                 // record + send our players' inputs for a step a little in the future
      const ti = ++N.sentUpTo;
      if (N.outStart === null) N.outStart = ti;
      for (const i of N.mine) {
        const e = enc(sampleLocal(players[i]));
        N.inputs[i].set(ti, dec(e));                   // (decoded, exactly like everyone else will see it)
        (N.outbox[i] || (N.outbox[i] = [])).push(e);
      }
      for (const k in pressed) delete pressed[k];
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
    if (N.outStart !== null) {
      const m = { k: 'in', t0: N.outStart, ps: N.outbox };
      if (N.role === 'host') broadcast(m); else toHost(m);
      N.outbox = {}; N.outStart = null;
    }
    if (N.stalledSince && performance.now() - N.stalledSince > STALL_DROP * 1000) {
      const s = N.slots[N.waitingOn], who = s ? s.name : 'a player';
      if (N.role === 'host') { if (s && s.owner) machineLeft(s.owner); }
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
      if (N.role === 'host') { broadcast({ k: 'abort', why: 'The host stopped the match.' }); endMatchBack('You stopped the match'); }
      else { toHost({ k: 'leave' }); leave(false); backToSelect(); flash('You left the match'); }
      return;
    }
    N.escAt = now;
  }
  // after the results screen (or a stopped match): everyone goes back to the room's character select
  function netBackToLobby() {
    const N = netplay;
    if (!N) return;
    N.active = false;
    if (!N.connected) { leave(false); return; }
    N.sent = {};
    afterMatch();
  }
  function afterMatch() {
    const N = netplay;
    for (const p of players) p.mineSeat = false;           // re-hand our seats their controllers below
    const devs = (N.mine || []).map(i => ({ dev: players[i].dev, profile: players[i].profile }));
    N.pendingDevs = devs.concat(N.pendingDevs);
    roomChanged();
    if (N.role === 'host') { N.lastRoster = ''; syncFromPlayers(); }
  }
  function endMatchBack(why) {
    const N = netplay;
    if (N && N.active) { N.active = false; backToSelect(); }
    if (N) afterMatch();
    flash(why);
  }
  // Lost the room
  function dropped(why) {
    const wasActive = netplay && netplay.active;
    leave(false);
    if (wasActive) backToSelect();
    flash(why);
  }
  function fail(why) { leave(false); ui.show('menu'); flash(why); }
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
    if (saved && !quiet) {
      turbo = saved.turbo; gore = saved.gore; gameOptions.stage = saved.stage; gameOptions.stocks = saved.stocks; gameOptions.teams = saved.teams;
      saved.players.forEach((p, i) => Object.assign(players[i], p, { char: null, remote: false, mineSeat: false }));
      showControls = saved.showControls;
      saved = null;
      for (const f of fighterPool) if (f.controller === 'net') f.controller = 'dummy';
    }
    if (!quiet) ui.render();
  }
  // messages: on the select screen (or in the ONLINE window while it's open)
  function flash(msg) { if (ui.isOpen()) ui.flash(msg); else selMsg = { text: String(msg).toUpperCase(), t: 4 }; }

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
  //  The ONLINE window (plain HTML over the game): HOST / JOIN. Once you're in a room, the room
  //  itself is the normal character select screen.
  // =====================================================================
  const ui = (() => {
    const css = `
      #sbNetBtn { position: fixed; left: 12px; top: 12px; z-index: 20; font: 12px "Press Start 2P", monospace; color: #1a1408;
        background: #ffd23f; border: 3px solid #1a1408; padding: 9px 12px; cursor: pointer; box-shadow: 3px 3px 0 #1a1408; }
      #sbNetBtn:hover { background: #ffe27a; }
      #sbNet { position: fixed; inset: 0; z-index: 30; display: none; align-items: center; justify-content: center;
        background: rgba(8,6,6,0.72); font: 11px/1.7 "Press Start 2P", monospace; color: #f3ece4; }
      #sbNet .box { background: #1d1716; border: 3px solid #ffd23f; padding: 18px 20px; width: min(640px, calc(100vw - 32px));
        max-height: calc(100vh - 32px); overflow: auto; box-shadow: 6px 6px 0 #000; }
      #sbNet h2 { margin: 0 0 10px; font-size: 16px; color: #ffd23f; }
      #sbNet p { margin: 8px 0; color: #cbbfb1; }
      #sbNet button { font: 10px "Press Start 2P", monospace; padding: 8px 10px; margin: 3px 5px 3px 0; cursor: pointer;
        background: #3a302c; color: #f3ece4; border: 2px solid #6d5f57; }
      #sbNet button:hover:not(:disabled) { border-color: #ffd23f; }
      #sbNet button.go { background: #d63a2a; border-color: #ff7a5c; color: #fff; }
      #sbNet button:disabled { opacity: 0.4; cursor: default; }
      #sbNet input { font: 14px "Press Start 2P", monospace; padding: 8px; width: 9em; text-transform: uppercase;
        background: #0e0b0b; color: #ffd23f; border: 2px solid #6d5f57; }
      #sbNet .row { margin: 10px 0; }
      #sbNet .lbl { color: #8f8278; display: block; margin-bottom: 4px; }
      #sbNet .flash { color: #ff7a5c; min-height: 1.7em; }
      #sbNet .ver { color: #6d5f57; font-size: 9px; margin-top: 10px; }`;
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
    btn.addEventListener('click', () => show(netplay && !netplay.inRoom ? 'connecting' : 'menu'));

    let view = 'menu', open = false, flashMsg = '', flashT = 0;
    function show(v) {
      view = v;
      if (v === 'room') { open = false; if (scene !== 'fight' && scene !== 'controls') scene = 'select'; }   // the room = the select screen
      else open = true;
      render();
    }
    function hide() { open = false; render(); }
    function flash(msg) { flashMsg = msg; flashT = performance.now(); render(); }
    // the ONLINE button: only on the character select screen, and not while you're in a room
    (function tick() {
      btn.style.display = scene === 'select' && !open && !(netplay && netplay.inRoom) ? 'block' : 'none';
      window.sbNetOpen = open && scene !== 'fight';
      wrap.style.display = open && scene !== 'fight' ? 'flex' : 'none';
      // in a room: keep the room and the select screen in step
      if (netplay && netplay.inRoom && !netplay.active && scene !== 'fight') syncFromPlayers();
      requestAnimationFrame(tick);
    })();

    const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    function render() {
      const N = netplay;
      const fl = flashMsg && performance.now() - flashT < 8000 ? `<p class="flash">${esc(flashMsg)}</p>` : '<p class="flash"></p>';
      const ver = `<div class="ver">VERSION ${esc(APP_VERSION)} · BUILD ${esc(BUILD)}${LOCAL_TEST ? ' · LOCAL TEST MODE' : ''}</div>`;
      let h = '';
      if (N && !N.inRoom) {
        h = `<h2>JOINING ${esc(N.code)}</h2><p>Connecting...</p>${fl}<div class="row"><button data-a="cancel">CANCEL</button></div>${ver}`;
      } else {
        const couch = players.filter(localHuman).length;
        h = `<h2>ONLINE PLAY</h2>
          <p>Fight friends over the internet - up to 4 players. Host a room and send the invite, or join a friend's room with their code.</p>
          <p>Couch players come too: ${couch > 1 ? `the <b style="color:#ffd23f">${couch} players</b> on this computer` : 'anyone on this computer'} can join the room (press A on another controller once you're in).</p>
          <div class="row"><span class="lbl">YOUR NAME</span><input id="sbName" maxlength="12" value="${esc(loadName())}"></div>
          <div class="row"><button class="go" data-a="host">HOST A ROOM</button></div>
          <div class="row"><span class="lbl">JOIN WITH A CODE (OR PASTE AN INVITE)</span><input id="sbCode" maxlength="200" placeholder="ABCDE"> <button data-a="join">JOIN</button></div>
          ${fl}<div class="row"><button data-a="close">BACK</button></div>${ver}`;
      }
      box.innerHTML = h;
      const nameIn = box.querySelector('#sbName');
      if (nameIn) nameIn.addEventListener('input', () => saveName(nameIn.value.trim().toUpperCase().slice(0, 12) || 'PLAYER'));
      const codeIn = box.querySelector('#sbCode');
      if (codeIn) codeIn.addEventListener('keydown', e => { if (e.key === 'Enter') join(codeIn.value); });
    }
    box.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b || b.disabled) return;
      const a = b.dataset.a, N = netplay;
      if (a === 'host') host();
      else if (a === 'join') join(box.querySelector('#sbCode').value);
      else if (a === 'close') { open = false; render(); }
      else if (a === 'cancel') { if (N && N.role === 'guest') toHost({ k: 'leave' }); leave(false); show('menu'); }
    });
    return { show, hide, flash, render, isOpen: () => open };
  })();

  // hooks the game calls
  Object.assign(window, { netTick, netAfterFrame, netInputFor, netEscape, netBackToLobby, netDrawOverlay,
                          sbNet: { host, join, leave, leaveRoom, invite, addLocal, hostStart, BUILD, ui, enc, dec, simHash } });
})();
