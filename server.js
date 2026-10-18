'use strict';

/*
 *  МОРСКОЙ БОЙ — сервер
 *  Запуск:  npm install && npm start
 *  Игра:    http://localhost:3000
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, 'public');
const SAVE_FILE = path.join(__dirname, 'rooms.json');

const IDLE_TURN_MS = 120000;       // авто-конец хода
const IDLE_PLACE_MS = 600000;      // авто-конец расстановки
const DISCONNECT_GRACE_MS = 60000; // ждём вернувшегося игрока
const ROOM_TTL_MS = 6 * 3600e3;    // жизнь пустой комнаты

// ---------------------------------------------------------------- корабли
const SHIP_DEFS = [
  { cls: 'deck4', name: 'Линкор',  deck: 4, count: 1 },
  { cls: 'deck3', name: 'Крейсер', deck: 3, count: 2 },
  { cls: 'deck2', name: 'Эсминец', deck: 2, count: 3 },
  { cls: 'deck1', name: 'Катер',   deck: 1, count: 4 }
];
const SHIP_TYPES = [];
SHIP_DEFS.forEach(d => {
  for (let i = 0; i < d.count; i++) SHIP_TYPES.push({ type: d.cls, len: d.deck, name: d.name });
});
const TOTAL_SHIPS = SHIP_TYPES.length;

const roomCodes = new Set();
const rooms = new Map();
const NAME_BY_TYPE = { deck4: 'Линкор', deck3: 'Крейсер', deck2: 'Эсминец', deck1: 'Катер' };

// ---------------------------------------------------------------- утилиты
const key = (r, c) => r * 10 + c;
function rndCode() {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 5; i++) s += A[Math.floor(Math.random() * A.length)];
  return roomCodes.has(s) ? rndCode() : s;
}
const clampName = v => String(v || '').trim().slice(0, 16) || 'Игрок';

// ---------------------------------------------------------------- расстановка
function parseShips(raw) {
  if (!Array.isArray(raw) || raw.length !== TOTAL_SHIPS) return null;
  const out = [];
  for (const s of raw) {
    if (!s || typeof s !== 'object') return null;
    const len = Number(s.len), row = Number(s.row), col = Number(s.col);
    const type = String(s.type || ''), dir = s.dir;
    if (!Number.isInteger(len) || len < 1 || len > 4) return null;
    if (!Number.isInteger(row) || row < 0 || row > 9) return null;
    if (!Number.isInteger(col) || col < 0 || col > 9) return null;
    if (dir !== 'h' && dir !== 'v') return null;
    if (!/^(deck1|deck2|deck3|deck4)$/.test(type)) return null;
    const cells = [];
    for (let i = 0; i < len; i++) {
      const r = row + (dir === 'h' ? 0 : i);
      const c = col + (dir === 'h' ? i : 0);
      if (r > 9 || c > 9) return null;
      cells.push(key(r, c));
    }
    out.push({ type, name: NAME_BY_TYPE[type] || 'Корабль', len, row, col, dir, cells, hits: new Array(len).fill(false) });
  }
  return out;
}

function validFleet(ships) {
  if (!ships || ships.length !== TOTAL_SHIPS) return { ok: false, msg: 'Нужно расставить все корабли' };

  const wanted = {};
  SHIP_DEFS.forEach(d => wanted[d.cls] = d.count);
  for (const s of ships) wanted[s.type] = (wanted[s.type] || 0) - 1;
  for (const k in wanted) if (wanted[k] !== 0) return { ok: false, msg: 'Неверный состав флота' };

  const occ = new Map(); // клетка -> индекс корабля
  for (let si = 0; si < ships.length; si++) {
    for (const cell of ships[si].cells) {
      if (occ.has(cell)) return { ok: false, msg: 'Корабли не должны пересекаться' };
      occ.set(cell, si);
    }
  }
  for (let si = 0; si < ships.length; si++) {
    for (const cell of ships[si].cells) {
      const r = Math.floor(cell / 10), c = cell % 10;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr, cc = c + dc;
          if (rr < 0 || rr > 9 || cc < 0 || cc > 9) continue;
          const other = occ.get(key(rr, cc));
          if (other !== undefined && other !== si) return { ok: false, msg: 'Корабли не должны соприкасаться' };
        }
      }
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------- вид поля
function boardView(player, enemy) {
  const grid = [];
  for (let r = 0; r < 10; r++) {
    const row = [];
    for (let c = 0; c < 10; c++) row.push({ ship: false, hit: false, sunk: false, miss: false });
    grid.push(row);
  }
  const remaining = [], destroyed = [];
  for (const s of enemy.ships) {
    const sunk = s.hits.every(Boolean);
    if (sunk) destroyed.push(s.type); else remaining.push({ type: s.type });
    for (let i = 0; i < s.len; i++) {
      const r = s.dir === 'h' ? s.row : s.row + i;
      const c = s.dir === 'h' ? s.col + i : s.col;
      const cell = grid[r][c];
      // живые корабли соперника клиенту не рассказываем — иначе легко «подсмотреть»
      cell.ship = sunk;
      cell.sunk = sunk;
      cell.hit = s.hits[i];
    }
  }
  for (const [cell, v] of player.shots) {
    const g = grid[Math.floor(cell / 10)][cell % 10];
    if (v === 'hit') g.hit = true;
    else { if (!g.ship) g.miss = true; else g.miss = true; }
  }
  return { grid, remaining, destroyed };
}

function ownView(player) {
  const grid = [];
  for (let r = 0; r < 10; r++) {
    const row = [];
    for (let c = 0; c < 10; c++) {
      const k = key(r, c);
      row.push({ ship: false, hit: false, sunk: false, miss: player.incoming.get(k) === 'miss' });
    }
    grid.push(row);
  }
  const ships = [];
  for (const s of player.ships) {
    const sunk = s.hits.length > 0 && s.hits.every(Boolean);
    ships.push({ type: s.type, row: s.row, col: s.col, dir: s.dir, len: s.len, sunk });
    for (let i = 0; i < s.len; i++) {
      const r = s.dir === 'h' ? s.row : s.row + i;
      const c = s.dir === 'h' ? s.col + i : s.col;
      grid[r][c] = { ship: true, hit: s.hits[i], sunk, miss: false };
    }
  }
  return { grid, ships };
}

function makePlayer(id, name) {
  return {
    id, name, nick: name, ships: [], shots: new Map(), incoming: new Map(),
    placed: false, online: false, ws: null, deadTimer: null
  };
}

function createRoom() {
  for (let i = 0; i < 50; i++) {
    const code = rndCode();
    if (rooms.has(code)) continue;
    roomCodes.add(code);
    const room = {
      code, players: [null, null], phase: 'wait', turn: 0,
      deadline: Date.now() + IDLE_PLACE_MS, log: [], chat: [],
      want: [false, false], createdAt: Date.now(), deadTimer: null
    };
    rooms.set(code, room);
    return room;
  }
  return null;
}

function send(p, obj) {
  if (p && p.ws && p.ws.readyState === 1) {
    try { p.ws.send(JSON.stringify(obj)); } catch (e) {}
  }
}
const errTo = (ws, msg) => { try { ws.send(JSON.stringify({ t: 'error', msg })); } catch (e) {} };

function stateFor(room, idx) {
  const me = room.players[idx];
  if (!me) return null;
  const foe = room.players[1 - idx];
  const own = ownView(me);
  const st = {
    t: 'state',
    room: room.code,
    phase: room.phase,
    meIdx: idx,
    you: { name: me.name, placed: me.placed, online: me.online },
    foe: foe ? { name: foe.name, placed: foe.placed, online: foe.online } : null,
    turn: room.turn,
    winner: room.winner === undefined ? null : room.winner,
    want: room.want || [false, false],
    idleLeft: Math.max(0, room.deadline - Date.now()),
    log: room.log.slice(-30),
    chat: room.chat.slice(-40),
    id: me.id
  };
  if (room.phase === 'wait') return st;
  st.myBoard = own.grid;
  st.myShips = own.ships;
  if (room.phase === 'playing' || room.phase === 'ended') {
    st.enemyBoard = foe ? boardView(me, foe) : { grid: [], remaining: [], destroyed: [] };
    st.myScore = me.shots.size;
    st.foeScore = foe ? foe.shots.size : 0;
  }
  return st;
}

function addLog(room, text, kind) {
  room.log.push({ text, kind: kind || 'info' });
  if (room.log.length > 60) room.log.splice(0, room.log.length - 60);
}

function broadcast(room) {
  room.players.forEach((p, i) => { if (p) send(p, stateFor(room, i)); });
}

function restorePlayer(p, data) {
  if (!data) return;
  p.ships = (data.ships || []).map(s => ({
    type: s.type, name: NAME_BY_TYPE[s.type] || 'Корабль',
    len: s.len, row: s.row, col: s.col, dir: s.dir, cells: [],
    hits: new Array(s.len).fill(false)
  }));
  for (const s of p.ships) {
    for (let i = 0; i < s.len; i++) {
      s.cells.push(key(s.dir === 'h' ? s.row : s.row + i, s.dir === 'h' ? s.col + i : s.col));
    }
  }
  p.placed = p.ships.length === TOTAL_SHIPS;
  p.shots = new Map(data.shots || []);
  for (const s of p.ships) s.cells.forEach((cell, i) => { if (p.shots.get(cell) === 'hit') s.hits[i] = true; });
}

// ---------------------------------------------------------------- игровая логика
function startGame(room) {
  room.phase = 'playing';
  room.turn = Math.random() < 0.5 ? 0 : 1;
  room.deadline = Date.now() + IDLE_TURN_MS;
  room.want = [false, false];
  addLog(room, '⚔ Бой начался! Первый выстрел: ' + room.players[room.turn].name, 'start');
  broadcast(room);
}

function fire(room, idx, row, col) {
  if (room.phase !== 'playing') return 'Ещё не время стрелять';
  if (room.turn !== idx) return 'Сейчас не ваш ход';
  if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || row > 9 || col < 0 || col > 9) return 'Плохая цель';
  const me = room.players[idx], foe = room.players[1 - idx];
  if (!me || !foe) return 'Соперник не в сети';
  const cell = key(row, col);
  if (me.shots.has(cell)) return 'В эту клетку уже стреляли';
  const shot = String.fromCharCode(65 + col) + (row + 1);

  const ship = foe.ships.find(s => s.cells.includes(cell));
  if (!ship) {
    me.shots.set(cell, 'miss');
    foe.incoming.set(cell, 'miss');
    addLog(room, '🌊 ' + me.name + ' — мимо (' + shot + ')', 'miss');
    room.turn = 1 - idx;
  } else {
    const i = ship.cells.indexOf(cell);
    ship.hits[i] = true;
    me.shots.set(cell, 'hit');
    foe.incoming.set(cell, 'hit');
    const sunk = ship.hits.every(Boolean);
    if (sunk) {
      // вода вокруг потопленного: ровно соседние клетки (не захватываем чужие палубы)
      const rMax = Math.min(9, ship.row + (ship.dir === 'v' ? ship.len : 1));
      const cMax = Math.min(9, ship.col + (ship.dir === 'h' ? ship.len : 1));
      for (let r2 = Math.max(0, ship.row - 1); r2 <= rMax; r2++) {
        for (let c2 = Math.max(0, ship.col - 1); c2 <= cMax; c2++) {
          const kk = key(r2, c2);
          if (me.shots.has(kk)) continue;                       // уже отметка
          if (foe.ships.some(s => s.cells.includes(kk))) continue; // это чужая палуба — не бывает, но бережёмся
          me.shots.set(kk, 'miss'); foe.incoming.set(kk, 'miss');
        }
      }
      addLog(room, '🔥 ' + me.name + ' — ПОТОПИЛ ' + ship.name.toLowerCase() + ' (' + shot + ')!', 'sunk');
      if (foe.ships.length && foe.ships.every(s2 => s2.hits.every(Boolean))) {
        room.phase = 'ended';
        room.winner = idx;
        addLog(room, '🏆 ' + me.name + ' победил! Весь флот противника на дне.', 'win');
      }
    } else {
      addLog(room, '💥 ' + me.name + ' — попал (' + shot + ')! Стреляйте ещё.', 'hit');
    }
  }
  room.deadline = Date.now() + IDLE_TURN_MS;
  return null;
}

function tryEnd(room, reason) {
  if (room.phase === 'ended') return;
  const loser = room.turn;
  if (!room.players[0] || !room.players[1]) return;
  const winner = 1 - loser;
  room.phase = 'ended';
  room.winner = winner;
  addLog(room, '⏳ ' + room.players[loser].name + ' ' + reason + '. Победа: ' + room.players[winner].name, 'win');
  broadcast(room);
}

function detach(room, idx, ws) {
  const p = room && room.players[idx];
  if (!p || p.ws !== ws) return;
  p.online = false;
  p.ws = null;
  addLog(room, p.name + ' отключился, ждём возврата…', 'warn');
  broadcast(room);
  if (p.deadTimer) clearTimeout(p.deadTimer);
  p.deadTimer = setTimeout(() => {
    if (p.online) return;
    const foe = room.players[1 - idx];
    if (foe && room.phase !== 'wait') {
      room.phase = 'ended';
      room.winner = 1 - idx;
      addLog(room, '🔌 ' + p.name + ' не вернулся. Победа: ' + foe.name, 'win');
    }
    room.players[idx] = null;
    if (!room.players[0] && !room.players[1]) {
      if (room.deadTimer) clearTimeout(room.deadTimer);
      room.deadTimer = setTimeout(() => { rooms.delete(room.code); roomCodes.delete(room.code); }, ROOM_TTL_MS);
    } else broadcast(room);
  }, DISCONNECT_GRACE_MS);
}

// ---------------------------------------------------------------- сеть
function attach(ws) {
  let room = null, idx = -1;

  const joinAs = (targetRoom, slot, player) => {
    room = targetRoom; idx = slot;
    if (player.deadTimer) { clearTimeout(player.deadTimer); player.deadTimer = null; }
    player.online = true; player.ws = ws;
    room.players[slot] = player;

    if (room.phase === 'wait' && room.players[0] && room.players[1]) {
      room.phase = 'place';
      room.deadline = Date.now() + IDLE_PLACE_MS;
      addLog(room, '👥 Оба игрока в комнате — расставляйте флот!', 'start');
    }
    if (room.phase === 'place' && room.players[0] && room.players[1] &&
        room.players[0].placed && room.players[1].placed) {
      startGame(room);
      return;
    }
    broadcast(room);
  };

  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    try { handleMessage(m, ws); } catch (e) {
      console.error('Ошибка обработки сообщения:', e.message);
      errTo(ws, 'Внутренняя ошибка сервера, попробуйте ещё раз');
    }
  });

  function handleMessage(m, ws) {

    if (m.t === 'create') {
      if (room) detach(room, idx, ws);
      const r = createRoom();
      if (!r) { errTo(ws, 'Сервер перегружен, попробуйте чуть позже'); return; }
      const p = makePlayer(String(m.id || '') || ('p' + Math.random().toString(36).slice(2)), clampName(m.name));
      addLog(r, p.name + ' создал комнату. Ждём второго игрока…');
      joinAs(r, 0, p);
      return;
    }

    if (m.t === 'join') {
      const code = String(m.code || '').trim().toUpperCase();
      const r = rooms.get(code);
      if (!r) { errTo(ws, 'Комната не найдена. Проверьте код.'); return; }
      const wantId = String(m.id || '');
      let slot = -1, existing = null;
      if (r.players[0] && r.players[0].id === wantId) { slot = 0; existing = r.players[0]; }
      else if (r.players[1] && r.players[1].id === wantId) { slot = 1; existing = r.players[1]; }
      else if (!r.players[0]) slot = 0;
      else if (!r.players[1]) slot = 1;
      if (slot < 0) { errTo(ws, 'В комнате уже двое игроков'); return; }

      if (room && room !== r) detach(room, idx, ws);
      else if (room === r && idx !== slot && room.players[idx] === existing) room.players[idx] = null;

      if (existing) {
        existing.name = clampName(m.name) === 'Игрок' ? existing.name : clampName(m.name);
        joinAs(r, slot, existing);
      } else {
        const p = makePlayer(wantId || ('p' + Math.random().toString(36).slice(2)), clampName(m.name));
        addLog(r, p.name + ' вошёл в игру. Можно начинать!');
        joinAs(r, slot, p);
      }
      return;
    }

    if (m.t === 'place') {
      if (!room || idx < 0 || room.phase !== 'place') return;
      const ships = parseShips(m.ships);
      const v = ships && validFleet(ships);
      if (!v.ok) { errTo(ws, v.msg); return; }
      const p = room.players[idx];
      p.ships = ships; p.placed = true;
      if (room.players[1 - idx]) {
        if (room.players.every(q => q && q.placed)) { startGame(room); return; }
        addLog(room, p.name + ' расставил флот ✔');
      }
      broadcast(room);
      return;
    }

    if (m.t === 'fire') {
      if (!room || idx < 0) return;
      const e = fire(room, idx, m.row, m.col);
      if (e) errTo(ws, e); else broadcast(room);
      return;
    }

    if (m.t === 'chat') {
      if (!room || idx < 0) return;
      const text = String(m.text || '').trim().slice(0, 200);
      if (!text) return;
      room.chat.push({ from: room.players[idx].name, text, ts: Date.now() });
      if (room.chat.length > 100) room.chat.splice(0, room.chat.length - 100);
      broadcast(room);
      return;
    }

    if (m.t === 'rematch') {
      if (!room || room.phase !== 'ended' || !room.players[0] || !room.players[1]) return;
      room.want[idx] = true;
      const a = room.players[0], b = room.players[1];
      if (room.want[0] && room.want[1]) {
        a.ships = []; b.ships = [];
        a.shots = new Map(); b.shots = new Map();
        a.placed = b.placed = false;
        room.phase = 'place';
        room.winner = undefined;
        room.want = [false, false];
        room.deadline = Date.now() + IDLE_PLACE_MS;
        room.log = [];
        addLog(room, '🔄 Реванш! Расставьте флот заново.');
        broadcast(room);
      } else {
        addLog(room, room.players[1 - idx].name + ' хочет реванш — подтвердите и вы.', 'warn');
        broadcast(room);
      }
      return;
    }

    if (m.t === 'reset') {
      if (!room || idx < 0) return;
      const p = room.players[idx];
      if (p) { p.ships = []; p.shots = new Map(); p.incoming = new Map(); p.placed = false; }
      room.phase = 'place';
      room.deadline = Date.now() + IDLE_PLACE_MS;
      addLog(room, p.name + ' решил расставить флот заново.', 'warn');
      broadcast(room);
      return;
    }
  }

  ws.on('close', () => { if (room) detach(room, idx, ws); });
  ws.on('error', () => {});
}

// ---------------------------------------------------------------- HTTP
const CT = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};

function serve(req, res) {
  if (req.url && req.url.startsWith('/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
  }
  if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUB, p));
  if (!file.startsWith(PUB)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404'); return; }
    res.writeHead(200, { 'Content-Type': CT[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer(serve);
const wss = new WebSocketServer({ server });
wss.on('connection', ws => attach(ws));

// одна ошибка не должна ронять весь сервер
process.on('uncaughtException', e => console.error('uncaughtException:', e.message));
process.on('unhandledRejection', e => console.error('unhandledRejection:', e));

// ------------------------------------------------- восстановление комнат
try {
  if (fs.existsSync(SAVE_FILE)) {
    const data = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8'));
    for (const r of data) {
      if (!r || !r.code || rooms.has(r.code)) continue;
      const room = {
        code: r.code, players: [null, null], phase: 'place', turn: 0,
        deadline: Date.now() + IDLE_PLACE_MS,
        log: [{ text: 'Комната восстановлена после перезапуска сервера', kind: 'warn' }],
        chat: r.chat || [], want: [false, false], createdAt: Date.now(), deadTimer: null
      };
      for (let i = 0; i < 2; i++) {
        const d = r.players && r.players[i];
        if (!d) continue;
        const p = makePlayer(d.id, d.name);
        restorePlayer(p, d);
        room.players[i] = p;
      }
      // восстанавливаем «входящие» выстрелы: чужие shots -> мой incoming
      for (let i = 0; i < 2; i++) {
        const p = room.players[i], o = room.players[1 - i];
        if (p && o) for (const [cell, v] of p.shots) o.incoming.set(cell, v);
      }
      roomCodes.add(r.code);
      rooms.set(r.code, room);
    }
    console.log('Восстановлено комнат:', rooms.size);
  }
} catch (e) { console.log('Восстановление не удалось:', e.message); }

// ------------------------------------------------- сохранение комнат
setInterval(() => {
  try {
    const arr = [];
    for (const r of rooms.values()) {
      if (r.phase === 'wait') continue;
      arr.push({
        code: r.code,
        chat: r.chat,
        players: r.players.map(p => p ? { id: p.id, name: p.name, nick: p.nick, shots: Array.from(p.shots.entries()), ships: p.ships } : null)
      });
    }
    fs.writeFileSync(SAVE_FILE, JSON.stringify(arr));
  } catch (e) {}
}, 30000);

// ------------------------------------------------- таймеры бездействия
setInterval(() => {
  for (const room of rooms.values()) {
    if (room.phase === 'playing' && Date.now() > room.deadline) tryEnd(room, 'не успел выстрелить');
    if (room.phase === 'place' && room.players[0] && room.players[1] && Date.now() > room.deadline) tryEnd(room, 'не успел расставить флот');
  }
}, 1000);

server.listen(PORT, () => {
  console.log('⚓ Морской бой запущен: http://localhost:' + PORT);
  const nets = os.networkInterfaces();
  for (const n of Object.values(nets)) {
    for (const i of n || []) {
      if ((i.family === 'IPv4' || i.family === 4) && !i.internal) console.log('   В локальной сети: http://' + i.address + ':' + PORT);
    }
  }
});
