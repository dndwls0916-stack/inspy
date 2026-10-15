const $ = (id) => document.getElementById(id);
const feed = $('feed'), form = $('form'), qEl = $('q'), sendBtn = $('send'), stopBtn = $('stop');
const COLORS = { gpt: 'var(--gpt)', gemini: 'var(--gemini)', claude: 'var(--claude)' };

let providers = [];
let mode = 'api';
const ok = (p) => (mode === 'cli' ? p.cliAvailable : p.apiConfigured);
let history = []; // 이전 회의의 질문/결론 (후속 질문에 맥락으로 전달)
let controller = null;
let sg = true; // 삼국지 모드
try { sg = localStorage.getItem('sg') !== '0'; } catch {}
const byId = (id) => providers.find((p) => p.id === id);
const nameOf = (id) => (sg && byId(id)?.persona ? byId(id).persona.name : byId(id)?.label || id);
const colorOf = (id) => (sg && byId(id)?.persona ? byId(id).persona.color : COLORS[id] || 'var(--accent)');

// --- 아주 작은 마크다운 렌더러 (HTML 이스케이프 후 변환) ---
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function inline(s) {
  return esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, '$1<em>$2</em>');
}
function md(text) {
  const out = [];
  let list = null, code = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const line of text.split('\n')) {
    if (/^```/.test(line)) {
      if (code === null) { closeList(); code = []; } else { out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`); code = null; }
      continue;
    }
    if (code !== null) { code.push(line); continue; }
    let m;
    if ((m = line.match(/^#{1,6}\s+(.*)/))) { closeList(); out.push(`<h3>${inline(m[1])}</h3>`); }
    else if ((m = line.match(/^\s*[-*•]\s+(.*)/))) { if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(m[1])}</li>`); }
    else if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) { if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(m[1])}</li>`); }
    else if (!line.trim()) closeList();
    else { closeList(); out.push(`<p>${inline(line)}</p>`); }
  }
  if (code !== null) out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
  closeList();
  return out.join('');
}

// --- 설정 UI ---
function renderParticipants() {
  const box = $('participants');
  box.innerHTML = '';
  for (const p of providers) {
    const card = document.createElement('div');
    card.className = 'p-card' + (ok(p) ? '' : ' off');
    card.innerHTML = `
      <div class="p-head"><span class="dot" style="background:${colorOf(p.id)}"></span>${esc(nameOf(p.id))}<span class="vendor">${sg ? p.label + ' · ' : ''}${p.vendor}</span>
        <label><input type="checkbox" data-id="${p.id}" ${ok(p) ? 'checked' : 'disabled'}> 참가</label></div>
      <input type="text" data-model="${p.id}" value="${mode === 'cli' ? '' : esc(p.model)}" placeholder="${mode === 'cli' ? '비우면 CLI 기본 모델' : ''}" list="models-${p.id}" ${ok(p) ? '' : 'disabled'} aria-label="${p.label} 모델">
      <datalist id="models-${p.id}">${p.models.map((m) => `<option value="${esc(m)}">`).join('')}</datalist>
      ${ok(p) ? '' : `<div class="p-warn">${mode === 'cli' ? `'${p.cliBin}' CLI 설치·로그인이 필요합니다` : `.env 에 ${p.keyEnv} 가 필요합니다`}</div>`}`;
    box.appendChild(card);
  }
  box.querySelectorAll('input[type=checkbox]').forEach((c) => c.addEventListener('change', () => { c.closest('.p-card').classList.toggle('off', !c.checked); renderModerator(); }));
  renderModerator();
}
const selected = () => providers.filter((p) => document.querySelector(`input[data-id="${p.id}"]`)?.checked);
function renderModerator() {
  const sel = $('moderator'), prev = sel.value;
  sel.innerHTML = selected().map((p) => `<option value="${p.id}">${esc(nameOf(p.id))}${sg ? ` (${p.label})` : ''}</option>`).join('');
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
  else if (sg && [...sel.options].some((o) => o.value === 'claude')) sel.value = 'claude'; // 맏형 유비가 주재
  refreshStage();
}

// --- 피드 ---
function add(html, cls = '') {
  const el = document.createElement('div');
  el.className = 'msg ' + cls;
  el.innerHTML = html;
  feed.querySelector('.empty')?.remove();
  feed.appendChild(el);
  feed.scrollTop = feed.scrollHeight;
  return el;
}
const head = (id, label, extra = '') => {
  const p = byId(id);
  const who = sg && p?.persona ? `${esc(p.persona.name)} <small>${esc(p.label)}</small>` : esc(label);
  const mark = sg && p?.persona ? `<span class="mini-seal" style="--c:${p.persona.color}">${p.persona.hanja}</span>`
    : sg && !id ? '<span class="mini-seal" style="--c:var(--accent)">決</span>'
    : `<span class="dot" style="background:${colorOf(id)}"></span>`;
  return `<div class="msg-head">${mark}${who} ${extra}</div>`;
};

// --- 군의 자리(무대) ---
const STATE = { idle: '대기', thinking: '숙고 중…', speaking: '결단 중…', done: '발언 완료', error: '낙마(오류)' };
function renderStage(ids) {
  const stage = $('stage');
  stage.hidden = !sg || !ids.length;
  stage.innerHTML = ids.map((id) => {
    const p = byId(id).persona;
    return `<div class="seat" data-seat="${id}" style="--c:${p.color}">
      <div class="seal">${p.hanja}</div>
      <div class="seat-info"><div class="seat-name">${esc(p.name)} <small>${esc(byId(id).label)}</small></div>
      <div class="seat-title">${esc(p.title)}</div><div class="seat-state">${STATE.idle}</div></div></div>`;
  }).join('');
}
function seat(id, state) {
  const el = document.querySelector(`[data-seat="${id}"]`);
  if (!el) return;
  el.className = 'seat ' + state;
  el.querySelector('.seat-state').textContent = STATE[state];
}
const ORDER = ['claude', 'gpt', 'gemini']; // 유비(맏형) · 관우 · 장비
const refreshStage = () => renderStage(selected().map((p) => p.id).sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b)));
const pending = {}; // key -> element

function handle(ev, ctx) {
  const key = (r, who) => `${r}:${who}`;
  switch (ev.type) {
    case 'start': ctx.labels = Object.fromEntries(ev.participants.map((p) => [p.id, p.label])); break;
    case 'round': {
      const el = document.createElement('div');
      el.className = 'round';
      el.textContent = sg ? `── 제${ev.round}차 군의(軍議) · 총 ${ev.total}차 ──` : `── ${ev.round}라운드 / 총 ${ev.total}라운드 ──`;
      if (sg && ev.round > 1) document.querySelectorAll('.seat').forEach((e) => seat(e.dataset.seat, 'idle'));
      feed.appendChild(el);
      break;
    }
    case 'thinking': {
      const label = ctx.labels[ev.who];
      seat(ev.who, ev.round === 'final' ? 'speaking' : 'thinking');
      pending[key(ev.round, ev.who)] = add(head(ev.who, label, ev.round === 'final' ? '<small>결론 정리 중</small>' : '<small>생각 중</small>'), 'pending ' + ev.who);
      break;
    }
    case 'turn': {
      seat(ev.who, 'done');
      const el = pending[key(ev.round, ev.who)] || add('', ev.who);
      el.className = 'msg ' + ev.who;
      el.innerHTML = head(ev.who, ev.label) + `<div class="msg-body">${md(ev.text)}</div>`;
      break;
    }
    case 'turn_error': {
      seat(ev.who, 'error');
      const el = pending[key(ev.round, ev.who)] || add('', '');
      el.className = 'msg err';
      el.innerHTML = head(ev.who, ev.label, '<small>오류</small>') + `<div>${esc(ev.error)}</div>`;
      break;
    }
    case 'final': {
      pending[key('final', ev.who)]?.remove();
      seat(ev.who, 'done');
      add(head('', sg ? '최종 결단(決斷)' : '최종 결론', `<small>${sg ? '주재' : '사회자'}: ${esc(nameOf(ev.who))}</small>`) + `<div class="msg-body">${md(ev.text)}</div>`, 'final');
      ctx.conclusion = ev.text;
      break;
    }
    case 'error': add(`<div>${esc(ev.error)}</div>`, 'err'); break;
  }
  feed.scrollTop = feed.scrollHeight;
}

async function runMeeting(question) {
  const chosen = selected();
  if (!chosen.length) return add('<div>참가할 AI를 한 명 이상 선택하세요.</div>', 'err');

  add(esc(question), 'user');
  setBusy(true);
  controller = new AbortController();
  const ctx = { labels: {}, conclusion: null };
  refreshStage();
  try {
    const res = await fetch('/api/council', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        question,
        participants: chosen.map((p) => ({ id: p.id, model: document.querySelector(`input[data-model="${p.id}"]`).value })),
        mode,
        persona: sg,
        rounds: Number($('rounds').value),
        moderator: $('moderator').value,
        history,
      }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (chunk.startsWith('data: ')) handle(JSON.parse(chunk.slice(6)), ctx);
      }
    }
    if (ctx.conclusion) history.push({ question, conclusion: ctx.conclusion });
  } catch (err) {
    if (err.name !== 'AbortError') add(`<div>${esc(err.message)}</div>`, 'err');
    else add('<div>회의가 중단되었습니다.</div>', 'err');
  } finally {
    Object.values(pending).forEach((el) => el.classList.contains('pending') && el.remove());
    for (const k in pending) delete pending[k];
    setBusy(false);
  }
}

function setBusy(b) {
  sendBtn.hidden = b;
  stopBtn.hidden = !b;
  qEl.disabled = b;
  if (!b) qEl.focus();
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const q = qEl.value.trim();
  if (!q || controller && !stopBtn.hidden) return;
  qEl.value = '';
  runMeeting(q);
});
qEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) form.requestSubmit(); });
stopBtn.addEventListener('click', () => controller?.abort());
$('reset').addEventListener('click', () => {
  controller?.abort();
  history = [];
  feed.innerHTML = '<div class="empty">새 회의를 시작합니다. 질문을 입력하세요.</div>';
});

function applyTheme() {
  document.body.classList.toggle('sg', sg);
  $('sg').checked = sg;
  document.title = sg ? '桃園 · AI 군의' : 'AI 회의실';
  $('title').textContent = sg ? 'AI 도원결의' : 'AI 회의실';
  $('subtitle').textContent = sg ? '유비 · 관우 · 장비가 군의(軍議)를 열어 결단을 내립니다.' : 'GPT · Gemini · Claude가 함께 토론하고 결론을 정리합니다.';
  if (providers.length) { $('moderator').value = ''; renderParticipants(); }
}
$('sg').addEventListener('change', (e) => {
  sg = e.target.checked;
  try { localStorage.setItem('sg', sg ? '1' : '0'); } catch {}
  applyTheme();
});

function setMode(m) {
  mode = m;
  document.querySelector(`input[name=mode][value=${m}]`).checked = true;
  $('modeHelp').textContent = m === 'cli'
    ? '설치·로그인된 claude / codex / gemini CLI를 호출합니다. API 키가 필요 없습니다.'
    : '.env 의 API 키로 각 AI를 직접 호출합니다.';
  renderParticipants();
}
document.querySelectorAll('input[name=mode]').forEach((r) => r.addEventListener('change', () => setMode(r.value)));

fetch('/api/config').then((r) => r.json()).then((cfg) => {
  providers = cfg.providers;
  $('demo').hidden = !cfg.mock;
  setMode(cfg.defaultMode);
  applyTheme();
  if (!providers.some((p) => p.apiConfigured || p.cliAvailable)) {
    add('<div>사용 가능한 AI가 없습니다. <code>.env</code> 에 API 키를 넣거나 claude / codex / gemini CLI를 설치·로그인하세요. (README 참고)</div>', 'err');
  }
});
