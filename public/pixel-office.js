// 픽셀 오피스: 코드로 그린 사무실과 캐릭터. 참가자(1~8명)가 책상에서 일하다가 소집되면 걸어서 회의실로 가 앉는다.
// 이미지 파일을 쓰지 않고 canvas 에 직접 그린다. 앱은 setAgents / gather / disperse / bubble / talk / hand 만 부른다.
(function () {
  'use strict';
  const T = 16;
  const MAX = 8;
  const LOOKS = [
    { skin: '#f1c9a5', hair: '#2b2118', shirt: '#e9b949', pants: '#2c3e5c' },
    { skin: '#e8b995', hair: '#14110f', shirt: '#2f4a85', pants: '#3a3f4b' },
    { skin: '#f4d2b5', hair: '#6a3b1f', shirt: '#3f9a63', pants: '#4a4036' },
    { skin: '#d9a982', hair: '#8a8f98', shirt: '#8c8f96', pants: '#27324a' },
    { skin: '#c68e66', hair: '#1d1a1a', shirt: '#c4504a', pants: '#2f3a4f' },
    { skin: '#f0c4a0', hair: '#b5772f', shirt: '#6a55b8', pants: '#3b4150' },
    { skin: '#a8734f', hair: '#0f0d0d', shirt: '#2f9aa6', pants: '#403a33' },
    { skin: '#efc7a6', hair: '#d9d2c3', shirt: '#d98aa8', pants: '#2a3347' },
  ];
  const reduced = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function create(stage) {
    stage.classList.add('pixel-stage');
    const cv = document.createElement('canvas');
    cv.setAttribute('aria-hidden', 'true');
    stage.appendChild(cv);
    const ctx = cv.getContext('2d');
    const overlay = document.createElement('div');
    overlay.className = 'px-overlay';
    stage.appendChild(overlay);
    const roomTag = document.createElement('div');
    roomTag.className = 'px-roomtag';
    stage.appendChild(roomTag);

    const R = (c, x, y, w, h) => { ctx.fillStyle = c; ctx.fillRect(Math.round(x), Math.round(y), w, h); };
    let W = 30, H = 15, mid = 9, blocked = [], desks = [], deskSeat = [], meetSeat = [], table = null;
    let chars = [], clock = 0, last = 0, raf = 0, speedMul = 1;

    // ---------- 지도 ----------
    function build(n, box) {
      n = Math.max(1, Math.min(MAX, n));
      const rows = Math.ceil(n / 2);
      const need = Math.max(15, 5 + 5 * rows);
      // 담을 칸(box)의 가로세로비에 맞춰 사무실을 위아래로 늘려 빈 여백을 줄인다.
      H = box && box.w > 0 && box.h > 0 ? Math.min(40, Math.max(need, Math.round(W * box.h / box.w))) : need;
      mid = Math.floor((3 + H) / 2);
      blocked = Array.from({ length: H }, () => Array(W).fill(false));
      for (let y = 0; y < 3; y++) for (let x = 0; x < W; x++) blocked[y][x] = true;
      for (let y = 3; y < H; y++) if (y !== mid - 1 && y !== mid) blocked[y][17] = true;
      const pitch = rows > 1 ? Math.min(8, Math.floor((H - 7) / (rows - 1))) : 0;
      const span = rows > 1 ? (rows - 1) * pitch + 3 : 3; // 첫 자리 줄(1) + 책상(2) + 줄 간격
      const seat0 = 3 + Math.max(0, Math.floor((H - 3 - span) / 2));
      desks = Array.from({ length: MAX }, (_, i) => ({ x: i % 2 ? 10 : 2, y: seat0 + 1 + pitch * Math.floor(i / 2) })).slice(0, Math.max(n, 2));
      desks.forEach((d) => { for (let j = 0; j < 2; j++) for (let i = 0; i < 4; i++) blocked[d.y + j][d.x + i] = true; });
      deskSeat = desks.map((d) => ({ tx: d.x + 1, ty: d.y - 1, dir: 'down', sit: true }));
      table = { x: 20, y: mid - 1, w: 8, h: 3 };
      for (let j = 0; j < table.h; j++) for (let i = 0; i < table.w; i++) blocked[table.y + j][table.x + i] = true;
      const top = table.y - 1, bot = table.y + table.h;
      meetSeat = [
        { tx: 24, ty: top, dir: 'down' }, { tx: 24, ty: bot, dir: 'up' }, { tx: 21, ty: top, dir: 'down' }, { tx: 21, ty: bot, dir: 'up' },
        { tx: 27, ty: top, dir: 'down' }, { tx: 27, ty: bot, dir: 'up' }, { tx: 19, ty: mid, dir: 'right' }, { tx: 28, ty: mid, dir: 'left' },
      ].map((s) => ({ ...s, sit: true }));
      [...meetSeat, ...deskSeat].forEach((s) => { blocked[s.ty][s.tx] = false; });
      [[15, 3], [29, 3], [19, H - 2]].forEach(([x, y]) => { blocked[y][x] = true; });
      cv.width = W * T; cv.height = H * T;
      ctx.imageSmoothingEnabled = false;
      if (box && box.w > 0 && box.h > 0) {
        const w = Math.floor(Math.min(box.w, box.h * W / H));
        stage.style.width = w + 'px'; stage.style.height = Math.round(w * H / W) + 'px'; stage.style.aspectRatio = '';
      } else {
        stage.style.width = ''; stage.style.height = ''; stage.style.aspectRatio = `${W * T} / ${H * T}`;
      }
      stage.style.setProperty('--px-ratio', String(W / H));
    }

    // ---------- 길찾기(BFS) ----------
    function findPath(from, to) {
      const key = (x, y) => y * W + x, prev = new Map(), q = [from];
      prev.set(key(from.tx, from.ty), null);
      while (q.length) {
        const c = q.shift();
        if (c.tx === to.tx && c.ty === to.ty) break;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = c.tx + dx, ny = c.ty + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H || blocked[ny][nx] || prev.has(key(nx, ny))) continue;
          prev.set(key(nx, ny), c);
          q.push({ tx: nx, ty: ny });
        }
      }
      if (!prev.has(key(to.tx, to.ty))) return [];
      const path = [];
      for (let c = { tx: to.tx, ty: to.ty }; c; c = prev.get(key(c.tx, c.ty))) path.unshift(c);
      return path.slice(1);
    }

    // ---------- 그리기 ----------
    function drawBody(c, x, y, dir, frame, o) {
      const L = c.look, sit = o.sit, mouth = o.talking && Math.floor(clock * 8) % 2 === 0;
      const sw = [0, 1, 0, -1][frame & 3];
      const by = sit ? y + 5 : y + (!sit && (frame & 1) ? -1 : 0);
      R('rgba(0,0,0,.18)', x - 6, y - 1, 12, 2);
      if (dir === 'down' || dir === 'up') {
        if (!sit) {
          R(L.pants, x - 4, by - 6 + (sw > 0 ? -1 : 0), 3, 5); R(L.pants, x + 1, by - 6 + (sw < 0 ? -1 : 0), 3, 5);
          R('#222', x - 4, by - 2 + (sw > 0 ? -1 : 0), 3, 2); R('#222', x + 1, by - 2 + (sw < 0 ? -1 : 0), 3, 2);
        } else R(L.pants, x - 4, by - 6, 8, 4);
        const ad = sit ? 0 : sw;
        R(L.shirt, x - 5, by - 14, 10, 8);
        R(L.shirt, x - 7, by - 14 + (ad > 0 ? 1 : 0), 2, 7); R(L.shirt, x + 5, by - 14 + (ad < 0 ? 1 : 0), 2, 7);
        if (o.hand) { R(L.shirt, x + 5, by - 20, 2, 7); R(L.skin, x + 5, by - 22, 2, 2); R(L.skin, x - 7, by - 8, 2, 2); }
        else { R(L.skin, x - 7, by - 8 + (ad > 0 ? 1 : 0), 2, 2); R(L.skin, x + 5, by - 8 + (ad < 0 ? 1 : 0), 2, 2); }
        R(L.skin, x - 4, by - 22, 8, 8);
        if (dir === 'down') {
          R(L.hair, x - 5, by - 23, 10, 4); R(L.hair, x - 5, by - 21, 1, 4); R(L.hair, x + 4, by - 21, 1, 4);
          R('#1b1b1b', x - 2, by - 18, 1, 2); R('#1b1b1b', x + 1, by - 18, 1, 2);
          R(mouth ? '#8a2b2b' : '#b8745a', x - 1, by - 15, 2, 1);
        } else R(L.hair, x - 5, by - 23, 10, 9);
      } else {
        const s = dir === 'right' ? -1 : 1;
        ctx.save();
        if (s < 0) { ctx.translate(x, 0); ctx.scale(-1, 1); ctx.translate(-x, 0); }
        const off = sit ? 0 : sw * 2;
        if (!sit) {
          R(L.pants, x - 3 + off, by - 6, 3, 5); R(L.pants, x - off, by - 6, 3, 5);
          R('#222', x - 4 + off, by - 2, 4, 2); R('#222', x - off, by - 2, 4, 2);
        } else R(L.pants, x - 3, by - 6, 7, 4);
        R(L.shirt, x - 3, by - 14, 7, 8);
        R(L.shirt, x - 1 - (sit ? 0 : off), by - 14, 3, 7); R(L.skin, x - 1 - (sit ? 0 : off), by - 8, 3, 2);
        R(L.skin, x - 4, by - 22, 8, 8); R(L.hair, x - 4, by - 23, 8, 4); R(L.hair, x + 1, by - 21, 3, 6);
        R('#1b1b1b', x - 3, by - 18, 1, 2); R(L.skin, x - 5, by - 17, 1, 2);
        R(mouth ? '#8a2b2b' : '#b8745a', x - 3, by - 15, 2, 1);
        ctx.restore();
      }
    }
    function drawDesk(d, occupied) {
      const x = d.x * T, y = d.y * T;
      R('rgba(0,0,0,.15)', x + 2, y + 32, 64, 3);
      R('#b88a56', x, y + 2, 64, 30); R('#d3a76d', x, y, 64, 8); R('#9a7142', x, y + 30, 64, 2);
      R('#7d5a31', x + 6, y + 14, 14, 10); R('#6a4a28', x + 6, y + 14, 14, 1);
      if (occupied) { R('#e9e9ee', x + 24, y + 3, 16, 8); R('#bfc3cc', x + 24, y + 3, 16, 1); R('#9aa0ab', x + 31, y + 6, 2, 2); }
      else { R('#2b3140', x + 26, y + 2, 12, 7); R('#4b5468', x + 27, y + 3, 10, 5); }
      R('#f4f4f6', x + 46, y + 4, 6, 6); R('#d85b4a', x + 47, y + 5, 4, 2);
    }
    const drawChair = (sx, sy) => { R('#3b4252', sx - 6, sy - 2, 12, 10); R('#4b5468', sx - 5, sy - 3, 10, 3); };
    function drawTable() {
      const x = table.x * T, y = table.y * T, w = table.w * T;
      R('rgba(0,0,0,.18)', x + 2, y + 47, w, 4);
      R('#a77b4b', x, y + 3, w, 45); R('#c99a63', x, y, w, 40); R('#8f6638', x, y + 44, w, 4);
      R('#e9ecf1', x + w / 2 - 8, y + 12, 16, 10); R('#9aa0ab', x + w / 2 - 8, y + 12, 16, 1);
      R('#f4f4f6', x + 12, y + 18, 5, 5); R('#f4f4f6', x + w - 20, y + 14, 5, 5);
    }
    function drawRoom() {
      for (let y = 3; y < H; y++) for (let x = 0; x < W; x++) {
        R(x >= 18 ? ((x + y) % 2 ? '#d9cdb9' : '#d2c5b0') : ((x + y) % 2 ? '#c8d1dc' : '#c1cbd7'), x * T, y * T, T, T);
      }
      R('#b3a58d', 19 * T, (table.y - 2) * T, 10 * T, 7 * T); R('#c4b69e', 19 * T + 2, (table.y - 2) * T + 2, 10 * T - 4, 7 * T - 4);
      R('#e8ecf1', 0, 0, W * T, 3 * T); R('#4a5468', 0, 3 * T - 4, W * T, 4); R('#cfd5de', 0, 2 * T, W * T, T - 4);
      const win = (x) => { R('#7a8499', x, 5, 40, 28); R('#bfe0f5', x + 2, 7, 36, 24); R('#e6f4fb', x + 2, 7, 36, 6); R('#7a8499', x + 19, 7, 2, 24); };
      [24, 92, 168, 330, 420].forEach(win);
      R('#7a8499', 232, 8, 24, 24); R('#fff', 234, 10, 20, 20); R('#2a2f3a', 243, 12, 2, 9); R('#2a2f3a', 243, 19, 7, 2);
      R('#e6e9ef', 360, 4, 48, 24); R('#9aa0ab', 360, 4, 48, 1); R('#9aa0ab', 360, 27, 48, 1);
      R('#4285f4', 365, 9, 18, 2); R('#d97757', 365, 14, 30, 2); R('#10a37f', 365, 19, 12, 2);
      for (let y = 3; y < H; y++) if (y !== mid - 1 && y !== mid) { R('rgba(160,205,235,.55)', 17 * T + 5, y * T, 6, T); R('rgba(255,255,255,.6)', 17 * T + 5, y * T, 1, T); }
      const dy0 = (mid - 1) * T, dy1 = (mid + 1) * T;
      R('#4a5468', 17 * T + 3, 3 * T, 10, 3); R('#4a5468', 17 * T + 3, dy0 - 3, 10, 3); R('#4a5468', 17 * T + 3, dy1, 10, 3); R('#4a5468', 17 * T + 3, H * T - 3, 10, 3);
    }
    function drawProp(kind, tx, ty) {
      const x = tx * T, y = ty * T;
      if (kind === 'plant') { R('#8a5a3a', x + 3, y + 9, 10, 7); R('#2f8f4e', x + 2, y + 1, 12, 9); R('#3fae62', x + 4, y - 2, 8, 6); R('#2f8f4e', x + 6, y - 4, 4, 4); }
      else { R('#dfe6ee', x + 3, y + 2, 10, 14); R('#7bb7e6', x + 4, y - 4, 8, 7); R('#a9b3c1', x + 3, y + 12, 10, 4); R('#4a5468', x + 7, y + 5, 2, 2); }
    }

    // ---------- 캐릭터 상태 ----------
    function setAgents(list, box) {
      list = (list || []).slice(0, MAX);
      build(list.length, box);
      overlay.innerHTML = '';
      chars = list.map((a, i) => {
        const s = deskSeat[i];
        const el = document.createElement('div');
        el.className = 'px-tag';
        el.innerHTML = '<span class="px-chip"><b></b><small></small></span>';
        el.querySelector('b').textContent = a.name;
        el.querySelector('small').textContent = a.role || '';
        el.querySelector('small').hidden = !a.role;
        if (a.color) el.querySelector('.px-chip').style.borderColor = a.color;
        overlay.appendChild(el);
        const b = document.createElement('div');
        b.className = 'px-bubble'; b.hidden = true;
        overlay.appendChild(b);
        return { uid: a.uid, name: a.name, role: a.role || '', look: LOOKS[(a.look ?? i) % LOOKS.length], i, x: s.tx * T + 8, y: s.ty * T + 12, dir: 'down', sit: true, path: [], moving: false, step: 0, talking: false, hand: false, bubble: null, bubbleUntil: 0, talkUntil: 0, handUntil: 0, target: s, arrive: null, el, b, sig: '' };
      });
      roomTag.textContent = '';
      start();
    }
    const find = (uid) => chars.find((c) => c.uid === uid);
    function goTo(c, seat, delay = 0) {
      const run = () => {
        c.target = seat;
        if (reduced()) { c.path = []; c.sit = seat.sit; c.dir = seat.dir; c.x = seat.tx * T + 8; c.y = seat.ty * T + 12; return; }
        c.path = findPath({ tx: Math.round((c.x - 8) / T), ty: Math.round((c.y - 12) / T) }, seat);
        if (!c.path.length) { c.sit = seat.sit; c.dir = seat.dir; c.x = seat.tx * T + 8; c.y = seat.ty * T + 12; }
      };
      if (delay) setTimeout(run, delay / speedMul); else run();
    }
    function gather(uids) {
      const ids = uids.filter((u) => find(u));
      ids.forEach((u, k) => goTo(find(u), meetSeat[k % meetSeat.length], k * 450));
    }
    function disperse() {
      chars.forEach((c, k) => { c.bubble = null; c.talking = false; c.hand = false; goTo(c, deskSeat[c.i], k * 350); });
    }
    function bubble(uid, text, ms) { const c = find(uid); if (!c) return; c.bubble = text || null; c.bubbleUntil = ms ? performance.now() + ms : 0; }
    function talk(uid, text, ms = 2400) { const c = find(uid); if (!c) return; c.talking = true; c.talkUntil = performance.now() + ms; bubble(uid, text, ms + 600); }
    function hand(uid, on, ms = 3500) { const c = find(uid); if (!c) return; c.hand = on; c.handUntil = on ? performance.now() + ms : 0; }
    function clearBubbles() { chars.forEach((c) => { c.bubble = null; c.talking = false; c.hand = false; }); }
    function setRoomLabel(t) { roomTag.textContent = t || ''; }

    // ---------- 갱신·그리기 ----------
    function update(dt) {
      clock += dt;
      const now = performance.now();
      for (const c of chars) {
        if (c.bubble && c.bubbleUntil && now > c.bubbleUntil) c.bubble = null;
        if (c.talking && now > c.talkUntil) c.talking = false;
        if (c.hand && c.handUntil && now > c.handUntil) c.hand = false;
        if (!c.path.length) continue;
        const n = c.path[0], tx = n.tx * T + 8, ty = n.ty * T + 12;
        const dx = tx - c.x, dy = ty - c.y, dist = Math.hypot(dx, dy), stepLen = 56 * speedMul * dt;
        c.moving = true; c.sit = false;
        if (Math.abs(dx) > Math.abs(dy)) c.dir = dx > 0 ? 'right' : 'left'; else if (dy !== 0) c.dir = dy > 0 ? 'down' : 'up';
        c.step += dt * 9 * speedMul;
        if (dist <= stepLen) { c.x = tx; c.y = ty; c.path.shift(); } else { c.x += dx / dist * stepLen; c.y += dy / dist * stepLen; }
        if (!c.path.length) { c.moving = false; c.sit = c.target.sit; c.dir = c.target.dir; c.step = 0; }
      }
    }
    const pct = (v, t) => (v / t * 100).toFixed(2) + '%';
    function syncDom() {
      const wpx = W * T, hpx = H * T;
      for (const c of chars) {
        const meet = c.x > 17 * T + 8;
        const below = c.sit && c.dir === 'up';
        const chipH = meet ? 13 : 22;
        c.el.classList.toggle('above', !below);
        c.el.querySelector('small').hidden = meet || !c.role;
        c.el.style.left = pct(c.x, wpx);
        c.el.style.top = pct(below ? c.y + 6 : c.y - 25, hpx);
        c.b.hidden = !c.bubble;
        if (c.bubble) {
          c.b.style.left = pct(c.x, wpx);
          c.b.style.top = pct(below ? c.y - 25 : c.y - 25 - chipH - 3, hpx);
          if (c.sig !== c.bubble) { c.sig = c.bubble; if (c.bubble === '...') c.b.innerHTML = '<span class="px-dots"><i></i><i></i><i></i></span>'; else c.b.textContent = c.bubble; }
        } else c.sig = '';
      }
    }
    function render() {
      drawRoom();
      const items = [];
      [...deskSeat, ...meetSeat].forEach((s) => items.push({ y: s.ty * T + 4, draw: () => drawChair(s.tx * T + 8, s.ty * T + 8) }));
      desks.forEach((d, i) => items.push({ y: d.y * T + 32, draw: () => drawDesk(d, chars[i] && chars[i].sit && chars[i].x === deskSeat[i].tx * T + 8 && chars[i].y === deskSeat[i].ty * T + 12) }));
      items.push({ y: table.y * T + 48, draw: drawTable });
      items.push({ y: 3 * T + 16, draw: () => { drawProp('plant', 15, 3); drawProp('plant', 29, 3); } });
      items.push({ y: (H - 2) * T + 16, draw: () => drawProp('cooler', 19, H - 2) });
      chars.forEach((c) => items.push({ y: c.y, draw: () => drawBody(c, Math.round(c.x), Math.round(c.y), c.dir, c.moving ? Math.floor(c.step) % 4 : 0, { sit: c.sit, talking: c.talking, hand: c.hand }) }));
      items.sort((a, b) => a.y - b.y).forEach((it) => it.draw());
      syncDom();
    }
    function loop(ts) {
      const dt = Math.min(0.05, (ts - last) / 1000 || 0); last = ts;
      update(dt); render();
      raf = requestAnimationFrame(loop);
    }
    function start() { if (!raf) raf = requestAnimationFrame(loop); }
    function destroy() { cancelAnimationFrame(raf); raf = 0; stage.innerHTML = ''; }
    build(4);
    return { setAgents, gather, disperse, bubble, talk, hand, clearBubbles, setRoomLabel, destroy, find, setSpeed(v) { speedMul = v; } };
  }
  window.PixelOffice = { create };
})();
