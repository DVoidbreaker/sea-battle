/* ============================================================
   ⚓ МОРСКОЙ БОЙ — клиент
   ============================================================ */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var COORDS = 'АБВГДЕЖЗИК';
  var SHIP_DEFS = [
    { cls: 'deck4', name: 'Линкор',  deck: 4, count: 1 },
    { cls: 'deck3', name: 'Крейсер', deck: 3, count: 2 },
    { cls: 'deck2', name: 'Эсминец', deck: 2, count: 3 },
    { cls: 'deck1', name: 'Катер',   deck: 1, count: 4 }
  ];
  var TOTAL = SHIP_DEFS.reduce(function (s, d) { return s + d.count; }, 0); // 10 кораблей
  var IDLE_TURN = 120000, IDLE_PLACE = 600000;

  /* ------------------------------------------------ хранилище */
  function store(k, v) {
    try { if (v === undefined) return localStorage.getItem('msb_' + k); localStorage.setItem('msb_' + k, v); } catch (e) { return null; }
  }
  function sess(k, v) {
    try { if (v === undefined) return sessionStorage.getItem('msb_' + k); sessionStorage.setItem('msb_' + k, v); } catch (e) { return null; }
  }
  var PID = store('pid');
  if (!PID) { PID = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 9); store('pid', PID); }
  // ID сессии вкладки: две вкладки одного браузера — два независимых игрока,
  // а перезагрузка страницы в той же вкладке позволяет вернуться в ту же игру
  var SID = sess('sid');
  if (!SID) { SID = Math.random().toString(36).slice(2, 10); sess('sid', SID); }
  var UID = PID + '|' + SID;

  /* ------------------------------------------------ тост */
  var toastT;
  function toast(msg, err) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'show' + (err ? ' err' : '');
    clearTimeout(toastT);
    toastT = setTimeout(function () { t.className = ''; }, 2600);
  }

  /* ------------------------------------------------ звук */
  var Snd = {
    ctx: null, on: store('snd') !== '0', noiseBuf: null,
    init: function () {
      if (!this.on) return;
      try {
        if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        if (this.ctx.state === 'suspended') this.ctx.resume();
      } catch (e) { this.ctx = null; }
    },
    noise: function (dur) {
      var ctx = this.ctx, n = Math.floor(ctx.sampleRate * dur);
      if (!this.noiseBuf || this.noiseBuf.length < n) this.noiseBuf = ctx.createBuffer(1, n, ctx.sampleRate);
      var d = this.noiseBuf.getChannelData(0);
      for (var i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
      return this.noiseBuf;
    },
    play: function (fn) {
      if (!this.on) return;
      this.init();
      if (!this.ctx) return;
      try { fn(this.ctx); } catch (e) {}
    },
    tone: function (f1, f2, dur, type, vol) {
      this.play(function (ctx) {
        var o = ctx.createOscillator(), g = ctx.createGain(), t = ctx.currentTime;
        o.type = type || 'sine';
        o.frequency.setValueAtTime(f1, t);
        o.frequency.exponentialRampToValueAtTime(Math.max(1, f2), t + dur);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(vol || 0.12, t + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(g); g.connect(ctx.destination);
        o.start(t); o.stop(t + dur + 0.03);
      });
    },
    burst: function (dur, freq, vol) {
      this.play(function (ctx) {
        var s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain(), t = ctx.currentTime;
        s.buffer = Snd.noise(dur);
        f.type = 'lowpass'; f.frequency.setValueAtTime(freq, t);
        f.frequency.exponentialRampToValueAtTime(Math.max(60, freq * 0.25), t + dur);
        g.gain.setValueAtTime(vol, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        s.connect(f); f.connect(g); g.connect(ctx.destination);
        s.start(t); s.stop(t + dur);
      });
    },
    click: function () { this.tone(720, 460, 0.07, 'square', 0.05); },
    place: function () { this.tone(300, 560, 0.14, 'sine', 0.09); },
    shot: function () { this.burst(0.35, 1400, 0.16); this.tone(240, 80, 0.3, 'sine', 0.09); },
    hit: function () { this.burst(0.4, 900, 0.26); this.tone(150, 55, 0.35, 'sine', 0.16); },
    sunk: function () {
      var self = this;
      this.burst(0.85, 700, 0.32);
      this.tone(130, 40, 0.7, 'sawtooth', 0.14);
      setTimeout(function () { self.burst(0.5, 500, 0.2); }, 220);
    },
    win: function () { var n = [523, 659, 784, 1046], s = this; n.forEach(function (f, i) { setTimeout(function () { s.tone(f, f, 0.22, 'triangle', 0.13); }, i * 130); }); },
    lose: function () { var n = [392, 330, 262], s = this; n.forEach(function (f, i) { setTimeout(function () { s.tone(f, f * 0.98, 0.34, 'triangle', 0.12); }, i * 190); }); },
    msg: function () { this.tone(920, 1180, 0.1, 'sine', 0.07); },
    err: function () { this.tone(180, 140, 0.16, 'square', 0.07); },
    join: function () { var s = this; this.tone(520, 700, 0.12, 'sine', 0.08); setTimeout(function () { s.tone(700, 940, 0.16, 'sine', 0.08); }, 110); }
  };

  function updSoundBtn() { $('btn-sound').textContent = Snd.on ? '🔊' : '🔇'; }
  $('btn-sound').addEventListener('click', function () {
    Snd.on = !Snd.on; store('snd', Snd.on ? '1' : '0'); updSoundBtn();
    if (Snd.on) { Snd.init(); Snd.click(); }
  });
  updSoundBtn();

  /* ------------------------------------------------ фон: море */
  (function sea() {
    var cv = $('sea');
    if (!cv || !cv.getContext) return;
    var ctx = cv.getContext('2d');
    var w = 0, h = 0, dpr = 1, stars = [], t0 = performance.now(), last = 0;
    var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = cv.clientWidth || window.innerWidth;
      h = cv.clientHeight || window.innerHeight;
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      stars = [];
      for (var i = 0; i < 70; i++) stars.push({ x: Math.random(), y: Math.random() * 0.5, a: 0.25 + Math.random() * 0.65, s: Math.random() * 1.6 + 0.6 });
    }
    window.addEventListener('resize', resize);
    resize();

    var waves = [
      { amp: 14, len: 300, sp: 0.00035, y: 0.66, col: 'rgba(20,86,132,0.55)' },
      { amp: 20, len: 460, sp: 0.00022, y: 0.74, col: 'rgba(12,60,100,0.75)' },
      { amp: 12, len: 210, sp: 0.0005, y: 0.85, col: 'rgba(6,36,64,0.9)' }
    ];
    var ships = [
      { x: 0.2, sp: 0.000012, s: 1, dir: 1 },
      { x: 0.8, sp: 0.000008, s: 0.7, dir: -1 }
    ];

    function drawShip(x, y, s, dir) {
      ctx.save();
      ctx.translate(x, y); ctx.scale(dir * s, s);
      ctx.fillStyle = 'rgba(3,14,26,0.92)';
      ctx.beginPath();
      ctx.moveTo(-70, 0); ctx.lineTo(70, 0); ctx.lineTo(52, 14); ctx.lineTo(-52, 14); ctx.closePath(); ctx.fill();
      ctx.fillRect(-26, -14, 44, 14);
      ctx.fillRect(-6, -26, 14, 12);
      ctx.fillRect(14, -20, 5, 6);
      ctx.fillRect(-34, -6, 8, 6);
      ctx.restore();
    }

    function frame(now) {
      requestAnimationFrame(frame);
      if (reduce) { if (last) return; }
      else if (now - last < 33) return;
      last = now;
      var t = now - t0;

      var g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, '#020c19');
      g.addColorStop(0.42, '#062942');
      g.addColorStop(0.66, '#0a4666');
      g.addColorStop(1, '#03182b');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);

      for (var i = 0; i < stars.length; i++) {
        var s = stars[i];
        ctx.globalAlpha = s.a * (0.6 + 0.4 * Math.sin(t * 0.001 + i));
        ctx.fillStyle = '#cfe9ff';
        ctx.fillRect(s.x * w, s.y * h, s.s, s.s);
      }
      ctx.globalAlpha = 1;

      var mx = w * 0.78, my = h * 0.4;
      var rg = ctx.createRadialGradient(mx, my, 4, mx, my, 120);
      rg.addColorStop(0, 'rgba(255,236,190,0.95)');
      rg.addColorStop(0.16, 'rgba(255,214,130,0.55)');
      rg.addColorStop(1, 'rgba(255,190,90,0)');
      ctx.fillStyle = rg; ctx.beginPath(); ctx.arc(mx, my, 120, 0, 6.3); ctx.fill();
      ctx.fillStyle = '#ffeec6'; ctx.beginPath(); ctx.arc(mx, my, 17, 0, 6.3); ctx.fill();

      for (var si = 0; si < ships.length; si++) {
        var sh = ships[si];
        if (!reduce) sh.x += sh.sp * 16;
        if (sh.x > 1.25) sh.x = -0.25;
        if (sh.x < -0.25) sh.x = 1.25;
        drawShip(sh.x * w, h * 0.635, sh.s, sh.dir);
      }

      for (var k = 0; k < waves.length; k++) {
        var wv = waves[k];
        ctx.beginPath();
        ctx.moveTo(0, h);
        for (var x = 0; x <= w + 8; x += 8) {
          var y = h * wv.y + Math.sin(x / wv.len * 6.283 + (reduce ? 0 : t * wv.sp)) * wv.amp
            + Math.sin(x / (wv.len * 0.43) * 6.283 - (reduce ? 0 : t * wv.sp * 1.7)) * wv.amp * 0.35;
          ctx.lineTo(x, y);
        }
        ctx.lineTo(w, h); ctx.closePath();
        ctx.fillStyle = wv.col; ctx.fill();
      }
    }
    requestAnimationFrame(frame);
  })();

  /* ------------------------------------------------ сеть */
  var ws = null, st = null, lastCode = '', reconnectT = 0, reconnectN = 0, manualClose = false, outbox = [];

  function connect(after) {
    manualClose = false;
    if (ws) { try { ws.close(); } catch (e) {} }
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    try { ws = new WebSocket(proto + location.host + '/'); }
    catch (e) { toast('Не удалось подключиться к серверу', true); return; }
    ws.onopen = function () {
      reconnectN = 0;
      var q = outbox.splice(0);
      q.forEach(function (o) { try { ws.send(JSON.stringify(o)); } catch (e) {} });
      if (after) { after(); after = null; }
    };
    ws.onmessage = function (ev) {
      var m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.t === 'state') onState(m);
      else if (m.t === 'error') {
        toast(m.msg, true); Snd.err();
        if (st && st.phase === 'place') {
          placing.pending = false;
          renderTray();
          $('btn-ready').textContent = '✔ Готово';
          updateReady();
        }
      }
    };
    ws.onclose = function () {
      outbox = [];
      if (manualClose) return;
      var delay = Math.min(15000, 900 * Math.pow(1.7, reconnectN++));
      $('p2stat') && ($('p2stat').innerHTML = '<span class="dot off"></span>переподключение…');
      clearTimeout(reconnectT);
      reconnectT = setTimeout(function () {
        connect(function () {
          if (lastCode) send({ t: 'join', id: UID, code: lastCode, name: nameOf() });
        });
      }, delay);
    };
    ws.onerror = function () {};
  }
  function send(o) {
    if (ws && ws.readyState === 1) { ws.send(JSON.stringify(o)); return true; }
    if (ws && ws.readyState === 0) { outbox.push(o); return true; } // соединяемся — отправим сразу после открытия
    toast('Нет связи с сервером…', true);
    return false;
  }
  function nameOf() { return ($('in-name').value || store('name') || '').trim().slice(0, 16) || 'Игрок'; }

  /* ------------------------------------------------ экраны */
  function showScreen(which) {
    $('scr-welcome').classList.toggle('show', which === 'welcome');
    $('scr-game').classList.toggle('show', which === 'game');
  }

  /* ------------------------------------------------ расстановка */
  var placing = { items: [], sel: 0, dir: 'h', pending: false };

  function freshList() {
    var list = [];
    SHIP_DEFS.forEach(function (d) {
      for (var i = 0; i < d.count; i++) list.push({ type: d.cls, name: d.name, len: d.deck, row: null, col: null, dir: 'h' });
    });
    return list;
  }
  function cellsFor(len, row, col, dir) {
    var out = [];
    for (var i = 0; i < len; i++) {
      var r = row + (dir === 'h' ? 0 : i), c = col + (dir === 'h' ? i : 0);
      if (r < 0 || r > 9 || c < 0 || c > 9) return null;
      out.push(r * 10 + c);
    }
    return out;
  }
  function itemCells(it) { return it.row === null ? null : cellsFor(it.len, it.row, it.col, it.dir); }
  function occupiedExcept(exceptIdx) {
    var set = new Set();
    placing.items.forEach(function (it, i) {
      if (i === exceptIdx || it.row === null) return;
      itemCells(it).forEach(function (c) { set.add(c); });
    });
    return set;
  }
  function canPlace(idx, row, col, dir) {
    var cells = cellsFor(placing.items[idx].len, row, col, dir);
    if (!cells) return null;
    var others = occupiedExcept(idx);
    for (var i = 0; i < cells.length; i++) {
      var r = Math.floor(cells[i] / 10), c = cells[i] % 10;
      for (var dr = -1; dr <= 1; dr++) {
        for (var dc = -1; dc <= 1; dc++) {
          var rr = r + dr, cc = c + dc;
          if (rr < 0 || rr > 9 || cc < 0 || cc > 9) continue;
          if (others.has(rr * 10 + cc)) return null;
        }
      }
    }
    return cells;
  }
  function allPlaced() { return placing.items.every(function (it) { return it.row !== null; }); }
  function countPlaced() { return placing.items.filter(function (it) { return it.row !== null; }).length; }

  function renderTray() {
    var tray = $('tray');
    tray.innerHTML = '';
    SHIP_DEFS.forEach(function (d) {
      var items = placing.items.map(function (it, i) { return { it: it, i: i }; }).filter(function (o) { return o.it.type === d.cls; });
      var free = items.filter(function (o) { return o.it.row === null; });
      var el = document.createElement('div');
      el.className = 'tray-item' + (free.length ? '' : ' used') + (placing.sel === (free.length ? free[0].i : -1) ? ' sel' : '');
      var mini = '<span class="mini-ship">';
      for (var i = 0; i < d.deck; i++) mini += '<i></i>';
      mini += '</span>';
      el.innerHTML = mini + '<b>' + d.name + '</b><span class="cnt">×' + free.length + '</span>';
      el.addEventListener('click', function () {
        if (!free.length) return;
        placing.sel = free[0].i;
        Snd.click();
        renderTray();
        hidePreview();
      });
      tray.appendChild(el);
    });
  }

  /* ------------------------------------------------ доски */
  function buildBoard(root) {
    root.innerHTML = '';
    var cells = document.createElement('div');
    cells.className = 'cells';
    var els = new Array(100);
    var corner = document.createElement('div'); corner.className = 'coord corner'; cells.appendChild(corner);
    for (var c = 0; c < 10; c++) {
      var t = document.createElement('div'); t.className = 'coord top'; t.textContent = COORDS[c]; cells.appendChild(t);
    }
    for (var r = 0; r < 10; r++) {
      var l = document.createElement('div'); l.className = 'coord left'; l.textContent = r + 1; cells.appendChild(l);
      for (var c2 = 0; c2 < 10; c2++) {
        var d = document.createElement('div');
        d.className = 'cell'; d.dataset.i = r * 10 + c2;
        cells.appendChild(d);
        els[r * 10 + c2] = d;
      }
    }
    var ships = document.createElement('div'); ships.className = 'ships';
    var fx = document.createElement('div'); fx.className = 'fx';
    root.appendChild(cells); root.appendChild(ships); root.appendChild(fx);
    root._cells = cells; root._els = els; root._ships = ships; root._fx = fx;
  }

  function sig(g) {
    return (g.ship ? 1 : 0) + '' + (g.hit ? 1 : 0) + '' + (g.sunk ? 1 : 0) + '' + (g.miss ? 1 : 0);
  }

  function paintCells(root, grid) {
    var els = root._els;
    for (var i = 0; i < 100; i++) {
      var g = grid[Math.floor(i / 10)][i % 10];
      var s = sig(g);
      var e = els[i];
      if (e._sig === s) continue;
      e._sig = s;
      e.className = 'cell';
      if (g.ship) e.classList.add('ship');
      if (g.hit) e.classList.add('hit');
      if (g.miss && !g.hit) e.classList.add('miss');
      if (g.sunk) e.classList.add('sunk');
    }
  }

  function drawShips(root, ships, side) {
    root._ships.innerHTML = '';
    (ships || []).forEach(function (s) {
      var d = document.createElement('div');
      d.className = 'shipmark' + (s.sunk ? ' sunk' : '') + (side === 'mine' && s.hit ? ' hit' : '');
      d.style.setProperty('--r', s.row);
      d.style.setProperty('--c', s.col);
      d.style.setProperty('--w', s.dir === 'h' ? s.len : 1);
      d.style.setProperty('--h', s.dir === 'h' ? 1 : s.len);
      root._ships.appendChild(d);
    });
  }

  function burstAt(root, r, c, delay) {
    setTimeout(function () {
      var fx = root._fx;
      var cx = (c + 0.5) * 1, cy = (r + 0.5) * 1;
      var flash = document.createElement('div');
      flash.className = 'flash';
      fx.appendChild(flash);
      setTimeout(function () { flash.remove(); }, 600);
      var ring = document.createElement('div');
      ring.className = 'ring';
      ring.style.left = (c * 10 + 1) + '%';
      ring.style.top = (r * 10 + 1) + '%';
      ring.style.width = '8%'; ring.style.height = '8%';
      fx.appendChild(ring);
      setTimeout(function () { ring.remove(); }, 800);
      for (var i = 0; i < 12; i++) {
        var p = document.createElement('div');
        p.className = 'p';
        p.style.left = (c * 10 + 3) + '%';
        p.style.top = (r * 10 + 3) + '%';
        var ang = Math.random() * 6.283, dist = 18 + Math.random() * 46;
        p.style.setProperty('--tx', Math.cos(ang) * dist + 'px');
        p.style.setProperty('--ty', (Math.sin(ang) * dist - 14) + 'px');
        p.style.animationDelay = (Math.random() * 90) + 'ms';
        p.style.background = ['#ffd166', '#ff8c42', '#ff5b4a', '#fff1c9'][i % 4];
        fx.appendChild(p);
        (function (node) { setTimeout(function () { node.remove(); }, 1100); })(p);
      }
      if (cx) { /* noop */ }
    }, delay || 0);
  }

  /* ------------------------------------------------ предпросмотр */
  function clearPreview() {
    for (var i = 0; i < 100; i++) {
      var e = $('board-mine')._els[i];
      e.classList.remove('preview-ok', 'preview-bad');
    }
  }
  function hidePreview() { clearPreview(); }

  function localShips() {
    return placing.items.filter(function (it) { return it.row !== null; }).map(function (it) {
      return { type: it.type, row: it.row, col: it.col, dir: it.dir, len: it.len, sunk: false, hit: false };
    });
  }
  function redrawLocal() {
    var local = localShips();
    drawShips($('board-mine'), local, 'mine');
    paintLocal($('board-mine'), local);
  }
  function showPreview(r, c) {
    if (!st || st.phase !== 'place' || placing.sel < 0 || placing.items[placing.sel].row !== null) return;
    clearPreview();
    var cells = canPlace(placing.sel, r, c, placing.dir);
    var els = $('board-mine')._els;
    if (cells) cells.forEach(function (i) { els[i].classList.add('preview-ok'); });
    else {
      var raw = cellsFor(placing.items[placing.sel].len, r, c, placing.dir);
      if (raw) raw.forEach(function (i) { els[i].classList.add('preview-bad'); });
    }
  }

  /* ------------------------------------------------ лог / чат / флоты */
  var logLen = 0, chatLen = 0, chatSeen = 0;

  function renderLog(arr) {
    var box = $('log');
    if (!arr || arr.length < logLen) { box.innerHTML = ''; logLen = 0; }
    for (var i = logLen; i < arr.length; i++) {
      var d = document.createElement('div');
      d.className = arr[i].kind || 'info';
      d.textContent = arr[i].text;
      box.appendChild(d);
    }
    logLen = arr ? arr.length : 0;
    box.scrollTop = box.scrollHeight;
  }

  function renderChat(arr) {
    var box = $('chat');
    if (!arr || arr.length < chatLen) { box.innerHTML = ''; chatLen = 0; }
    for (var i = chatLen; i < arr.length; i++) {
      var m = arr[i];
      var mine = st && m.from === st.you.name;
      var d = document.createElement('div');
      d.className = 'msg ' + (mine ? 'me' : 'them');
      d.innerHTML = '<b></b><span></span>';
      d.querySelector('b').textContent = m.from;
      d.querySelector('span').textContent = m.text;
      box.appendChild(d);
      if (!mine && i > 0 && st && st.phase === 'playing') Snd.msg();
    }
    chatLen = arr ? arr.length : 0;
    box.scrollTop = box.scrollHeight;
  }

  function shipSlot(type, sunk) {
    var def = SHIP_DEFS.filter(function (d) { return d.cls === type; })[0];
    var w = document.createElement('div');
    w.className = 'fs' + (sunk ? ' sunk' : '');
    var mini = '<span class="mini-ship">';
    for (var i = 0; i < (def ? def.deck : 1); i++) mini += '<i></i>';
    mini += '</span>';
    w.innerHTML = mini + '<span>' + (def ? def.name : type) + '</span>';
    return w;
  }

  function renderFleets() {
    var mine = $('fleet-mine'), foe = $('fleet-foe');
    mine.innerHTML = '';
    var myShips = (st && st.myShips) || [];
    if (myShips.length) {
      myShips.forEach(function (s) { mine.appendChild(shipSlot(s.type, s.sunk)); });
    } else {
      var n = 0;
      SHIP_DEFS.forEach(function (d) { for (var i = 0; i < d.count; i++) n++; });
      for (var k = 0; k < n; k++) mine.appendChild(shipSlot('deck1', false));
      Array.prototype.forEach.call(mine.children, function (el) { el.style.opacity = '.35'; });
    }

    foe.innerHTML = '';
    if (st && st.enemyBoard) {
      var rem = {}, dest = {};
      SHIP_DEFS.forEach(function (d) { rem[d.cls] = d.count; dest[d.cls] = 0; });
      (st.enemyBoard.destroyed || []).forEach(function (t) { if (dest[t] !== undefined) dest[t]++; });
      SHIP_DEFS.forEach(function (d) {
        for (var i = 0; i < d.count; i++) foe.appendChild(shipSlot(d.cls, i < dest[d.cls]));
      });
    } else if (st) {
      var div = document.createElement('div');
      div.className = 'hint small';
      div.textContent = st.foe ? (st.foe.placed ? 'Соперник готов ✔' : 'Соперник расставляет флот…') : 'Соперник не в сети';
      foe.appendChild(div);
    }
  }

  /* ------------------------------------------------ таймер */
  var deadlineAt = 0, totalIdle = IDLE_PLACE, timerT = null;
  function tickTimer() {
    if (!st) return;
    var bar = $('timerbar');
    if (st.phase !== 'playing' && st.phase !== 'place') { bar.hidden = true; return; }
    bar.hidden = false;
    var left = Math.max(0, deadlineAt - Date.now());
    var pct = totalIdle ? (left / totalIdle) * 100 : 0;
    $('timerfill').style.width = pct + '%';
    bar.classList.toggle('warn', left < 20000);
    var m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
    var time = m + ':' + (s < 10 ? '0' : '') + s;
    var text;
    if (st.phase === 'place') text = (st.you && st.you.placed ? 'Ждём соперника' : 'Расставьте флот') + ' · ' + time;
    else text = (st.turn === st.meIdx ? '⭐ Ваш ход' : 'Ход соперника') + ' · ' + time;
    $('timertext').textContent = text;
  }
  function resetTimer(state) {
    deadlineAt = Date.now() + (state.idleLeft || 0);
    totalIdle = state.phase === 'place' ? IDLE_PLACE : IDLE_TURN;
    tickTimer();
  }

  /* ------------------------------------------------ состояние */
  var prevFoe = null, prevMine = null;

  function onState(m) {
    var prev = st;
    st = m;
    if (m.id) UID = m.id;
    if (m.room) lastCode = m.room;
    resetTimer(m);
    showScreen('game');

    $('room-chip').hidden = false;
    $('room-code').textContent = m.room;
    $('players').hidden = (m.phase === 'wait');
    $('wait-box').hidden = (m.phase !== 'wait');
    $('place-box').hidden = (m.phase !== 'place');
    $('boards').hidden = (m.phase === 'wait');
    $('panels').hidden = (m.phase === 'wait');
    $('end-box').hidden = (m.phase !== 'ended');
    $('board-foe').parentNode.hidden = (m.phase === 'place');
    $('timerbar').hidden = (m.phase === 'wait' || m.phase === 'ended');

    if (m.phase === 'wait') {
      $('wait-code').textContent = m.room;
      if (location.hash !== '#' + m.room) history.replaceState(null, '', '#' + m.room);
      var link = location.origin + location.pathname + '#' + m.room;
      var img = $('qr');
      if (window.QR) {
        var url = QR.dataUrl(link);
        if (url) { img.src = url; img.parentNode.hidden = false; }
        else img.parentNode.hidden = true;
      }
      $('p1name').textContent = m.you.name;
      $('p1stat').innerHTML = '<span class="dot on"></span>вы в комнате';
      return;
    }

    /* игроки */
    $('p1name').textContent = m.you.name + ' (вы)';
    $('p2name').textContent = m.foe ? m.foe.name : 'Соперник';
    $('p1stat').innerHTML = '<span class="dot on"></span>' + (m.you.placed ? 'флот готов' : 'в игре');
    $('p2stat').innerHTML = m.foe
      ? '<span class="dot ' + (m.foe.online ? 'on' : 'off') + '"></span>' + (m.foe.online ? (m.foe.placed ? 'флот готов' : 'в игре') : 'отключился')
      : '<span class="dot off"></span>ожидание';

    /* доски */
    var myBoard = $('board-mine'), foeBoard = $('board-foe');

    if (m.phase === 'place' && !(m.myShips && m.myShips.length)) {
      // сервер ещё не принял расстановку — рисуем локально
      drawShips(myBoard, localShips(), 'mine');
      paintLocal(myBoard, localShips());
    } else if (m.myBoard) {
      var myNewHit = [], myNewMiss = [];
      if (prevMine) {
        for (var rr = 0; rr < 10; rr++) {
          for (var cc = 0; cc < 10; cc++) {
            var g2 = m.myBoard[rr][cc], p2 = prevMine[rr][cc];
            if (g2.hit && !p2.hit) myNewHit.push([rr, cc]);
            else if (g2.miss && !p2.miss) myNewMiss.push([rr, cc]);
          }
        }
      }
      paintCells(myBoard, m.myBoard);
      drawShips(myBoard, m.myShips, 'mine');
      if (myNewHit.length) {
        myNewHit.forEach(function (pos) { burstAt(myBoard, pos[0], pos[1], 0); });
        Snd.hit();
        myBoard.classList.remove('shake'); void myBoard.offsetWidth; myBoard.classList.add('shake');
      } else if (myNewMiss.length) {
        Snd.shot();
      }
    }

    if (m.enemyBoard) {
      var newHits = [], newSunk = [];
      var fo = m.enemyBoard.grid;
      for (var r = 0; r < 10; r++) {
        for (var c = 0; c < 10; c++) {
          var g = fo[r][c];
          var p = prevFoe ? prevFoe[r][c] : null;
          if (g.sunk && (!p || !p.sunk)) newSunk.push([r, c]);
          else if (g.hit && p && !p.hit) newHits.push([r, c]);
        }
      }
      paintCells(foeBoard, fo);
      if (newSunk.length) {
        foeBoard.classList.remove('shake'); void foeBoard.offsetWidth; foeBoard.classList.add('shake');
        newSunk.forEach(function (pos, i) { burstAt(foeBoard, pos[0], pos[1], i * 70); });
        Snd.sunk();
      } else if (newHits.length) {
        Snd.hit();
        newHits.forEach(function (pos) { burstAt(foeBoard, pos[0], pos[1], 0); });
      }
      drawShips(foeBoard, [], 'foe');
      if (prevFoe && JSON.stringify(prevFoe) !== JSON.stringify(fo)) {
        if (!newHits.length && !newSunk.length && prevFoe !== null) {
          var anyNewMiss = false;
          for (var r2 = 0; r2 < 10 && !anyNewMiss; r2++)
            for (var c2 = 0; c2 < 10; c2++)
              if (fo[r2][c2].miss && !prevFoe[r2][c2].miss) { anyNewMiss = true; break; }
          if (anyNewMiss) Snd.shot();
        }
      }
      prevFoe = fo;
    }

    /* состояния досок */
    var myTurn = m.turn === m.meIdx;
    foeBoard.classList.toggle('your-turn', m.phase === 'playing' && myTurn);
    foeBoard.classList.toggle('locked', m.phase === 'ended' || !myTurn);
    myBoard.classList.toggle('under-fire', m.phase === 'playing' && !myTurn);
    $('turn-hint').textContent =
      m.phase === 'ended' ? 'Игра окончена' :
      myTurn ? '⭐ Ваш ход — выберите клетку' : 'Ход соперника, ждите…';

    $('my-score').textContent = m.myScore !== undefined ? ' · ' + m.myScore : '';
    $('foe-score').textContent = m.foeScore !== undefined ? ' · ' + m.foeScore : '';

    /* расстановка */
    if (m.phase === 'place') {
      if (!st.you.placed && placing.pending) placing.pending = false;
      renderTray();
      var done = countPlaced();
      $('place-status').innerHTML = m.you.placed
        ? 'Вы готовы ✔ — <b>ждём соперника…</b>'
        : (m.foe && m.foe.placed ? 'Соперник уже готов ✔ — ' : '') + done + ' из ' + TOTAL + ' кораблей расставлено';
      $('btn-ready').disabled = !(done === TOTAL) || m.you.placed || placing.pending;
      $('btn-ready').textContent = placing.pending ? 'Отправляем…' : '✔ Готово';
      $('place-sub').textContent = m.you.placed ? 'Ожидание соперника' : 'Коснитесь клетки, чтобы поставить корабль';
      if (m.you.placed && m.myShips) { paintCells(myBoard, m.myBoard); drawShips(myBoard, m.myShips, 'mine'); }
    }

    renderLog(m.log);
    renderChat(m.chat);
    renderFleets();

    /* конец игры */
    if (m.phase === 'ended') {
      var win = m.winner === m.meIdx;
      $('end-emoji').textContent = win ? '🏆' : '💀';
      $('end-title').textContent = win ? 'Победа!' : 'Поражение';
      $('end-text').textContent = win
        ? 'Отличный бой! Ваш флот уничтожил всех: ' + (m.myScore || 0) + ' точных попаданий.'
        : 'В этот раз повезло сопернику (' + m.foe.name + '). Попробуйте ещё — реванш!';
      $('btn-rematch').disabled = !!(m.want && m.want[m.meIdx]);
      $('btn-rematch').textContent = (m.want && m.want[m.meIdx]) ? 'Ждём соперника…' : '🔄 Реванш';
      if (m.want && m.want[m.meIdx]) $('rematch-status').textContent = 'Соперник согласится — и начнём заново.';
      else if (m.want && m.want[1 - m.meIdx]) {
        $('rematch-status').textContent = 'Соперник хочет реванш — нажмите кнопку!';
        $('btn-rematch').disabled = false;
      } else $('rematch-status').innerHTML = '&nbsp;';
      if (prev && prev.phase !== 'ended') { win ? Snd.win() : Snd.lose(); }
    }
    prevMine = m.myBoard || null;
  }

  function paintLocal(root, localShips) {
    var occ = {};
    (localShips || []).forEach(function (s) {
      var cells = cellsFor(s.len, s.row, s.col, s.dir) || [];
      cells.forEach(function (i) { occ[i] = true; });
    });
    var grid = [];
    for (var r = 0; r < 10; r++) {
      grid.push([]);
      for (var c = 0; c < 10; c++) grid[r].push({ ship: !!occ[r * 10 + c], hit: false, sunk: false, miss: false });
    }
    paintCells(root, grid);
  }

  /* ------------------------------------------------ действия */
  function doCreate() {
    var name = nameOf();
    store('name', name);
    Snd.init();
    if (!send({ t: 'create', id: UID, name: name })) return;
    showScreen('game');
  }

  function doJoin() {
    var code = ($('in-code').value || '').trim().toUpperCase();
    if (code.length < 4) { toast('Введите код комнаты', true); Snd.err(); return; }
    var name = nameOf();
    store('name', name);
    Snd.init();
    if (!send({ t: 'join', id: UID, code: code, name: name })) return;
    showScreen('game');
  }

  function leaveToMenu() {
    manualClose = true;
    try { if (ws) ws.close(); } catch (e) {}
    ws = null;
    st = null; lastCode = ''; prevFoe = null;
    placing.items = freshList(); placing.sel = 0; placing.pending = false;
    logLen = 0; chatLen = 0;
    $('log').innerHTML = ''; $('chat').innerHTML = '';
    history.replaceState(null, '', location.pathname);
    showScreen('welcome');
  }

  function autoPlace() {
    placing.items.forEach(function (it) { it.row = null; it.col = null; });
    for (var attempt = 0; attempt < 200; attempt++) {
      placing.items.forEach(function (it) { it.row = null; it.col = null; });
      var ok = true;
      for (var i = 0; i < placing.items.length; i++) {
        var it = placing.items[i];
        var placed = false;
        for (var k = 0; k < 400 && !placed; k++) {
          var dir = Math.random() < 0.5 ? 'h' : 'v';
          var r = Math.floor(Math.random() * 10), c = Math.floor(Math.random() * 10);
          if (canPlace(i, r, c, dir)) { it.row = r; it.col = c; it.dir = dir; placed = true; }
        }
        if (!placed) { ok = false; break; }
      }
      if (ok) break;
    }
    placing.sel = placing.items.findIndex(function (it) { return it.row === null; });
    renderTray();
    hidePreview();
    redrawLocal();
    Snd.place();
    updateReady();
  }

  function updateReady() {
    if (!st || st.phase !== 'place') return;
    $('btn-ready').disabled = !allPlaced() || st.you.placed || placing.pending;
    $('place-status').innerHTML = (st.foe && st.foe.placed ? 'Соперник уже готов ✔ — ' : '') +
      countPlaced() + ' из ' + TOTAL + ' кораблей расставлено';
  }

  function sendPlacement() {
    if (!allPlaced()) { toast('Расставьте все корабли', true); Snd.err(); return; }
    placing.pending = true;
    $('btn-ready').disabled = true;
    $('btn-ready').textContent = 'Отправляем…';
    Snd.click();
    send({
      t: 'place',
      ships: placing.items.map(function (it) {
        return { type: it.type, len: it.len, row: it.row, col: it.col, dir: it.dir };
      })
    });
  }

  /* ------------------------------------------------ события UI */
  $('btn-create').addEventListener('click', doCreate);
  $('btn-join').addEventListener('click', doJoin);
  $('in-code').addEventListener('keydown', function (e) { if (e.key === 'Enter') doJoin(); });
  $('in-name').addEventListener('keydown', function (e) { if (e.key === 'Enter') { if ($('in-code').value) doJoin(); else doCreate(); } });

  function copyText(text, okMsg) {
    function done() { toast(okMsg); Snd.click(); $('copy-status').textContent = okMsg; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(function () { fallback(); });
    } else fallback();
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { toast('Скопируйте вручную: ' + text); }
      ta.remove();
    }
  }
  $('btn-copy').addEventListener('click', function () { copyText(lastCode, 'Код скопирован'); });
  $('btn-copy-code').addEventListener('click', function () { copyText(lastCode, 'Код скопирован'); });
  $('btn-copy-link').addEventListener('click', function () {
    copyText(location.origin + location.pathname + '#' + lastCode, 'Ссылка скопирована — отправьте её');
  });
  $('btn-leave').addEventListener('click', function () {
    if (st && st.phase !== 'wait' && st.phase !== 'ended') {
      if (!confirm('Выйти из игры? Соперник победит.')) return;
    }
    leaveToMenu();
  });
  $('btn-exit').addEventListener('click', leaveToMenu);

  $('btn-rotate').addEventListener('click', function () {
    placing.dir = placing.dir === 'h' ? 'v' : 'h';
    Snd.click();
    toast(placing.dir === 'h' ? 'Горизонтально' : 'Вертикально');
  });
  $('btn-auto').addEventListener('click', autoPlace);
  $('btn-clear').addEventListener('click', function () {
    placing.items.forEach(function (it) { it.row = null; it.col = null; });
    placing.sel = 0; renderTray(); hidePreview(); Snd.click(); updateReady();
    redrawLocal();
  });
  $('btn-ready').addEventListener('click', sendPlacement);
  $('btn-rematch').addEventListener('click', function () {
    Snd.click();
    send({ t: 'rematch' });
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'r' || e.key === 'R' || e.key === 'к' || e.key === 'К') {
      if (st && st.phase === 'place' && document.activeElement.tagName !== 'INPUT') {
        placing.dir = placing.dir === 'h' ? 'v' : 'h';
        Snd.click();
      }
    }
  });

  /* доска противника — выстрел */
  $('board-foe').addEventListener('click', function (e) {
    var cell = e.target.closest('.cell');
    if (!cell || !st || st.phase !== 'playing') return;
    if (st.turn !== st.meIdx) { toast('Ждите хода соперника', true); Snd.err(); return; }
    var i = +cell.dataset.i;
    var g = st.enemyBoard.grid[Math.floor(i / 10)][i % 10];
    if (g.hit || g.miss) { toast('В эту клетку уже стреляли', true); return; }
    Snd.init();
    Snd.click();
    send({ t: 'fire', row: Math.floor(i / 10), col: i % 10 });
  });

  /* своя доска — расстановка */
  $('board-mine').addEventListener('click', function (e) {
    var cell = e.target.closest('.cell');
    if (!cell || !st || st.phase !== 'place' || st.you.placed) return;
    var i = +cell.dataset.i, r = Math.floor(i / 10), c = i % 10;

    // снять корабль с клетки
    for (var k = 0; k < placing.items.length; k++) {
      var cells = itemCells(placing.items[k]);
      if (cells && cells.indexOf(i) >= 0) {
        placing.items[k].row = null;
        placing.sel = k;
        renderTray(); hidePreview(); Snd.click(); updateReady();
        redrawLocal();
        return;
      }
    }

    var sel = placing.sel;
    if (sel < 0 || !placing.items[sel]) {
      var free = placing.items.findIndex(function (it) { return it.row === null; });
      if (free < 0) { toast('Все корабли расставлены'); return; }
      placing.sel = sel = free;
    }
    var it = placing.items[sel];
    if (it.row !== null) {
      var f = placing.items.findIndex(function (x) { return x.row === null; });
      if (f < 0) { toast('Все корабли расставлены'); return; }
      placing.sel = f;
      return;
    }
    var ok = canPlace(sel, r, c, placing.dir);
    if (!ok) {
      hidePreview();
      var els = $('board-mine')._els;
      var raw = cellsFor(it.len, r, c, placing.dir);
      if (raw) raw.forEach(function (ix) { els[ix].classList.add('preview-bad'); });
      setTimeout(hidePreview, 320);
      toast('Здесь нельзя — корабли не касаются', true);
      Snd.err();
      return;
    }
    it.row = r; it.col = c; it.dir = placing.dir;
    Snd.place();
    var next = placing.items.findIndex(function (x) { return x.row === null; });
    placing.sel = next;
    renderTray(); hidePreview(); updateReady();
    redrawLocal();
  });

  $('board-mine').addEventListener('mousemove', function (e) {
    if (!st || st.phase !== 'place' || st.you.placed) return;
    var cell = e.target.closest('.cell');
    if (!cell) { hidePreview(); return; }
    var i = +cell.dataset.i;
    showPreview(Math.floor(i / 10), i % 10);
  });
  $('board-mine').addEventListener('mouseleave', hidePreview);

  /* чат */
  $('chat-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var v = $('chat-in').value.trim();
    if (!v || !st) return;
    $('chat-in').value = '';
    Snd.click();
    send({ t: 'chat', text: v });
  });

  /* ------------------------------------------------ запуск */
  buildBoard($('board-mine'));
  buildBoard($('board-foe'));
  placing.items = freshList();
  renderTray();

  var saved = store('name');
  if (saved) $('in-name').value = saved;

  var h = (location.hash || '').replace('#', '').trim().toUpperCase();
  if (/^[A-Z0-9]{5}$/.test(h)) {
    $('in-code').value = h;
    if (saved) {
      // перезагрузили страницу посреди игры — возвращаемся в ту же комнату
      setTimeout(doJoin, 200);
    } else {
      toast('Введите имя и входите в комнату ' + h);
    }
  }

  connect();
  setInterval(tickTimer, 500);
  document.addEventListener('pointerdown', function once() { Snd.init(); document.removeEventListener('pointerdown', once); });
})();
