/* ============================================================
   Мини-генератор QR (byte mode, версия 4, уровень M, 33x33)
   Возвращает SVG-строку или null, если данные не помещаются.
   ============================================================ */
(function () {
  'use strict';

  var VERSION = 4;
  var SIZE = 33;                 // 17 + 4*VERSION
  var DATA_CW = 64;              // codewords данных (2 блока по 32)
  var EC_PER_BLOCK = 18;         // codewords контроля на блок
  var NUM_BLOCKS = 2;
  var ALIGN_POS = 26;            // центр (единственного) выравнивающего узора

  /* ---------- поле Галуа GF(256) ---------- */
  function mul(x, y) {
    var z = 0;
    for (var i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11D);
      z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xFF;
  }

  function rsDivisor(degree) {
    var result = new Array(degree).fill(0);
    result[degree - 1] = 1;
    var root = 1;
    for (var i = 0; i < degree; i++) {
      for (var j = 0; j < result.length; j++) {
        result[j] = mul(result[j], root);
        if (j + 1 < result.length) result[j] ^= result[j + 1];
      }
      root = mul(root, 2);
    }
    return result;
  }

  function rsRemainder(data, divisor) {
    var result = new Array(divisor.length).fill(0);
    for (var d = 0; d < data.length; d++) {
      var factor = data[d] ^ result.shift();
      result.push(0);
      for (var i = 0; i < divisor.length; i++) result[i] ^= mul(divisor[i], factor);
    }
    return result;
  }

  /* ---------- биты ---------- */
  function pushBits(out, val, len) {
    for (var i = len - 1; i >= 0; i--) out.push((val >>> i) & 1);
  }

  function penalty(mod) {
    var score = 0, size = mod.length, r, c, i;

    // 1: серии одинаковых цвета длиной >= 5
    function lines(getter) {
      for (var a = 0; a < size; a++) {
        var run = 1;
        for (var b = 1; b < size; b++) {
          if (getter(a, b) === getter(a, b - 1)) { run++; }
          else { if (run >= 5) score += 3 + (run - 5); run = 1; }
        }
        if (run >= 5) score += 3 + (run - 5);
      }
    }
    lines(function (a, b) { return mod[a][b]; });
    lines(function (a, b) { return mod[b][a]; });

    // 2: блоки 2x2
    for (r = 0; r < size - 1; r++) {
      for (c = 0; c < size - 1; c++) {
        var v = mod[r][c];
        if (v === mod[r][c + 1] && v === mod[r + 1][c] && v === mod[r + 1][c + 1]) score += 3;
      }
    }

    // 3: паттерн 1:1:3:1:1
    var pat1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    var pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    function matchAt(getter, a, b, pat) {
      for (var k = 0; k < 11; k++) if (getter(a, b + k) !== pat[k]) return false;
      return true;
    }
    for (r = 0; r < size; r++) {
      for (c = 0; c + 11 <= size; c++) {
        if (matchAt(function (a, b) { return mod[a][b]; }, r, c, pat1)) score += 40;
        if (matchAt(function (a, b) { return mod[a][b]; }, r, c, pat2)) score += 40;
      }
    }
    for (c = 0; c < size; c++) {
      for (r = 0; r + 11 <= size; r++) {
        if (matchAt(function (a, b) { return mod[b][a]; }, r, c, pat1)) score += 40;
        if (matchAt(function (a, b) { return mod[b][a]; }, r, c, pat2)) score += 40;
      }
    }

    // 4: баланс тёмных модулей
    var dark = 0;
    for (r = 0; r < size; r++) for (c = 0; c < size; c++) if (mod[r][c]) dark++;
    var total = size * size;
    var k = Math.floor(Math.abs(dark * 20 - total * 10) * 10 / total);
    score += k * 10;
    return score;
  }

  function build(text) {
    var bytes = Array.from(new TextEncoder().encode(text));
    var maxBytes = DATA_CW - 2;
    if (bytes.length > maxBytes) return null;

    /* --- поток данных --- */
    var bits = [];
    pushBits(bits, 4, 4);                    // режим: byte
    pushBits(bits, bytes.length, 8);         // длина
    for (var i = 0; i < bytes.length; i++) pushBits(bits, bytes[i], 8);
    var cap = DATA_CW * 8;
    for (var t = 0; t < 4 && bits.length < cap; t++) bits.push(0);
    while (bits.length % 8 !== 0) bits.push(0);

    var dataCw = [];
    for (var b = 0; b < bits.length; b += 8) {
      var v = 0;
      for (var j = 0; j < 8; j++) v = (v << 1) | bits[b + j];
      dataCw.push(v);
    }
    var pad = [0xEC, 0x11], pi = 0;
    while (dataCw.length < DATA_CW) dataCw.push(pad[pi++ % 2]);

    /* --- блоки + Reed-Solomon --- */
    var gen = rsDivisor(EC_PER_BLOCK);
    var blocksData = [], blocksEc = [];
    var per = DATA_CW / NUM_BLOCKS;
    for (var bl = 0; bl < NUM_BLOCKS; bl++) {
      var chunk = dataCw.slice(bl * per, (bl + 1) * per);
      blocksData.push(chunk);
      blocksEc.push(rsRemainder(chunk, gen));
    }
    var finalCw = [];
    for (var k2 = 0; k2 < per; k2++)
      for (var bl2 = 0; bl2 < NUM_BLOCKS; bl2++) finalCw.push(blocksData[bl2][k2]);
    for (var k3 = 0; k3 < EC_PER_BLOCK; k3++)
      for (var bl3 = 0; bl3 < NUM_BLOCKS; bl3++) finalCw.push(blocksEc[bl3][k3]);

    /* --- матрица --- */
    var size = SIZE;
    var mod = [], fn = [];
    for (var r = 0; r < size; r++) {
      mod.push(new Array(size).fill(false));
      fn.push(new Array(size).fill(false));
    }
    function setM(x, y, dark) {
      if (x < 0 || y < 0 || x >= size || y >= size) return;
      mod[y][x] = dark; fn[y][x] = true;
    }
    function finder(cx, cy) {
      for (var dy = -4; dy <= 4; dy++) {
        for (var dx = -4; dx <= 4; dx++) {
          var dist = Math.max(Math.abs(dx), Math.abs(dy));
          setM(cx + dx, cy + dy, dist !== 2 && dist !== 4);
        }
      }
    }
    // сначала синхрополосы...
    for (var i2 = 0; i2 < size; i2++) { setM(6, i2, i2 % 2 === 0); setM(i2, 6, i2 % 2 === 0); }
    // ...затем рамки поиска (они перекрывают синхрополосу в своём районе)
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
    // выравнивающий узор
    for (var dy2 = -2; dy2 <= 2; dy2++)
      for (var dx2 = -2; dx2 <= 2; dx2++)
        setM(ALIGN_POS + dx2, ALIGN_POS + dy2, Math.max(Math.abs(dx2), Math.abs(dy2)) !== 1);
    // резерв под формат (и «тёмный модуль»); позиции 6 — это синхрополоса, их не трогаем
    for (var f = 0; f <= 8; f++) {
      if (f === 6) continue;
      setM(8, f, false); setM(f, 8, false);
    }
    for (var f2 = 0; f2 < 8; f2++) { setM(size - 1 - f2, 8, false); setM(8, size - 1 - f2, false); }
    setM(8, size - 8, true);

    /* --- укладка данных (зигзаг) --- */
    var stream = [];
    for (var cw = 0; cw < finalCw.length; cw++)
      for (var bi = 7; bi >= 0; bi--) stream.push((finalCw[cw] >>> bi) & 1);

    function drawData(target) {
      var idx = 0;
      for (var right = size - 1; right >= 1; right -= 2) {
        if (right === 6) right = 5;
        for (var vert = 0; vert < size; vert++) {
          for (var j2 = 0; j2 < 2; j2++) {
            var x = right - j2;
            var upward = ((right + 1) & 2) === 0;
            var y = upward ? size - 1 - vert : vert;
            if (!fn[y][x] && idx < stream.length) { target[y][x] = !!stream[idx++]; }
          }
        }
      }
    }

    function applyMask(target, mask) {
      for (var y = 0; y < size; y++) {
        for (var x = 0; x < size; x++) {
          if (fn[y][x]) continue;
          var inv;
          switch (mask) {
            case 0: inv = (x + y) % 2 === 0; break;
            case 1: inv = y % 2 === 0; break;
            case 2: inv = x % 3 === 0; break;
            case 3: inv = (x + y) % 3 === 0; break;
            case 4: inv = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
            case 5: inv = (x * y) % 2 + (x * y) % 3 === 0; break;
            case 6: inv = ((x * y) % 2 + (x * y) % 3) % 2 === 0; break;
            default: inv = ((x + y) % 2 + (x * y) % 3) % 2 === 0; break;
          }
          if (inv) target[y][x] = !target[y][x];
        }
      }
    }

    function formatBits(target, mask) {
      var data = (0 << 3) | mask;             // уровень M = 0
      var rem = data;
      for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      var bitsF = ((data << 10) | rem) ^ 0x5412;
      function bit(n) { return ((bitsF >>> n) & 1) !== 0; }
      for (var i3 = 0; i3 <= 5; i3++) set(8, i3, bit(i3));
      set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
      for (var i4 = 9; i4 < 15; i4++) set(14 - i4, 8, bit(i4));
      for (var i5 = 0; i5 < 8; i5++) set(size - 1 - i5, 8, bit(i5));
      for (var i6 = 8; i6 < 15; i6++) set(8, size - 15 + i6, bit(i6));
      set(8, size - 8, true);
      function set(x, y, dark) { target[y][x] = dark; fn[y][x] = true; }
    }

    var best = null, bestScore = Infinity;
    for (var mask = 0; mask < 8; mask++) {
      var cand = mod.map(row => row.slice());
      drawData(cand);
      applyMask(cand, mask);
      formatBits(cand, mask);
      var sc = penalty(cand);
      if (sc < bestScore) { bestScore = sc; best = cand; }
    }
    return best;
  }

  function toSvg(mod) {
    var size = mod.length, border = 3, n = size + border * 2;
    var d = '';
    for (var r = 0; r < size; r++) {
      var run = 0;
      for (var c = 0; c <= size; c++) {
        var dark = c < size && mod[r][c];
        if (dark) run++;
        else if (run > 0) {
          d += 'M' + (c - run + border) + ' ' + (r + border) + 'h' + run + 'v1h-' + run + 'z';
          run = 0;
        }
      }
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + n + ' ' + n +
      '" shape-rendering="crispEdges"><rect width="' + n + '" height="' + n +
      '" fill="#ffffff"/><path d="' + d + '" fill="#041426"/></svg>';
  }

  window.QR = {
    dataUrl: function (text) {
      try {
        var m = build(text);
        if (!m) return null;
        return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(toSvg(m));
      } catch (e) { return null; }
    }
  };
})();
