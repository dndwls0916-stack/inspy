const $ = (id) => document.getElementById(id);
const feed = $('feed'), form = $('form'), qEl = $('q'), sendBtn = $('send'), stopBtn = $('stop');
const COLORS = { gpt: 'var(--gpt)', gemini: 'var(--gemini)', claude: 'var(--claude)' };

let providers = [];
let mode = 'api';
// API 전용 AI(Grok, DeepSeek 등)는 실행 방식과 상관없이 키(또는 로컬 설정)만 있으면 쓸 수 있다.
const ok = (p) => (!p.cliSupported ? p.apiConfigured : mode === 'cli' ? p.cliAvailable : mode === 'mixed' ? p.apiConfigured || p.cliAvailable : p.apiConfigured);
let history = []; // 이전 회의의 질문/결론 (후속 질문에 맥락으로 전달)
let controller = null;
let cfgSage = null;
let liveModels = {}; // 서비스에서 가져온 모델 목록 { gpt: {ids, pick}, ... }
let sgWanted = false; // 삼국지 모드 선택 (기본은 꺼짐 — 직업 역할로 회의)
try { sgWanted = localStorage.getItem('sg') === '1'; } catch {}
let sg = sgWanted; // 실제 적용: 삼국지 모드는 AI 한 종류에 한 자리씩(최대 3명)일 때만 가능
// 참가자(자리) id: 'gpt' 또는 같은 AI 를 더 앉힌 'gpt-2'. 앞부분이 AI 종류.
const provOf = (id) => String(id).split('-')[0];
const byId = (id) => providers.find((p) => p.id === provOf(id));
let seats = []; // [{ uid, provider }] 회의에 앉을 자리들 (순서 = 발언/표시 순서)
const seatNo = (uid) => { const same = seats.filter((x) => x.provider === provOf(uid)); return same.length > 1 ? ` ${same.findIndex((x) => x.uid === uid) + 1}` : ''; };
const nameOf = (id) => (sg && byId(id)?.persona ? byId(id).persona.name : (byId(id)?.label || id) + seatNo(id));
const colorOf = (id) => (sg && byId(id)?.persona ? byId(id).persona.color : COLORS[provOf(id)] || byId(id)?.color || 'var(--accent)');

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

// --- 첨부 파일: 브라우저에서 글자로 뽑아 질문과 함께 보낸다 ---
const ATTACH = { maxFiles: 30, maxChars: 80000, maxBytes: 20 * 1024 * 1024, maxPdfPages: 150 };
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|xml|html?|css|js|mjs|ts|tsx|jsx|py|java|c|cpp|h|cs|go|rs|rb|php|sh|bat|ps1|sql|ya?ml|toml|ini|cfg|conf|log|srt|vtt|tex)$/i;
let attachments = []; // { name, text, truncated }

// 글자 인코딩: UTF-8 이 아니면 한글 윈도우 파일(CP949)로 본다.
async function readText(file) {
  const buf = await file.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^\uFEFF/, '');
  } catch {
    return new TextDecoder('euc-kr').decode(buf);
  }
}

async function readPdf(file) {
  const pdfjs = await import('/vendor/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.mjs';
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const pages = Math.min(doc.numPages, ATTACH.maxPdfPages);
  const out = [];
  for (let i = 1; i <= pages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    out.push(content.items.map((it) => it.str + (it.hasEOL ? '\n' : '')).join('').trim());
  }
  const text = out.filter(Boolean).join('\n\n');
  if (!text.trim()) throw new Error('글자가 없는 PDF입니다(스캔한 이미지일 수 있습니다). 글자를 복사할 수 있는 PDF만 읽을 수 있습니다.');
  return doc.numPages > pages ? `${text}\n\n(PDF 앞쪽 ${pages}쪽만 읽었습니다. 전체 ${doc.numPages}쪽)` : text;
}

// docx 는 zip 이다: 'word/document.xml' 만 꺼내 글자를 뽑는다. (외부 라이브러리 없이 브라우저의 DecompressionStream 사용)
async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function unzipEntry(u8, wanted) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let e = u8.length - 22;
  while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error('올바른 docx 파일이 아닙니다');
  const count = dv.getUint16(e + 10, true);
  let off = dv.getUint32(e + 16, true);
  for (let i = 0; i < count && dv.getUint32(off, true) === 0x02014b50; i++) {
    const method = dv.getUint16(off + 10, true), csize = dv.getUint32(off + 20, true);
    const nlen = dv.getUint16(off + 28, true), elen = dv.getUint16(off + 30, true), clen = dv.getUint16(off + 32, true), lho = dv.getUint32(off + 42, true);
    if (new TextDecoder().decode(u8.subarray(off + 46, off + 46 + nlen)) === wanted) {
      const start = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
      const data = u8.subarray(start, start + csize);
      return method === 0 ? data : inflateRaw(data);
    }
    off += 46 + nlen + elen + clen;
  }
  throw new Error('문서 본문을 찾을 수 없습니다');
}
async function readDocx(file) {
  const xml = new TextDecoder().decode(await unzipEntry(new Uint8Array(await file.arrayBuffer()), 'word/document.xml'));
  const text = xml
    .replace(/<w:tab\/>/g, '\t').replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<\/w:p>(?=\s*<\/w:tc>)/g, '').replace(/<\/w:tc>/g, '\t').replace(/<\/w:tr>/g, '\n').replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (m, g) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[g.toLowerCase()] ?? (g[1] === 'x' || g[1] === 'X' ? String.fromCodePoint(parseInt(g.slice(2), 16)) : String.fromCodePoint(Number(g.slice(1))))))
    .replace(/\n{3,}/g, '\n\n').trim();
  if (!text) throw new Error('글자가 없는 문서입니다');
  return text;
}

const totalChars = () => attachments.reduce((n, a) => n + a.text.length, 0);
const fmt = (n) => n.toLocaleString('ko-KR');
function attachMsg(text, kind = '') {
  const el = $('attachMsg');
  el.textContent = text;
  el.className = 'attach-msg ' + kind;
}

function renderAttachments() {
  scheduleEstimate();
  $('attachList').innerHTML = attachments.map((a, i) => `<span class="chip" title="${esc(a.name)}"><b>${esc(a.name)}</b><i>${fmt(a.text.length)}자</i>${a.truncated ? '<span class="warn">일부만</span>' : ''}<button type="button" data-rm="${i}" aria-label="${esc(a.name)} 제거">×</button></span>`).join('');
  $('attachList').querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => { attachments.splice(Number(b.dataset.rm), 1); renderAttachments(); attachMsg(''); }));
  if (attachments.length) attachMsg(`첨부 ${attachments.length}개 · ${fmt(totalChars())}자 — 모든 AI가 매 라운드 읽으므로 호출 수만큼 사용량이 늘어납니다`, 'info');
}

async function addFiles(fileList) {
  const problems = [];
  for (const file of [...fileList]) {
    try {
      if (attachments.length >= ATTACH.maxFiles) throw new Error(`첨부는 최대 ${ATTACH.maxFiles}개까지입니다`);
      if (file.size > ATTACH.maxBytes) throw new Error(`파일이 너무 큽니다 (${Math.round(ATTACH.maxBytes / 1048576)}MB 이하)`);
      const name = file.name;
      let text;
      if (/\.pdf$/i.test(name)) text = await readPdf(file);
      else if (/\.docx$/i.test(name)) text = await readDocx(file);
      else if (TEXT_EXT.test(name) || file.type.startsWith('text/')) text = await readText(file);
      else throw new Error('지원하지 않는 형식입니다 (텍스트, 코드, CSV, JSON, PDF, docx 가능. 이미지·hwp 는 안 됩니다. 엑셀·파워포인트는 📁 폴더로 읽을 수 있습니다)');
      text = text.replace(/\u0000/g, '').trim();
      if (!text) throw new Error('내용이 비어 있습니다');
      const room = ATTACH.maxChars - totalChars();
      if (room <= 0) throw new Error(`첨부 용량이 가득 찼습니다 (합계 ${fmt(ATTACH.maxChars)}자)`);
      const truncated = text.length > room;
      attachments.push({ name, text: truncated ? text.slice(0, room) + '\n(이하 용량 제한으로 생략)' : text, truncated });
    } catch (err) {
      problems.push(`${file.name}: ${err.message || err}`);
    }
  }
  renderAttachments();
  if (problems.length) attachMsg(problems.join(' / '), 'err');
  else if (attachments.some((a) => a.truncated)) attachMsg(`일부 파일은 용량 제한(합계 ${fmt(ATTACH.maxChars)}자) 때문에 앞부분만 들어갔습니다`);
}

// --- 폴더: 서버가 폴더를 읽어 글자로 뽑아 준다. 보낼 파일은 사용자가 골라 첨부로 넣는다 ---
let folderFiles = [];
let folderRoot = '';
async function postJson(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
function renderFolder() {
  let budget = ATTACH.maxChars - totalChars();
  $('folderList').innerHTML = folderFiles.map((f, i) => {
    if (!f.ok) return `<label class="skip"><input type="checkbox" disabled> ${esc(f.rel)} — ${esc(f.note)}</label>`;
    const fits = f.text.length <= budget;
    if (fits) budget -= f.text.length;
    return `<label><input type="checkbox" data-f="${i}" ${fits ? 'checked' : ''}> ${esc(f.rel)} <i>${fmt(f.text.length)}자${f.truncated ? ' · 일부만' : ''}</i></label>`;
  }).join('') || '<span class="skip">읽을 수 있는 파일이 없습니다</span>';
  $('folderActions').hidden = !folderFiles.some((f) => f.ok);
  updateFolderInfo();
  $('folderList').querySelectorAll('[data-f]').forEach((c) => c.addEventListener('change', updateFolderInfo));
}
function pickedFolderFiles() {
  return [...$('folderList').querySelectorAll('[data-f]:checked')].map((c) => folderFiles[Number(c.dataset.f)]);
}
function updateFolderInfo() {
  const picked = pickedFolderFiles();
  const n = picked.reduce((a, f) => a + f.text.length, 0);
  $('folderInfo').textContent = `${picked.length}개 · ${fmt(n)}자 선택 (남은 용량 ${fmt(Math.max(0, ATTACH.maxChars - totalChars()))}자)`;
}
$('folderBtn').addEventListener('click', () => { $('folderPanel').hidden = !$('folderPanel').hidden; if (!$('folderPanel').hidden) $('folderPath').focus(); });
$('folderPath').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('folderScan').click(); } });
$('folderScan').addEventListener('click', async () => {
  $('folderInfo').textContent = '';
  $('folderList').textContent = '읽는 중…';
  try {
    const r = await postJson('/api/folder/scan', { path: $('folderPath').value });
    folderFiles = r.files;
    folderRoot = r.root;
    $('folderPath').value = r.root;
    renderFolder();
    if (r.truncatedScan) $('folderInfo').textContent += ' · 파일이 많아 일부만 훑었습니다';
  } catch (err) {
    folderFiles = [];
    $('folderActions').hidden = true;
    $('folderList').innerHTML = `<span class="attach-msg err">${esc(err.message)}</span>`;
  }
});
$('folderAdd').addEventListener('click', () => {
  const problems = [];
  for (const f of pickedFolderFiles()) {
    if (attachments.some((a) => a.name === f.rel)) continue;
    const room = ATTACH.maxChars - totalChars();
    if (attachments.length >= ATTACH.maxFiles) { problems.push(`첨부는 최대 ${ATTACH.maxFiles}개까지입니다`); break; }
    if (room <= 0) { problems.push(`첨부 용량이 가득 찼습니다 (합계 ${fmt(ATTACH.maxChars)}자)`); break; }
    const truncated = f.truncated || f.text.length > room;
    attachments.push({ name: f.rel, text: f.text.length > room ? f.text.slice(0, room) + '\n(이하 용량 제한으로 생략)' : f.text, truncated });
  }
  renderAttachments();
  renderFolder();
  if (problems.length) attachMsg(problems[0], 'err');
});

$('attachBtn').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', async (e) => { await addFiles(e.target.files); e.target.value = ''; });
// 끌어다 놓기
let dragDepth = 0;
addEventListener('dragenter', (e) => { if (e.dataTransfer?.types?.includes('Files')) { dragDepth++; document.body.classList.add('dragging'); } });
addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) document.body.classList.remove('dragging'); });
addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
addEventListener('drop', async (e) => {
  if (!e.dataTransfer?.files?.length) return;
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  await addFiles(e.dataTransfer.files);
});

// --- 설정 UI ---
// 모델 칸 기본값: 환경변수로 고정하지 않았고, 서비스 목록에 없는 기본 모델이면 목록의 추천 모델로 바꾼다.
function startModel(p) {
  const live = liveModels[p.id];
  return live && !p.modelPinned && !live.ids.includes(p.model) && live.pick ? live.pick : p.model;
}
// 선택지: API 는 서비스에서 가져온 목록(없으면 정적 목록), CLI 는 예시 목록, 혼합은 둘의 합집합
function modelChoices(p) {
  const live = liveModels[p.id]?.ids || [];
  const m = p.cliSupported ? mode : 'api'; // API 전용 AI 는 실행 방식과 상관없이 API 목록을 쓴다
  const list = m === 'cli' ? p.cliModels : m === 'mixed' ? [...live, ...p.cliModels] : live.length ? live : p.models;
  return [...new Set(list)];
}
const CUSTOM = '__custom';
function modelSelectHtml(seat, p) {
  const choices = modelChoices(p);
  const st = partState[seat.uid] || {};
  const pick = st.model && (st.model === CUSTOM || choices.includes(st.model)) ? st.model : '';
  const em = p.cliSupported ? mode : 'api';
  const autoLabel = em === 'cli' ? '자동 (CLI 기본 모델)' : em === 'mixed' ? '자동 (기본 모델)' : `자동 (${startModel(p)})`;
  const sel = (v) => (v === pick ? ' selected' : '');
  const opts = [`<option value=""${sel('')}>${esc(autoLabel)}</option>`, ...choices.map((m) => `<option value="${esc(m)}"${sel(m)}>${esc(m)}</option>`), `<option value="${CUSTOM}"${sel(CUSTOM)}>직접 입력…</option>`];
  return `<select data-modelsel="${seat.uid}" ${ok(p) ? '' : 'disabled'} aria-label="${esc(p.label)} 모델">${opts.join('')}</select>
      <input type="text" data-model="${seat.uid}" ${pick === CUSTOM ? '' : 'hidden'} value="${esc(pick === CUSTOM ? st.custom || '' : '')}" placeholder="모델 이름 직접 입력" aria-label="${esc(p.label)} 모델 직접 입력">`;
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

// 참가자별 역할/생각 깊이 (모드를 바꿔 다시 그려도 유지)
const partState = {};
const EFFORT_LABEL = { low: '낮음', medium: '보통', high: '높음' };
function roleOptions(selected) {
  const groups = {};
  for (const r of cfgRoles) (groups[r.group] ||= []).push(r);
  return `<option value="">역할 없음</option>` + Object.entries(groups).map(([g, list]) => `<optgroup label="${esc(g)}">${list.map((r) => `<option value="${esc(r.id)}" title="${esc(r.view)}" ${r.id === selected ? 'selected' : ''}>${esc(r.icon)} ${esc(r.name)}</option>`).join('')}</optgroup>`).join('');
}
function optsHtml(seat, p) {
  const st = partState[seat.uid] || {};
  const uid = seat.uid;
  return `<div class="p-opts">
      <select data-role="${uid}" ${ok(p) ? '' : 'disabled'} aria-label="${esc(p.label)} 역할">${roleOptions(st.role)}</select>
      <select data-effort="${uid}" ${ok(p) ? '' : 'disabled'} aria-label="${esc(p.label)} 생각 깊이">
        <option value="">생각 깊이: 자동</option>${['low', 'medium', 'high'].map((e) => `<option value="${e}" ${st.effort === e ? 'selected' : ''}>생각 깊이: ${EFFORT_LABEL[e]}</option>`).join('')}
      </select></div>`;
}
const roleOf = (id) => document.querySelector(`select[data-role="${id}"]`)?.value || '';
const effortOf = (id) => document.querySelector(`select[data-effort="${id}"]`)?.value || '';
function saveOpts() {
  for (const x of seats) {
    const ms = document.querySelector(`select[data-modelsel="${x.uid}"]`);
    partState[x.uid] = { role: roleOf(x.uid), effort: effortOf(x.uid), model: ms ? ms.value : '', custom: document.querySelector(`input[data-model="${x.uid}"]`)?.value || '' };
  }
}
const roleBadge = (ev) => (ev.roleName ? `<span class="role-badge">${esc((cfgRoles.find((r) => r.id === ev.role) || {}).icon || '')} ${esc(ev.roleName)}</span>` : '');
const effortBadge = (ev) => (ev.effort ? `<span class="effort-badge ${ev.effortApplied ? '' : 'off'}" title="${ev.effortApplied ? '이 호출에 적용됨' : '이 모델/방식은 생각 깊이 설정을 받지 않아 기본값으로 실행했습니다'}">깊이 ${EFFORT_LABEL[ev.effort]}${ev.effortApplied ? '' : ' (미적용)'}</span>` : '');

function renderTeams() {
  const groups = {};
  for (const t of cfgTeams) (groups[t.group || '기타'] ||= []).push(t);
  const roleNames = (t) => t.roles.map((r) => cfgRoles.find((x) => x.id === r)?.name || r).join(' · ');
  $('team').innerHTML = `<option value="">직접 선택</option>` +
    Object.entries(groups).map(([g, list]) => `<optgroup label="${esc(g)}">${list.map((t) => `<option value="${esc(t.id)}" title="${esc(roleNames(t))}">${esc(t.name)} (${t.roles.length}명)</option>`).join('')}</optgroup>`).join('') +
    `<option value="__clear">역할 모두 해제</option>`;
}
// 팀을 고르면 참가자 자리를 팀 인원수만큼 새로 구성하고 역할을 배정한다. 사용 가능한 AI 들에 돌아가며 앉힌다.
$('team').addEventListener('change', () => {
  const v = $('team').value;
  if (!v) return;
  saveOpts();
  if (v === '__clear') {
    for (const x of seats) partState[x.uid] = { ...(partState[x.uid] || {}), role: '' };
  } else {
    const team = cfgTeams.find((t) => t.id === v);
    if (team) {
      const usable = providers.filter(ok);
      const pool = usable.length ? usable : providers;
      seats = [];
      team.roles.slice(0, MAX_SEATS).forEach((role, i) => {
        const provider = pool[i % pool.length].id;
        const uid = newUid(provider);
        seats.push({ uid, provider });
        partState[uid] = { ...(partState[uid] || {}), role };
      });
    }
  }
  $('team').value = '';
  renderParticipants(true); // 방금 정한 역할을 이전 화면 값으로 덮어쓰지 않는다
  syncSg();
});

const MAX_SEATS = 8;
function newUid(provider) {
  if (!seats.some((x) => x.uid === provider)) return provider;
  for (let n = 2; ; n++) if (!seats.some((x) => x.uid === `${provider}-${n}`)) return `${provider}-${n}`;
}
// 처음 자리: 기본 3 AI(GPT·Gemini·Claude) 중 쓸 수 있는 것. 하나도 없으면 쓸 수 있는 다른 AI(최대 3), 그것도 없으면 기본 3.
const CORE = ['gpt', 'gemini', 'claude'];
function defaultSeats() {
  const core = providers.filter((p) => CORE.includes(p.id));
  const pick = core.filter(ok).length ? core.filter(ok) : providers.filter(ok).slice(0, 3).length ? providers.filter(ok).slice(0, 3) : core;
  return pick.map((p) => ({ uid: p.id, provider: p.id }));
}
const warnText = (p) => (!p.cliSupported ? `.env 의 ${p.envHint} 설정이 필요합니다 (이 AI 는 API 방식만 지원)` : mode === 'cli' ? `'${p.cliBin}' CLI 설치·로그인이 필요합니다` : mode === 'mixed' ? `.env 의 ${p.keyEnv} 또는 '${p.cliBin}' CLI 가 필요합니다` : `.env 에 ${p.keyEnv} 가 필요합니다`);
function renderParticipants(skipSave = false) {
  const box = $('participants');
  if (!seats.length) seats = defaultSeats();
  else if (!skipSave && box.querySelector('select[data-modelsel]')) saveOpts(); // 다시 그려도(예: 모델 목록이 늦게 도착) 고른 값이 사라지지 않게
  
  box.innerHTML = '';
  for (const seat of seats) {
    const p = byId(seat.uid);
    if (!p) continue;
    const card = document.createElement('div');
    card.className = 'p-card' + (ok(p) ? '' : ' off');
    card.innerHTML = `
      <div class="p-head"><span class="dot" style="background:${colorOf(seat.uid)}"></span>${esc(nameOf(seat.uid))}<span class="vendor">${sg ? p.label + ' · ' : ''}${p.vendor}</span>
        ${seats.length > 1 ? `<button type="button" class="seat-rm" data-rm="${seat.uid}" aria-label="${esc(nameOf(seat.uid))} 빼기" title="이 참가자 빼기">×</button>` : ''}</div>
      ${modelSelectHtml(seat, p)}
      ${optsHtml(seat, p)}
      ${ok(p) ? '' : `<div class="p-warn">${warnText(p)} (이 자리는 건너뜁니다)</div>`}`;
    box.appendChild(card);
  }
  box.querySelectorAll('select[data-role], select[data-effort], select[data-modelsel]').forEach((x) => x.addEventListener('change', saveOpts));
  box.querySelectorAll('input[data-model]').forEach((x) => x.addEventListener('input', saveOpts));
  box.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => { saveOpts(); seats = seats.filter((x) => x.uid !== b.dataset.rm); delete partState[b.dataset.rm]; renderParticipants(); syncSg(); }));
  renderAddSeat();
  wireModelSelects();
  renderModerator();
  scheduleEstimate();
}
// "+ 참가자 추가": 같은 AI 를 여러 자리에 앉힐 수도 있다(예: Claude 변호사 + Claude 비판자)
function renderAddSeat() {
  const wrap = $('addSeat');
  wrap.hidden = seats.length >= MAX_SEATS;
  const sel = $('addSeatSel');
  const opt = (p) => `<option value="${p.id}">${esc(p.label)}${ok(p) ? '' : ' (설정 필요)'}</option>`;
  const core = providers.filter((p) => !p.extra), extra = providers.filter((p) => p.extra);
  sel.innerHTML = core.map(opt).join('') + (extra.length ? `<optgroup label="그 밖의 AI (API)">${extra.map(opt).join('')}</optgroup>` : '');
}
$('addSeatBtn').addEventListener('click', () => {
  if (seats.length >= MAX_SEATS) return;
  saveOpts();
  const provider = $('addSeatSel').value;
  seats.push({ uid: newUid(provider), provider });
  renderParticipants();
  syncSg();
});
const selected = () => seats.filter((x) => ok(byId(x.uid))).map((x) => ({ ...byId(x.uid), id: x.uid, provider: x.provider, label: (byId(x.uid)?.label || x.provider) + seatNo(x.uid) }));
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
let cfgRoles = [], cfgTeams = [];
const seatHtml = (id, p, extra = '') => `<div class="seat idle ${extra}" data-seat="${id}" style="--c:${p.color}">
  <div class="seal">${p.hanja}</div>
  <div class="seat-name">${esc(p.name)}${byId(id) ? ` <small>${esc(byId(id).label)}</small>` : ''}</div>
  <div class="seat-title">${esc(p.title)}</div><div class="seat-state">${STATE.idle}</div></div>`;
function renderStage(ids) {
  const stage = $('stage');
  // 군의 장면은 캐릭터가 있는 기본 3 AI 만 앉힐 수 있다(다른 AI 가 있으면 보여 주지 않는다)
  stage.hidden = !sg || !ids.length || ids.some((id) => !byId(id)?.persona);
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
      el.textContent = ev.unlimited
        ? (sg ? `── 제${ev.round}차 군의(軍議) · 결단이 날 때까지 ──` : `── ${ev.round}라운드 · 합의될 때까지 ──`)
        : sg ? `── 제${ev.round}차 군의(軍議) · ${total}차 ──` : `── ${ev.round}라운드 / ${total}라운드 ──`;
      if (sg && ev.round > 1) document.querySelectorAll('.seat:not(.sage)').forEach((e) => seat(e.dataset.seat, 'idle'));
      feed.appendChild(el);
      break;
    }
    case 'thinking': {
      if (ev.round === 'judge') {
        seat(ev.who, 'speaking', '판정 중…');
        pending[`judge:${ev.who}`] = add(head(ev.who, ctx.labels[ev.who], '<small>합의 여부 판정 중</small>'), 'pending ' + provOf(ev.who));
        break;
      }
      if (ev.round === 'ratify') {
        seat(ev.who, 'speaking', '확인 중…');
        pending[`ratify:${ev.who}`] = add(head(ev.who, ctx.labels[ev.who], '<small>최종안 확인 중</small>'), 'pending ' + provOf(ev.who));
        break;
      }
      if (ev.who === 'sage') {
        seat('sage', 'thinking');
        pending['sage:sage'] = add(`<div class="msg-head"><span class="mini-seal" style="--c:${cfgSage.color}">${cfgSage.hanja}</span>${esc(cfgSage.name)} <small>책략 구상 중</small></div>`, 'pending sage-card');
        break;
      }
      const label = ctx.labels[ev.who];
      seat(ev.who, ev.round === 'final' ? 'speaking' : 'thinking');
      pending[key(ev.round, ev.who)] = add(head(ev.who, label, ev.round === 'final' ? '<small>결론 정리 중</small>' : '<small>생각 중</small>'), 'pending ' + provOf(ev.who));
      break;
    }
    case 'turn': {
      seat(ev.who, 'done');
      caption(ev.who, ev.text);
      const el = pending[key(ev.round, ev.who)] || add('', provOf(ev.who));
      el.className = 'msg ' + provOf(ev.who);
      el.style.borderLeftColor = colorOf(ev.who); // 기본 3 AI 외의 AI 도 색으로 구분
      el.innerHTML = head(ev.who, ev.label, `${roleBadge(ev)}${effortBadge(ev)}<small class="model" title="${ev.requested && ev.requested !== ev.model ? `선택한 ${esc(ev.requested)} 는 사용할 수 없어 대체했습니다` : ''}">${esc(ev.model || 'CLI 기본')}${ev.requested && ev.requested !== ev.model ? ` ← ${esc(ev.requested)} 대체` : ''}</small>`) + `<div class="msg-body">${md(ev.text)}</div>`;
      break;
    }
    case 'turn_error': {
      seat(ev.who, 'error');
      const el = pending[key(ev.round, ev.who)] || add('', '');
      el.className = 'msg err';
      el.innerHTML = head(ev.who, ev.label, `${roleBadge(ev)}<small>오류</small>`) + `<div>${esc(ev.error)}</div>`;
      break;
    }
    case 'final': {
      pending[key('final', ev.who)]?.remove();
      seat(ev.who, 'done');
      const badge = ev.consensus ? `<span class="verdict ${ev.consensus.reached ? 'yes' : 'no'}" ${ev.consensus.partial ? `title="호출에 실패해 입장을 확인하지 못한 참가자: ${esc(ev.consensus.missing.join(', '))}"` : ''}>${ev.consensus.reached ? `${ev.consensus.round}라운드 ${ev.consensus.partial ? '응답자 합의' : '합의'}` : '합의 못함'}</span>` : '';
      const absent = ev.missing?.length ? `<span class="verdict no" title="호출에 실패해 입장을 확인하지 못했습니다">불참: ${esc(ev.missing.join(', '))}</span>` : '';
      add(head('', sg ? '최종 결단(決斷)' : '최종 결론', `${badge}${absent}<small>${sg ? '주재' : '사회자'}: ${esc(nameOf(ev.who))}${ev.consensus && !ev.consensus.reached && ev.consensus.reason ? ` · ${esc(ev.consensus.reason)}` : ''}</small>`) + `<div class="msg-body">${md(ev.text)}</div>`, 'final');
      ctx.conclusion = ev.text;
      addSaveBar(ev.text);
      break;
    }
    case 'consensus': {
      pending[`judge:${ev.who}`]?.remove();
      seat(ev.who, 'done');
      const items = (ev.disagreements || []).map((d) => `<li>${esc(d)}</li>`).join('');
      add(`<div class="msg-head"><span class="verdict ${ev.reached ? 'yes' : 'no'}">${ev.pendingRatify ? '합의 후보' : ev.reached ? '합의' : '쟁점 남음'}</span>${sg ? '군의 판정' : '합의 판정'} <small>${esc(ev.round)}라운드 · ${esc(nameOf(ev.who))}</small></div>` +
        `<div class="msg-body"><p>${esc(ev.summary || '')}</p>${items ? `<p><b>남은 쟁점</b></p><ul>${items}</ul>` : ''}${ev.stalled ? '<p><i>지난 라운드와 입장이 거의 그대로입니다.</i></p>' : ''}${ev.contradiction ? '<p><i>판정이 합의라고 했지만 남은 쟁점이 있어 합의로 인정하지 않았습니다.</i></p>' : ''}${ev.pendingRatify ? '<p><i>참가자별 확인 투표로 최종 결정합니다.</i></p>' : ''}</div>`, 'consensus-card ' + (ev.reached ? 'reached' : 'open'));
      break;
    }
    case 'ratify': {
      Object.keys(pending).filter((k) => k.startsWith('ratify:')).forEach((k) => { pending[k].remove(); delete pending[k]; });
      for (const v of ev.votes) seat(v.who, 'done');
      const VOTE = { agree: ['동의', 'yes'], conditional: ['조건부', 'cond'], disagree: ['반대', 'no'], unknown: ['확인 못함', 'unk'] };
      const rows = ev.votes.map((v) => {
        const [txt, cls] = VOTE[v.vote] || VOTE.unknown;
        const note = v.vote === 'agree' ? '' : v.condition || v.reason;
        return `<li><span class="vote ${cls}">${txt}</span> <b>${esc(nameOf(v.who))}</b>${v.roleName ? ` <small>${esc(v.roleName)}</small>` : ''}${note ? ` — ${esc(note)}` : ''}</li>`;
      }).join('');
      add(`<div class="msg-head"><span class="verdict ${ev.reached ? 'yes' : 'no'}">${ev.reached ? (ev.missing?.length ? '응답자 전원 동의' : '전원 동의') : '합의 보류'}</span>최종안 확인 <small>${esc(ev.round)}라운드 · 서로의 답을 보지 않고 각자 투표</small></div>` +
        `<div class="msg-body"><p>${esc(ev.summary || '')}</p><ul class="votes">${rows}</ul>${ev.reached ? '' : '<p><i>동의하지 않은 쟁점을 안고 토론을 이어갑니다.</i></p>'}${ev.missing?.length ? `<p><i>호출에 실패한 ${esc(ev.missing.join(', '))} 의 입장은 확인되지 않았습니다.</i></p>` : ''}</div>`, 'consensus-card ' + (ev.reached ? 'reached' : 'open'));
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
    case 'budget': add(`<div class="msg-head">⚠️ 호출 상한 <small>${esc(ev.used)}/${esc(ev.max)}회</small></div><div class="msg-body"><p>${esc(ev.message)}</p></div>`, 'budget-card'); break;
    case 'usage': add(`AI 호출 ${esc(ev.calls)}${ev.maxCalls ? ` / 상한 ${esc(ev.maxCalls)}` : ''}회 사용`, 'minutes-note'); break;
    case 'minutes': add(`📝 회의록 저장됨: ${esc(ev.path)}`, 'minutes-note'); break;
    case 'done': ctx.done = true; break;
    case 'error': add(`<div>${esc(ev.error)}</div>`, 'err'); break;
  }
  feed.scrollTop = feed.scrollHeight;
}

// 결론을 폴더의 '결과물' 폴더에 파일로 저장 (새 파일로만, 덮어쓰지 않음)
function addSaveBar(text) {
  const el = document.createElement('div');
  el.className = 'save-bar';
  const base = (agenda || '회의결과').replace(/[\\/:*?"<>|\n]/g, ' ').slice(0, 30).trim() || '회의결과';
  el.innerHTML = `<span>💾 결과물로 저장</span><input type="text" class="sv-name" value="${esc(base)}" aria-label="파일 이름"><select class="sv-fmt" aria-label="형식"><option value="md">.md</option><option value="docx">.docx (워드)</option><option value="xlsx">.xlsx (엑셀, 표만)</option><option value="pptx">.pptx (파워포인트)</option><option value="html">.html</option><option value="txt">.txt</option><option value="csv">.csv</option></select><button type="button" class="sv-go">저장</button><span class="save-msg" role="status"></span>`;
  const msg = el.querySelector('.save-msg');
  el.querySelector('.sv-go').addEventListener('click', async () => {
    const dir = folderRoot || $('folderPath').value.trim();
    if (!dir) { msg.className = 'save-msg err'; msg.textContent = '먼저 📁 폴더에서 저장할 폴더를 지정하세요'; $('folderPanel').hidden = false; return; }
    try {
      const r = await postJson('/api/folder/save', { path: dir, name: el.querySelector('.sv-name').value, format: el.querySelector('.sv-fmt').value, content: text });
      msg.className = 'save-msg';
      msg.textContent = `저장했습니다: ${r.path}`;
    } catch (err) {
      msg.className = 'save-msg err';
      msg.textContent = err.message;
    }
  });
  feed.lastElementChild?.appendChild(el);
}

async function runMeeting(question) {
  const chosen = selected();
  if (!chosen.length) return add('<div>참가할 AI를 한 명 이상 선택하세요.</div>', 'err');

  add(esc(question) + (attachments.length ? `<div class="att-names">📎 ${attachments.map((a) => esc(a.name)).join(', ')}</div>` : ''), 'user');
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
        attachments: attachments.map(({ name, text }) => ({ name, text })),
        participants: chosen.map((p) => ({ id: p.id, model: modelValue(p.id), role: roleOf(p.id), effort: effortOf(p.id) })),
        mode,
        persona: sg,
        ...roundsBody(),
        moderator: $('moderator').value,
        maxCalls: Number($('maxCalls').value),
        saveMinutes: $('saveMinutes').checked,
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
    if (!ctx.done && !controller.signal.aborted) add('<div>연결이 끊겨 회의가 도중에 끝났을 수 있습니다. 위 기록은 그때까지의 내용입니다. (서버가 켜져 있다면 회의록 폴더에 기록이 남아 있을 수 있습니다)</div>', 'err');
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
  if (v === 'cinf') return { consensus: true, unlimited: true, rounds: 3 };
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
  attachments = [];
  renderAttachments();
  attachMsg('');
  controller?.abort();
  history = [];
  agenda = '의제를 올려 주세요';
  refreshStage();
  feed.innerHTML = '<div class="empty">새 회의를 시작합니다. 질문을 입력하세요.</div>';
});

function applyTheme() {
  document.body.classList.toggle('sg', sg);
  $('sg').checked = sgWanted;
  document.title = sg ? '桃園 · AI 군의' : 'AI 회의실';
  $('title').textContent = sg ? 'AI 도원결의' : 'AI 회의실';
  $('subtitle').textContent = sg ? '유비 · 관우 · 장비가 군의(軍議)를 열어 결단을 내립니다.' : 'GPT · Gemini · Claude가 함께 토론하고 결론을 정리합니다.';
  if (providers.length) { $('moderator').value = ''; renderParticipants(); }
}
// 삼국지 모드는 유비·관우·장비(AI 종류별 한 자리)만 있어서, 같은 AI 를 더 앉히면 쓸 수 없다.
const sgAllowed = () => seats.every((x) => x.uid === x.provider && byId(x.uid)?.persona);
function syncSg() {
  const allowed = sgAllowed();
  $('sg').disabled = !allowed;
  $('sg').closest('label').title = allowed ? '' : '같은 AI 를 여러 자리에 앉히면 삼국지 모드를 쓸 수 없습니다';
  const want = sgWanted && allowed;
  if (want !== sg) { sg = want; applyTheme(); }
}
$('sg').addEventListener('change', (e) => {
  sgWanted = e.target.checked;
  try { localStorage.setItem('sg', sgWanted ? '1' : '0'); } catch {}
  sg = sgWanted && sgAllowed();
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
  { // 서버의 기본 호출 상한(.env 의 MAX_CALLS)을 화면에 반영
    const sel = $('maxCalls');
    const want = String(cfg.defaultMaxCalls || 120);
    if (![...sel.options].some((o) => o.value === want)) {
      const o = new Option(`${want}회 (기본)`, want);
      const after = [...sel.options].find((x) => Number(x.value) > Number(want));
      sel.add(o, after || null);
    }
    sel.value = want;
    let off = false;
    try { off = localStorage.getItem('saveMinutes') === '0'; } catch {}
    $('saveMinutes').checked = cfg.minutesDefault !== false && !off;
  }
  cfgRoles = cfg.roles || [];
  cfgTeams = cfg.teams || [];
  renderTeams();
  setMode(cfg.defaultMode);
  applyTheme();
  syncSg();
  if (!providers.some((p) => p.apiConfigured || p.cliAvailable)) {
    add('<div>사용 가능한 AI가 없습니다. <code>.env</code> 에 API 키를 넣거나 claude / codex / gemini CLI를 설치·로그인하세요. (README 참고)</div>', 'err');
  }
});


// --- 시작 전 예상 호출 수/토큰 ---
let estTimer = null;
function scheduleEstimate() {
  clearTimeout(estTimer);
  estTimer = setTimeout(updateEstimate, 300);
}
async function updateEstimate() {
  const el = $('estimate');
  const n = selected().length;
  if (!n) { el.textContent = ''; return; }
  try {
    const maxCalls = Number($('maxCalls').value);
    const r = await postJson('/api/estimate', { n, ...roundsBody(), persona: sg, chars: qEl.value.length + totalChars(), maxCalls });
    const k = (x) => (x < 1000 ? `${x}` : x < 1e6 ? `${Math.round(x / 100) / 10}천` : `${Math.round(x / 1e5) / 10}백만`);
    const calls = r.calls.min === r.calls.max ? `<b>${r.calls.max}회</b>` : `<b>${r.calls.min}~${r.calls.max}회</b>`;
    el.className = 'estimate' + (r.calls.capped || r.calls.max >= 100 ? ' warn' : '');
    el.innerHTML = `예상 AI 호출 ${calls}${r.calls.capped ? ` (상한 ${maxCalls}회에서 멈춤)` : ''} · 입력 약 ${k(r.inputTokens.min)}${r.inputTokens.min === r.inputTokens.max ? '' : `~${k(r.inputTokens.max)}`} 토큰 <small>(대략, 첨부는 매번 다시 들어갑니다)</small>`;
  } catch {
    el.textContent = '';
  }
}
document.addEventListener('input', scheduleEstimate);
document.addEventListener('change', scheduleEstimate);

$('saveMinutes').addEventListener('change', () => { try { localStorage.setItem('saveMinutes', $('saveMinutes').checked ? '1' : '0'); } catch {} });
