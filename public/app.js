const $ = (id) => document.getElementById(id);
const feed = $('feed'), form = $('form'), qEl = $('q'), sendBtn = $('send'), stopBtn = $('stop');
const COLORS = { gpt: 'var(--gpt)', gemini: 'var(--gemini)', claude: 'var(--claude)' };

let providers = [];
let history = []; // 이전 회의의 질문/결론 (후속 질문에 맥락으로 전달)
let controller = null;

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
    card.className = 'p-card' + (p.configured ? '' : ' off');
    card.innerHTML = `
      <div class="p-head"><span class="dot" style="background:${COLORS[p.id]}"></span>${p.label}<span class="vendor">${p.vendor}</span>
        <label><input type="checkbox" data-id="${p.id}" ${p.configured ? 'checked' : 'disabled'}> 참가</label></div>
      <input type="text" data-model="${p.id}" value="${esc(p.model)}" list="models-${p.id}" ${p.configured ? '' : 'disabled'} aria-label="${p.label} 모델">
      <datalist id="models-${p.id}">${p.models.map((m) => `<option value="${esc(m)}">`).join('')}</datalist>
      ${p.configured ? '' : `<div class="p-warn">.env 에 ${p.keyEnv} 가 필요합니다</div>`}`;
    box.appendChild(card);
  }
  box.querySelectorAll('input[type=checkbox]').forEach((c) => c.addEventListener('change', () => { c.closest('.p-card').classList.toggle('off', !c.checked); renderModerator(); }));
  renderModerator();
}
const selected = () => providers.filter((p) => document.querySelector(`input[data-id="${p.id}"]`)?.checked);
function renderModerator() {
  const sel = $('moderator'), prev = sel.value;
  sel.innerHTML = selected().map((p) => `<option value="${p.id}">${p.label}</option>`).join('');
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
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
const head = (id, label, extra = '') => `<div class="msg-head"><span class="dot" style="background:${COLORS[id] || 'var(--accent)'}"></span>${esc(label)} ${extra}</div>`;
const pending = {}; // key -> element

function handle(ev, ctx) {
  const key = (r, who) => `${r}:${who}`;
  switch (ev.type) {
    case 'start': ctx.labels = Object.fromEntries(ev.participants.map((p) => [p.id, p.label])); break;
    case 'round': {
      const el = document.createElement('div');
      el.className = 'round';
      el.textContent = `── ${ev.round}라운드 / 총 ${ev.total}라운드 ──`;
      feed.appendChild(el);
      break;
    }
    case 'thinking': {
      const label = ctx.labels[ev.who];
      pending[key(ev.round, ev.who)] = add(head(ev.who, label, ev.round === 'final' ? '<small>결론 정리 중</small>' : '<small>생각 중</small>'), 'pending ' + ev.who);
      break;
    }
    case 'turn': {
      const el = pending[key(ev.round, ev.who)] || add('', ev.who);
      el.className = 'msg ' + ev.who;
      el.innerHTML = head(ev.who, ev.label) + `<div class="msg-body">${md(ev.text)}</div>`;
      break;
    }
    case 'turn_error': {
      const el = pending[key(ev.round, ev.who)] || add('', '');
      el.className = 'msg err';
      el.innerHTML = head(ev.who, ev.label, '<small>오류</small>') + `<div>${esc(ev.error)}</div>`;
      break;
    }
    case 'final': {
      pending[key('final', ev.who)]?.remove();
      add(head('', '최종 결론', `<small>사회자: ${esc(ev.label)}</small>`) + `<div class="msg-body">${md(ev.text)}</div>`, 'final');
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
  try {
    const res = await fetch('/api/council', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        question,
        participants: chosen.map((p) => ({ id: p.id, model: document.querySelector(`input[data-model="${p.id}"]`).value })),
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

fetch('/api/config').then((r) => r.json()).then((cfg) => {
  providers = cfg.providers;
  $('demo').hidden = !cfg.mock;
  renderParticipants();
  if (!providers.some((p) => p.configured)) {
    add('<div>사용 가능한 AI가 없습니다. <code>.env</code> 파일에 API 키를 넣고 서버를 다시 시작하세요. (README 참고)</div>', 'err');
  }
});
