const $ = (id) => document.getElementById(id);
const feed = $('feed'), form = $('form'), qEl = $('q'), sendBtn = $('send'), stopBtn = $('stop');
const COLORS = { gpt: 'var(--gpt)', gemini: 'var(--gemini)', claude: 'var(--claude)' };

let providers = [];
let mode = 'api';
const ok = (p) => (mode === 'cli' ? p.cliAvailable : mode === 'mixed' ? p.apiConfigured || p.cliAvailable : p.apiConfigured);
let history = []; // 이전 회의의 질문/결론 (후속 질문에 맥락으로 전달)
let controller = null;
let cfgSage = null;
let liveModels = {}; // 서비스에서 가져온 모델 목록 { gpt: {ids, pick}, ... }
let sg = true; // 삼국지 모드
try { sg = localStorage.getItem('sg') !== '0'; } catch {}
const byId = (id) => providers.find((p) => p.id === id);
const nameOf = (id) => (sg && byId(id)?.persona ? byId(id).persona.name : byId(id)?.label || id);
const colorOf = (id) => (sg && byId(id)?.persona ? byId(id).persona.color : COLORS[id] || 'var(--accent)');

// --- 아주 작은 마크다운 렌더러 (HTML 이스케이프 후 변환) ---
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
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
// 모델 칸 기본값: 환경변수로 고정하지 않았고, 서비스 목록에 없는 기본 모델이면 목록의 추천 모델로 바꾼다.
function startModel(p) {
  const live = liveModels[p.id];
  return live && !p.modelPinned && !live.ids.includes(p.model) && live.pick ? live.pick : p.model;
}
// 선택지: API 는 서비스에서 가져온 목록(없으면 정적 목록), CLI 는 예시 목록, 혼합은 둘의 합집합
function modelChoices(p) {
  const live = liveModels[p.id]?.ids || [];
  const list = mode === 'cli' ? p.cliModels : mode === 'mixed' ? [...live, ...p.cliModels] : live.length ? live : p.models;
  return [...new Set(list)];
}
const CUSTOM = '__custom';
function modelSelectHtml(p) {
  const choices = modelChoices(p);
  const want = mode === 'api' ? startModel(p) : '';
  const autoLabel = mode === 'cli' ? '자동 (CLI 기본 모델)' : mode === 'mixed' ? '자동 (기본 모델)' : `자동 (${startModel(p)})`;
  const opts = [`<option value="">${esc(autoLabel)}</option>`, ...choices.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`), `<option value="${CUSTOM}">직접 입력…</option>`];
  return `<select data-modelsel="${p.id}" ${ok(p) ? '' : 'disabled'} aria-label="${esc(p.label)} 모델">${opts.join('')}</select>
      <input type="text" data-model="${p.id}" hidden placeholder="모델 이름 직접 입력" aria-label="${esc(p.label)} 모델 직접 입력">`;
}
// 선택한 모델 값 ('' = 자동)
function modelValue(id) {
  const sel = document.querySelector(`select[data-modelsel="${id}"]`);
  if (!sel) return '';
  return sel.value === CUSTOM ? document.querySelector(`input[data-model="${id}"]`).value.trim() : sel.value;
}
function wireModelSelects() {
  document.querySelectorAll('select[data-modelsel]').forEach((sel) => {
    const input = document.querySelector(`input[data-model="${sel.dataset.modelsel}"]`);
    sel.addEventListener('change', () => {
      input.hidden = sel.value !== CUSTOM;
      if (!input.hidden) input.focus();
    });
  });
}

function renderParticipants() {
  const box = $('participants');
  box.innerHTML = '';
  for (const p of providers) {
    const card = document.createElement('div');
    card.className = 'p-card' + (ok(p) ? '' : ' off');
    card.innerHTML = `
      <div class="p-head"><span class="dot" style="background:${colorOf(p.id)}"></span>${esc(nameOf(p.id))}<span class="vendor">${sg ? p.label + ' · ' : ''}${p.vendor}</span>
        <label><input type="checkbox" data-id="${p.id}" ${ok(p) ? 'checked' : 'disabled'}> 참가</label></div>
      ${modelSelectHtml(p)}
      ${ok(p) ? '' : `<div class="p-warn">${mode === 'cli' ? `'${p.cliBin}' CLI 설치·로그인이 필요합니다` : mode === 'mixed' ? `.env 의 ${p.keyEnv} 또는 '${p.cliBin}' CLI 가 필요합니다` : `.env 에 ${p.keyEnv} 가 필요합니다`}</div>`}`;
    box.appendChild(card);
  }
  box.querySelectorAll('input[type=checkbox]').forEach((c) => c.addEventListener('change', () => { c.closest('.p-card').classList.toggle('off', !c.checked); renderModerator(); }));
  wireModelSelects();
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

// --- 군의 자리(원탁 + 병풍 장면) ---
const STATE = { idle: '대기', thinking: '숙고 중…', speaking: '결단 중…', done: '발언 완료', error: '낙마(오류)' };
const POS = { claude: 'top', gpt: 'left', gemini: 'right' };
let agenda = '의제를 올려 주세요';
const seatHtml = (id, p, extra = '') => `<div class="seat idle ${extra}" data-seat="${id}" style="--c:${p.color}">
  <div class="seal">${p.hanja}</div>
  <div class="seat-name">${esc(p.name)}${byId(id) ? ` <small>${esc(byId(id).label)}</small>` : ''}</div>
  <div class="seat-title">${esc(p.title)}</div><div class="seat-state">${STATE.idle}</div></div>`;
function renderStage(ids) {
  const stage = $('stage');
  stage.hidden = !sg || !ids.length;
  if (stage.hidden) return;
  stage.innerHTML = `<div class="scene">
    <div class="screen" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
    <div class="table" aria-hidden="true"><div class="agenda"><small>議 · 의제</small><span id="agenda">${esc(agenda)}</span></div></div>
    ${ids.map((id) => seatHtml(id, byId(id).persona, 'pos-' + (POS[id] || 'left'))).join('')}
    ${cfgSage ? seatHtml('sage', cfgSage, 'sage') : ''}
    <div class="caption" id="caption" hidden></div></div>`;
}
function seat(id, state, label) {
  const el = document.querySelector(`[data-seat="${id}"]`);
  if (!el) return;
  el.classList.remove('idle', 'thinking', 'speaking', 'done', 'error');
  el.classList.add(state);
  el.querySelector('.seat-state').textContent = label ? label : id === 'sage' && state === 'thinking' ? '책략 구상 중…' : id === 'sage' && state === 'done' ? '한마디 올림' : STATE[state];
}
// 자막: 지금 발언의 첫 문장
function caption(id, text) {
  const el = $('caption');
  if (!el) return;
  const p = id === 'sage' ? cfgSage : byId(id)?.persona;
  const plain = text.replace(/[#*`>\-]/g, ' ').replace(/\s+/g, ' ').trim();
  const short = plain.length > 90 ? plain.slice(0, 90) + '…' : plain;
  el.hidden = !short;
  el.style.setProperty('--c', p?.color || 'var(--accent)');
  el.innerHTML = `<b>${esc(p?.name || '')}</b> ${esc(short)}`;
}
const ORDER = ['claude', 'gpt', 'gemini']; // 유비(맏형) · 관우 · 장비
const refreshStage = () => renderStage(selected().map((p) => p.id).sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b)));
const pending = {}; // key -> element

function handle(ev, ctx) {
  const key = (r, who) => `${r}:${who}`;
  switch (ev.type) {
    case 'start':
      ctx.labels = Object.fromEntries(ev.participants.map((p) => [p.id, p.label]));
      for (const p of ev.participants) {
        const small = document.querySelector(`[data-seat="${p.id}"] .seat-name small`);
        if (small) small.textContent = `${p.label} · ${p.via.toUpperCase()}`;
      }
      break;
    case 'round': {
      const el = document.createElement('div');
      el.className = 'round';
      const total = ev.consensus ? `합의될 때까지 · 최대 ${ev.total}` : `총 ${ev.total}`;
      el.textContent = sg ? `── 제${ev.round}차 군의(軍議) · ${total}차 ──` : `── ${ev.round}라운드 / ${total}라운드 ──`;
      if (sg && ev.round > 1) document.querySelectorAll('.seat:not(.sage)').forEach((e) => seat(e.dataset.seat, 'idle'));
      feed.appendChild(el);
      break;
    }
    case 'thinking': {
      if (ev.round === 'judge') {
        seat(ev.who, 'speaking', '판정 중…');
        pending[`judge:${ev.who}`] = add(head(ev.who, ctx.labels[ev.who], '<small>합의 여부 판정 중</small>'), 'pending ' + ev.who);
        break;
      }
      if (ev.who === 'sage') {
        seat('sage', 'thinking');
        pending['sage:sage'] = add(`<div class="msg-head"><span class="mini-seal" style="--c:${cfgSage.color}">${cfgSage.hanja}</span>${esc(cfgSage.name)} <small>책략 구상 중</small></div>`, 'pending sage-card');
        break;
      }
      const label = ctx.labels[ev.who];
      seat(ev.who, ev.round === 'final' ? 'speaking' : 'thinking');
      pending[key(ev.round, ev.who)] = add(head(ev.who, label, ev.round === 'final' ? '<small>결론 정리 중</small>' : '<small>생각 중</small>'), 'pending ' + ev.who);
      break;
    }
    case 'turn': {
      seat(ev.who, 'done');
      caption(ev.who, ev.text);
      const el = pending[key(ev.round, ev.who)] || add('', ev.who);
      el.className = 'msg ' + ev.who;
      el.innerHTML = head(ev.who, ev.label, `<small class="model" title="${ev.requested && ev.requested !== ev.model ? `선택한 ${esc(ev.requested)} 는 사용할 수 없어 대체했습니다` : ''}">${esc(ev.model || 'CLI 기본')}${ev.requested && ev.requested !== ev.model ? ` ← ${esc(ev.requested)} 대체` : ''}</small>`) + `<div class="msg-body">${md(ev.text)}</div>`;
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
      const badge = ev.consensus ? `<span class="verdict ${ev.consensus.reached ? 'yes' : 'no'}">${ev.consensus.reached ? `${ev.consensus.round}라운드 합의` : '합의 못함'}</span>` : '';
      add(head('', sg ? '최종 결단(決斷)' : '최종 결론', `${badge}<small>${sg ? '주재' : '사회자'}: ${esc(nameOf(ev.who))}${ev.consensus && !ev.consensus.reached && ev.consensus.reason ? ` · ${esc(ev.consensus.reason)}` : ''}</small>`) + `<div class="msg-body">${md(ev.text)}</div>`, 'final');
      ctx.conclusion = ev.text;
      break;
    }
    case 'consensus': {
      pending[`judge:${ev.who}`]?.remove();
      seat(ev.who, 'done');
      const items = (ev.disagreements || []).map((d) => `<li>${esc(d)}</li>`).join('');
      add(`<div class="msg-head"><span class="verdict ${ev.reached ? 'yes' : 'no'}">${ev.reached ? '합의' : '쟁점 남음'}</span>${sg ? '군의 판정' : '합의 판정'} <small>${esc(ev.round)}라운드 · ${esc(nameOf(ev.who))}</small></div>` +
        `<div class="msg-body"><p>${esc(ev.summary || '')}</p>${items ? `<p><b>남은 쟁점</b></p><ul>${items}</ul>` : ''}${ev.stalled ? '<p><i>지난 라운드와 입장이 거의 그대로입니다.</i></p>' : ''}</div>`, 'consensus-card ' + (ev.reached ? 'reached' : 'open'));
      break;
    }
    case 'sage': {
      seat('sage', 'done');
      caption('sage', ev.text.replace(/\*\*[^*]+\*\*/g, ''));
      const el = pending['sage:sage'] || add('', '');
      el.className = 'msg sage-card';
      el.innerHTML = `<div class="msg-head"><span class="mini-seal" style="--c:${cfgSage.color}">${cfgSage.hanja}</span>${esc(cfgSage.name)}의 한마디 <small>${esc(ev.label)}가 대신 올림</small></div><div class="msg-body">${md(ev.text)}</div>`;
      break;
    }
    case 'sage_error': {
      seat('sage', 'error');
      pending['sage:sage']?.remove();
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
  agenda = question.length > 70 ? question.slice(0, 70) + '…' : question;
  refreshStage();
  try {
    const res = await fetch('/api/council', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        question,
        participants: chosen.map((p) => ({ id: p.id, model: modelValue(p.id) })),
        mode,
        persona: sg,
        ...roundsBody(),
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

// 라운드 선택값: '1'~'3' 은 고정 라운드, 'c4'/'c6' 은 합의까지(최대 N)
function roundsBody() {
  const v = $('rounds').value;
  return v.startsWith('c') ? { consensus: true, maxRounds: Number(v.slice(1)), rounds: Number(v.slice(1)) } : { consensus: false, rounds: Number(v) };
}
$('rounds').addEventListener('change', () => { $('roundsHint').hidden = !$('rounds').value.startsWith('c'); });

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
  agenda = '의제를 올려 주세요';
  refreshStage();
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
    ? '설치·로그인된 claude / codex / gemini CLI를 호출합니다. API 키가 필요 없습니다. 모델은 "자동"이 가장 안전하고, 목록은 예시라 계정에 따라 안 될 수 있습니다.'
    : m === 'mixed'
      ? 'AI마다 자동 선택: .env 에 API 키가 있으면 API, 없으면 CLI를 씁니다. CLI 쪽 모델 목록은 예시입니다(안 되면 "자동").'
      : '.env 의 API 키로 각 AI를 직접 호출합니다.';
  renderParticipants();
}
document.querySelectorAll('input[name=mode]').forEach((r) => r.addEventListener('change', () => setMode(r.value)));

fetch('/api/models').then((r) => r.json()).then((m) => {
  liveModels = m || {};
  if (providers.length) renderParticipants(); // 설정보다 늦게 도착하면 다시 그린다
}).catch(() => {});

fetch('/api/config').then((r) => r.json()).then((cfg) => {
  providers = cfg.providers;
  $('demo').hidden = !cfg.mock;
  cfgSage = cfg.sage;
  setMode(cfg.defaultMode);
  applyTheme();
  if (!providers.some((p) => p.apiConfigured || p.cliAvailable)) {
    add('<div>사용 가능한 AI가 없습니다. <code>.env</code> 에 API 키를 넣거나 claude / codex / gemini CLI를 설치·로그인하세요. (README 참고)</div>', 'err');
  }
});
