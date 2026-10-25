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
  let tbl = null;
  const flushTable = () => {
    if (!tbl) return;
    const rows = tbl.filter((r) => !/^\s*\|?\s*:?-{2,}/.test(r)).map((r) => r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()));
    if (rows.length) out.push(`<div class="md-table"><table><thead><tr>${rows[0].map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.slice(1).map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
    tbl = null;
  };
  for (const line of text.split('\n')) {
    if (code === null && /^\s*\|.*\|\s*$/.test(line)) { closeList(); (tbl ||= []).push(line); continue; }
    flushTable();
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
  flushTable();
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
      if (/\.xlsx$/i.test(name)) { await openXlsxFile(file); continue; } // 시트·행·열을 고르는 창을 연다
      if (/\.pdf$/i.test(name)) text = await readPdf(file);
      else if (/\.docx$/i.test(name)) text = await readDocx(file);
      else if (TEXT_EXT.test(name) || file.type.startsWith('text/')) text = await readText(file);
      else throw new Error('지원하지 않는 형식입니다 (텍스트, 코드, CSV, JSON, PDF, docx 가능. 이미지·hwp 는 안 됩니다. 파워포인트는 폴더로 읽을 수 있습니다. 엑셀은 .xlsx 로 저장해 첨부하세요)');
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
    return `<label><input type="checkbox" data-f="${i}" ${fits ? 'checked' : ''}> ${esc(f.rel)} <i>${fmt(f.text.length)}자${f.truncated ? ' · 일부만' : ''}</i>${/\.xlsx$/i.test(f.rel) ? ` <button type="button" class="xl-pick" data-xlrel="${esc(f.rel)}">시트·행 고르기</button>` : ''}</label>`;
  }).join('') || '<span class="skip">읽을 수 있는 파일이 없습니다</span>';
  $('folderActions').hidden = !folderFiles.some((f) => f.ok);
  updateFolderInfo();
  $('folderList').querySelectorAll('[data-f]').forEach((c) => c.addEventListener('change', updateFolderInfo));
  $('folderList').querySelectorAll('[data-xlrel]').forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); openXlsxFolder(b.dataset.xlrel); }));
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
  return `<option value="">역할 없음</option>` + Object.entries(groups).map(([g, list]) => `<optgroup label="${esc(g)}">${list.map((r) => `<option value="${esc(r.id)}" title="${esc(r.view)}" ${r.id === selected ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</optgroup>`).join('');
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
const roleBadge = (ev) => (ev.roleName ? `<span class="role-badge">${esc(ev.roleName)}</span>` : '');
const effortBadge = (ev) => (ev.effort ? `<span class="effort-badge ${ev.effortApplied ? '' : 'off'}" title="${ev.effortApplied ? '이 호출에 적용됨' : '이 모델/방식은 생각 깊이 설정을 받지 않아 기본값으로 실행했습니다'}">깊이 ${EFFORT_LABEL[ev.effort]}${ev.effortApplied ? '' : ' (미적용)'}</span>` : '');

function renderTeams() {
  const groups = {};
  for (const t of cfgTeams) (groups[t.group || '기타'] ||= []).push(t);
  const roleNames = (t) => t.roles.map((r) => cfgRoles.find((x) => x.id === r)?.name || r).join(' · ');
  $('team').innerHTML = `<option value="">직접 선택</option>` +
    Object.entries(groups).map(([g, list]) => `<optgroup label="${esc(g)}">${list.map((t) => `<option value="${esc(t.id)}" title="${esc(roleNames(t))}">${esc(t.name)} (${t.roles.length}명)</option>`).join('')}</optgroup>`).join('') +
    `<option value="__clear">역할 모두 해제</option>`;
}
// 팀을 고르면 참가자 자리를 팀 인원수만큼 새로 구성하고 역할을 배정한다. 각 자리에 앉힐 AI 는 "AI 배정"에서 정한 방식을 따른다.
$('team').addEventListener('change', () => {
  const v = $('team').value;
  if (!v) return;
  saveOpts();
  if (v === '__clear') {
    for (const x of seats) partState[x.uid] = { ...(partState[x.uid] || {}), role: '' };
  } else {
    const team = cfgTeams.find((t) => t.id === v);
    if (team) {
      const roles = team.roles.slice(0, MAX_SEATS);
      const list = assignProviders(roles.length);
      const next = {};
      seats = [];
      roles.forEach((role, i) => {
        const provider = list[i];
        const uid = newUid(provider);
        seats.push({ uid, provider });
        next[uid] = { ...(partState[uid] || {}), role };
      });
      for (const k of Object.keys(partState)) delete partState[k];
      Object.assign(partState, next);
    }
  }
  $('team').value = '';
  { const t = cfgTeams.find((x) => x.id === v); if (t?.form && $('agendaForm')) { $('agendaForm').value = t.form; renderAgenda(true); } }
  renderParticipants(true); // 방금 정한 역할을 이전 화면 값으로 덮어쓰지 않는다
  syncSg();
});

// --- AI 배정: 팀을 고를 때(또는 "다시 배정") 자리마다 어떤 AI 를 앉힐지. 전부 한 AI / 반반 / 돌아가며 ---
const CORE = ['gpt', 'gemini', 'claude'];
const assignPool = () => {
  const core = providers.filter((p) => CORE.includes(p.id) && ok(p));
  return core.length ? core : providers.filter(ok).length ? providers.filter(ok) : providers;
};
function renderAssign() {
  const usable = providers.filter(ok);
  const prev = { a: $('assign').value, ha: $('halfA').value, hb: $('halfB').value };
  const pool = assignPool();
  $('assign').innerHTML = `<option value="rr">골고루 돌아가며 (${esc(pool.map((p) => p.label).join('·'))})</option>` +
    usable.map((p) => `<option value="all:${p.id}">전부 ${esc(p.label)}</option>`).join('') +
    (usable.length >= 2 ? '<option value="half">반반 (두 AI 선택)</option>' : '');
  if ([...$('assign').options].some((o) => o.value === prev.a)) $('assign').value = prev.a;
  const opts = usable.map((p) => `<option value="${p.id}">${esc(p.label)}</option>`).join('');
  $('halfA').innerHTML = opts;
  $('halfB').innerHTML = opts;
  $('halfA').value = usable.some((p) => p.id === prev.ha) ? prev.ha : usable[0]?.id || '';
  $('halfB').value = usable.some((p) => p.id === prev.hb) ? prev.hb : (usable[1] || usable[0])?.id || '';
  $('halfRow').hidden = $('assign').value !== 'half';
}
function assignProviders(n) {
  const v = $('assign').value;
  if (v.startsWith('all:')) return Array(n).fill(v.slice(4));
  if (v === 'half') {
    const half = Math.ceil(n / 2);
    return Array.from({ length: n }, (_, i) => (i < half ? $('halfA').value : $('halfB').value));
  }
  const pool = assignPool();
  return Array.from({ length: n }, (_, i) => pool[i % pool.length].id);
}
// "AI 배정"을 바꾸면 지금 앉아 있는 참가자들에게도 바로 적용한다(역할·생각 깊이는 유지).
$('assign').addEventListener('change', () => { $('halfRow').hidden = $('assign').value !== 'half'; reassignSeats(); });
$('halfA').addEventListener('change', reassignSeats);
$('halfB').addEventListener('change', reassignSeats);
$('reassign').addEventListener('click', reassignSeats);
// 지금 참가자들의 역할·생각 깊이는 그대로 두고 AI 만 다시 앉힌다.
function reassignSeats() {
  if (!seats.length) return;
  saveOpts();
  const list = assignProviders(seats.length);
  const old = seats;
  const next = {};
  seats = [];
  old.forEach((s0, i) => {
    const provider = list[i];
    const uid = newUid(provider);
    seats.push({ uid, provider });
    const st = partState[s0.uid] || {};
    next[uid] = { role: st.role, effort: st.effort, model: provider === s0.provider ? st.model : '', custom: provider === s0.provider ? st.custom : '' };
  });
  for (const k of Object.keys(partState)) delete partState[k];
  Object.assign(partState, next);
  renderParticipants(true);
  syncSg();
}
// 자리 하나의 AI 를 바꾼다(역할·생각 깊이는 유지, 모델은 AI 가 달라지므로 자동으로).
function changeProvider(uid, provider) {
  saveOpts();
  const idx = seats.findIndex((x) => x.uid === uid);
  if (idx < 0) return;
  const st = partState[uid] || {};
  seats.splice(idx, 1);
  const nu = newUid(provider);
  seats.splice(idx, 0, { uid: nu, provider });
  delete partState[uid];
  partState[nu] = { role: st.role, effort: st.effort, model: '', custom: '' };
  renderParticipants(true);
  syncSg();
}

const MAX_SEATS = 8;
function newUid(provider) {
  if (!seats.some((x) => x.uid === provider)) return provider;
  for (let n = 2; ; n++) if (!seats.some((x) => x.uid === `${provider}-${n}`)) return `${provider}-${n}`;
}
// 처음 자리: 기본 3 AI(GPT·Gemini·Claude) 중 쓸 수 있는 것. 하나도 없으면 쓸 수 있는 다른 AI(최대 3), 그것도 없으면 기본 3.
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
        <select class="seat-ai" data-ai="${seat.uid}" aria-label="${esc(nameOf(seat.uid))} 의 AI" title="이 자리의 AI 바꾸기">${providers.map((q) => `<option value="${q.id}" ${q.id === seat.provider ? 'selected' : ''}>${esc(q.label)}${ok(q) ? '' : ' (설정 필요)'}</option>`).join('')}</select>
        ${seats.length > 1 ? `<button type="button" class="seat-rm" data-rm="${seat.uid}" aria-label="${esc(nameOf(seat.uid))} 빼기" title="이 참가자 빼기">×</button>` : ''}</div>
      ${modelSelectHtml(seat, p)}
      ${p.hint ? `<div class="p-hint">${esc(p.hint)}</div>` : ''}
      ${optsHtml(seat, p)}
      ${ok(p) ? '' : `<div class="p-warn">${warnText(p)} (이 자리는 건너뜁니다)</div>`}`;
    box.appendChild(card);
  }
  box.querySelectorAll('select[data-role], select[data-effort], select[data-modelsel]').forEach((x) => x.addEventListener('change', saveOpts));
  box.querySelectorAll('input[data-model]').forEach((x) => x.addEventListener('input', saveOpts));
  box.querySelectorAll('select[data-ai]').forEach((x) => x.addEventListener('change', () => changeProvider(x.dataset.ai, x.value)));
  box.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => { saveOpts(); seats = seats.filter((x) => x.uid !== b.dataset.rm); delete partState[b.dataset.rm]; renderParticipants(); syncSg(); }));
  renderAddSeat();
  renderAssign();
  wireModelSelects();
  renderModerator();
  refreshOffice();
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
  if (/\bpending\b/.test(cls)) { // 응답을 기다리는 카드: 경과 시간을 보여 준다
    el.dataset.start = String(Date.now());
    const sm = el.querySelector('.msg-head small');
    if (sm) el.dataset.label = sm.textContent;
  }
  feed.querySelector('.empty')?.remove();
  feed.appendChild(el);
  feed.scrollTop = feed.scrollHeight;
  return el;
}
// 응답이 오래 걸리는 AI 를 알아볼 수 있게, 기다리는 카드의 경과 시간을 1초마다 갱신한다(60초가 넘으면 강조).
setInterval(() => {
  const now = Date.now();
  feed.querySelectorAll('.msg.pending[data-start]').forEach((el) => {
    const sm = el.querySelector('.msg-head small');
    if (!sm) return;
    const sec = Math.floor((now - Number(el.dataset.start)) / 1000);
    sm.textContent = `${el.dataset.label || '생각 중'} · ${sec}초${sec >= 60 ? ' (오래 걸리는 중)' : ''}`;
    el.classList.toggle('slow', sec >= 60);
  });
}, 1000);
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
  officeEvent(ev);
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
      if (ev.round === 'premortem') {
        pending['premortem'] = add(head(ev.who, ctx.labels[ev.who], '<small>사전 부검 작성 중</small>'), 'pending ' + provOf(ev.who));
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
    case 'premortem': {
      pending['premortem']?.remove();
      add(`<div class="msg-head"><span class="verdict no">사전 부검</span>이 결정이 실패한다면 <small>${esc(ev.label)} · AI 의 가정이며 사실 확인이 끝난 내용이 아닙니다</small></div><div class="msg-body">${md(ev.text)}</div>`, 'premortem-card');
      break;
    }
    case 'premortem_error': pending['premortem']?.remove(); add(`사전 부검을 하지 못했습니다: ${esc(ev.error)}`, 'minutes-note'); break;
    case 'budget': add(`<div class="msg-head">호출 상한 <small>${esc(ev.used)}/${esc(ev.max)}회</small></div><div class="msg-body"><p>${esc(ev.message)}</p></div>`, 'budget-card'); break;
    case 'usage': add(`AI 호출 ${esc(ev.calls)}${ev.maxCalls ? ` / 상한 ${esc(ev.maxCalls)}` : ''}회 사용`, 'minutes-note'); break;
    case 'meeting': meetingId = ev.id; break;
    case 'interject': add(`<div class="msg-head">진행자(나)의 한마디</div><div class="msg-body">${md(ev.text)}</div>`, 'user interject'); break;
    case 'wrapup': add('진행자가 결론 정리를 요청했습니다. 진행 중인 라운드가 끝나면 지금까지의 토론으로 결론을 정리합니다.', 'minutes-note'); break;
    case 'redaction': add(`개인정보 ${esc(ev.total)}건을 가려서 AI 에 보냈습니다 (${Object.entries(ev.counts).map(([k, v]) => `${esc(k)} ${esc(v)}`).join(', ')})`, 'minutes-note redaction-note'); break;
    case 'minutes': add(`회의록 저장됨: ${esc(ev.path)}`, 'minutes-note'); break;
    case 'done': ctx.done = true; notifyEnd(ctx); break;
    case 'error': add(`<div>${esc(ev.error)}</div>`, 'err'); break;
  }
  feed.scrollTop = feed.scrollHeight;
}

// 결론을 폴더의 '결과물' 폴더에 파일로 저장 (새 파일로만, 덮어쓰지 않음)
function addSaveBar(text) {
  const el = document.createElement('div');
  el.className = 'save-bar';
  const base = (agenda || '회의결과').replace(/[\\/:*?"<>|\n]/g, ' ').slice(0, 30).trim() || '회의결과';
  el.innerHTML = `<span>결과물로 저장</span><input type="text" class="sv-name" value="${esc(base)}" aria-label="파일 이름"><select class="sv-fmt" aria-label="형식"><option value="md">.md</option><option value="docx">.docx (워드)</option><option value="xlsx">.xlsx (엑셀, 표만)</option><option value="pptx">.pptx (파워포인트)</option><option value="html">.html</option><option value="txt">.txt</option><option value="csv">.csv</option></select><button type="button" class="sv-go">저장</button><span class="save-msg" role="status"></span>`;
  const msg = el.querySelector('.save-msg');
  el.querySelector('.sv-go').addEventListener('click', async () => {
    const dir = folderRoot || $('folderPath').value.trim();
    if (!dir) { msg.className = 'save-msg err'; msg.textContent = '먼저 폴더에서 저장할 폴더를 지정하세요'; $('folderPanel').hidden = false; return; }
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

// 회의 끝 알림: 다른 창에서 일하는 동안에도 알 수 있게 소리, 탭 제목 깜박임, (허락했다면) 브라우저 알림을 쓴다.
const baseTitle = document.title;
let blinkTimer = null;
function stopBlink() { clearInterval(blinkTimer); blinkTimer = null; document.title = baseTitle; }
document.addEventListener('visibilitychange', () => { if (!document.hidden) stopBlink(); });
window.addEventListener('focus', stopBlink);
function beep() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ac = new AC();
    [660, 880].forEach((hz, i) => {
      const o = ac.createOscillator(), g = ac.createGain();
      o.frequency.value = hz; o.connect(g); g.connect(ac.destination);
      const t = ac.currentTime + i * 0.18;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.15, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      o.start(t); o.stop(t + 0.18);
    });
    setTimeout(() => ac.close().catch(() => {}), 800);
  } catch {}
}
function notifyEnd(ctx) {
  if (!$('notifyEnd').checked || ctx.notified) return;
  ctx.notified = true;
  beep();
  if (document.hidden) {
    let on = false;
    stopBlink();
    blinkTimer = setInterval(() => { document.title = (on = !on) ? '✅ 회의가 끝났습니다' : baseTitle; }, 900);
    try { if ('Notification' in window && Notification.permission === 'granted') new Notification('AI 회의실', { body: '회의가 끝났습니다. 결론을 확인하세요.' }); } catch {}
  }
}
try { $('notifyEnd').checked = localStorage.getItem('notifyEnd') !== '0'; } catch {}
$('notifyEnd').addEventListener('change', () => {
  try { localStorage.setItem('notifyEnd', $('notifyEnd').checked ? '1' : '0'); } catch {}
  if ($('notifyEnd').checked) { beep(); try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch {} }
});

async function runMeeting(question) {
  const chosen = selected();
  if (!chosen.length) return add('<div>참가할 AI를 한 명 이상 선택하세요.</div>', 'err');

  add(esc(question) + (attachments.length ? `<div class="att-names">첨부: ${attachments.map((a) => esc(a.name)).join(', ')}</div>` : ''), 'user');
  setBusy(true);
  controller = new AbortController();
  const ctx = { labels: {}, conclusion: null };
  agenda = question.length > 70 ? question.slice(0, 70) + '…' : question;
  refreshStage();
  officeBegin();
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
        premortem: $('premortem').checked,
        ...roundsBody(),
        moderator: $('moderator').value,
        maxCalls: Number($('maxCalls').value),
        saveMinutes: $('saveMinutes').checked,
        useProfile: $('useProfile').checked,
        redact: redactBody(),
        pinned: pinned.map(({ question, conclusion }) => ({ question, conclusion })),
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
    officeEnd(Boolean(ctx.done));
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

// 회의 중에는 입력칸이 "끼어들기"로 바뀐다: 쓴 말은 다음 라운드와 최종 결론에 반영되고, "여기서 결론"은 토론을 마무리해 달라는 요청이다.
let meetingId = null, meetingRunning = false;
const PLACEHOLDER = qEl.placeholder;
function setBusy(b) {
  meetingRunning = b;
  sendBtn.hidden = false;
  sendBtn.textContent = b ? '끼어들기' : '회의 소집';
  stopBtn.hidden = !b;
  $('wrap').hidden = !b;
  $('wrap').disabled = false;
  $('wrap').textContent = '여기서 결론';
  qEl.disabled = false;
  qEl.placeholder = b ? '회의 중에 한마디 하기 (Ctrl/⌘+Enter). 다음 라운드와 최종 결론에 반영됩니다' : PLACEHOLDER;
  if (!b) { meetingId = null; qEl.focus(); }
}
async function say(body) {
  if (!meetingId) throw new Error('회의가 막 시작되는 중입니다. 잠시 뒤에 다시 시도하세요');
  return postJson('/api/council/say', { id: meetingId, ...body });
}
$('wrap').addEventListener('click', async () => {
  $('wrap').disabled = true;
  try { await say({ wrapUp: true }); $('wrap').textContent = '결론 요청함'; } catch (e) { $('wrap').disabled = false; add(`<div>${esc(e.message)}</div>`, 'err'); }
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (meetingRunning) {
    const t = qEl.value.trim();
    if (!t) return;
    try { await say({ text: t }); qEl.value = ''; } catch (err) { add(`<div>${esc(err.message)}</div>`, 'err'); }
    return;
  }
  const q = buildQuestion(qEl.value.trim());
  if (!q) return;
  if (!precheck()) return;
  qEl.value = '';
  clearAgendaValues();
  $('agendaBox').open = false; // 보낸 뒤에는 접어서 화면을 넓게 쓴다
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
  pinned = [];
  renderChips();
  agenda = '의제를 올려 주세요';
  refreshStage();
  feed.innerHTML = '<div class="empty">새 회의를 시작합니다. 질문을 입력하세요.</div>';
  officeEnd(false, true);
});

function applyTheme() {
  document.body.classList.toggle('sg', sg);
  refreshOffice();
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
  profileTemplate = cfg.profileTemplate || '';
  loadForms(cfg.forms);
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
    const r = await postJson('/api/estimate', { n, ...roundsBody(), persona: sg, premortem: $('premortem').checked, chars: qEl.value.length + totalChars() + agendaChars() + profileChars() + pinned.reduce((n, p) => n + p.conclusion.length, 0), maxCalls });
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

// --- 사무실: 픽셀 오피스(pixel-office.js). 참가자가 책상에서 일하다가 소집되면 회의실로 걸어가 토론한다 ---
// 토론 원문은 회의록에 저장하고, 화면에는 누가 지금 어떤 상태인지와 결론만 보여 준다("토론 내용 보기"로 원문도 볼 수 있다).
let officeBusy = false, officeTimer = null, officeMeeting = [], po = null, officeView = true;
const roleLabel = (uid) => cfgRoles.find((r) => r.id === (roleOf(uid) || partState[uid]?.role))?.name || '';
const getPO = () => po || (po = window.PixelOffice.create($('officeStage')));
// 넓은 화면은 왼쪽 칸 전체를 사무실이 채우도록 칸 크기를 알려 준다(좁은 화면은 null).
const wideLayout = () => window.matchMedia('(min-width: 1101px)').matches;
function stageBox() {
  if (!wideLayout()) return null;
  const r = $('officeBox').getBoundingClientRect();
  return r.width > 50 && r.height > 50 ? { w: r.width, h: r.height } : null;
}
let resizeTimer = 0;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (!officeBusy) refreshOffice(); }, 200); });
function refreshOffice() {
  $('office').hidden = sg;
  document.body.classList.toggle('office-on', !sg && officeView);
  if (sg || officeBusy || !window.PixelOffice) return;
  const ids = seats.map((x) => x.uid).filter((id) => byId(id));
  getPO().setAgents(ids.map((uid, i) => ({ uid, name: nameOf(uid), role: roleLabel(uid), color: colorOf(uid), look: i })), stageBox());
  if (!officeMeeting.length) officeStatusText(ids.length ? `${ids.length}명이 자리에서 일하고 있습니다. 질문을 입력하고 회의를 소집하세요.` : '');
}
const officeStatusText = (t) => { $('officeStatus').textContent = t; $('liveDot').classList.toggle('on', officeBusy); };
const officeSay = (uid, text) => {
  const el = $('officeCaption');
  const plain = String(text).replace(/[#*`>\-|]/g, ' ').replace(/\s+/g, ' ').trim();
  el.hidden = !plain;
  el.style.setProperty('--c', colorOf(uid));
  el.innerHTML = `<b>${esc(nameOf(uid))}${roleLabel(uid) ? ` (${esc(roleLabel(uid))})` : ''}</b>${esc(plain.length > 110 ? plain.slice(0, 110) + '…' : plain)}`;
};
// 말풍선용 짧은 문장(첫 문장, 최대 30자)
const shortLine = (text) => {
  const lines = String(text).split(/\n/).map((l) => l.replace(/[#*`>|]/g, ' ').replace(/^[\s\-]+/, '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  const first = (lines[0] || '').split(/(?<=[.!?。])\s/)[0];
  return first.length > 24 ? first.slice(0, 24) + '…' : first;
};
function officeBegin() {
  clearTimeout(officeTimer);
  officeBusy = false;
  refreshOffice();
  officeBusy = true;
  officeMeeting = [];
  $('officeCaption').hidden = true;
  officeStatusText('회의를 소집하는 중…');
}
function officeEnd(finished, instant) {
  clearTimeout(officeTimer);
  const back = () => {
    officeBusy = false;
    if (po) { po.clearBubbles(); po.setRoomLabel(''); po.disperse(); }
    officeMeeting = [];
    $('officeCaption').hidden = true;
    officeStatusText('각자 자리로 돌아가 일하고 있습니다.');
  };
  if (!officeMeeting.length) { back(); return; }
  officeStatusText(finished ? '회의가 끝났습니다. 결론을 확인하세요. 잠시 후 각자 자리로 돌아갑니다.' : '회의가 중단되어 자리로 돌아갑니다.');
  if (instant) back(); else officeTimer = setTimeout(back, finished ? 3500 : 800);
}
function officeEvent(ev) {
  if (sg || !officeBusy || !po) return;
  switch (ev.type) {
    case 'start':
      officeMeeting = ev.participants.map((p) => p.id);
      po.gather(officeMeeting);
      officeStatusText('회의실로 이동해 회의를 시작합니다.');
      break;
    case 'round':
      po.clearBubbles();
      po.setRoomLabel(`${ev.round}라운드`);
      officeStatusText(`${ev.round}라운드: 각자 의견을 정리하는 중`);
      break;
    case 'thinking':
      if (ev.round === 'judge') officeStatusText('합의가 됐는지 판정하는 중');
      else if (ev.round === 'ratify') officeStatusText('최종안에 동의하는지 각자 확인하는 중');
      else if (ev.round === 'final') officeStatusText('사회자가 결론을 정리하는 중');
      po.bubble(ev.who, '...');
      break;
    case 'turn': po.talk(ev.who, shortLine(ev.text)); officeSay(ev.who, ev.text); officeStatusText(`${nameOf(ev.who)} 발언`); break;
    case 'turn_error': po.bubble(ev.who, '응답 실패', 6000); break;
    case 'consensus':
      po.bubble(ev.who, ev.reached ? '합의 후보' : '쟁점이 남았어요', 4000);
      officeStatusText(ev.reached ? '합의 후보가 나왔습니다' : `쟁점이 남아 토론을 이어갑니다 (${(ev.disagreements || []).length}건)`);
      break;
    case 'ratify':
      for (const v of ev.votes) {
        const agree = v.vote === 'agree';
        po.bubble(v.who, { agree: '동의', conditional: '조건부 동의', disagree: '반대', unknown: '...' }[v.vote] || '...', 5000);
        po.hand(v.who, agree, 5000);
      }
      officeStatusText(ev.reached ? '전원 동의' : '합의 보류');
      break;
    case 'final': po.talk(ev.who, '결론을 정리했어요', 3000); officeStatusText(ev.consensus && !ev.consensus.reached ? '결론을 정리했습니다 (합의는 못 했습니다)' : '결론이 나왔습니다'); break;
    case 'interject': officeStatusText('진행자(나)가 끼어들었습니다. 다음 라운드와 결론에 반영됩니다'); { const c = $('officeCaption'); c.hidden = false; c.style.setProperty('--c', 'var(--accent)'); c.innerHTML = `<b>진행자(나)</b>${esc(String(ev.text).replace(/\s+/g, ' ').slice(0, 110))}`; } break;
    case 'wrapup': officeStatusText('진행자가 결론 정리를 요청했습니다. 이번 라운드가 끝나면 마무리합니다'); break;
    case 'budget': officeStatusText('AI 호출 상한에 닿아 지금까지의 토론으로 결론을 정리합니다'); break;
  }
}
// 넓은 화면은 오른쪽 칸에 토론 전체를 보여 주는 것이 기본, 좁은 화면은 결론만 보여 주는 것이 기본
officeView = !wideLayout();
try { const v = localStorage.getItem('officeView'); if (v === '1') officeView = true; else if (v === '0') officeView = false; } catch {}
function applyView() {
  document.body.classList.toggle('office-on', !sg && officeView);
  $('viewToggle').textContent = officeView ? '토론 내용 보기' : '토론 내용 숨기기';
}
$('viewToggle').addEventListener('click', () => {
  officeView = !officeView;
  try { localStorage.setItem('officeView', officeView ? '1' : '0'); } catch {}
  applyView();
  if (!officeView) feed.scrollTop = 0; // 토론 내용을 펼치면 처음부터 읽을 수 있게
});
applyView();

// --- 안건 양식: 판단에 필요한 정보를 칸에 적으면 질문으로 조립한다. 빈 칸은 "미확인". ---
let cfgForms = [];
const curForm = () => cfgForms.find((f) => f.id === $('agendaForm').value);
function renderAgenda(open) {
  const f = curForm();
  const box = $('agendaFields');
  box.innerHTML = f ? f.fields.map((x, i) => `<label class="agenda-field"><span>${esc(x.label)}</span><input type="text" data-af="${i}" placeholder="${esc(x.placeholder || '')}" autocomplete="off"></label>`).join('') : '';
  $('agendaBox').classList.toggle('has-form', Boolean(f));
  if (open && f) $('agendaBox').open = true;
  if (!f) $('agendaBox').open = false;
  box.querySelectorAll('input').forEach((i) => i.addEventListener('input', scheduleEstimate));
  scheduleEstimate();
}
const agendaValues = () => [...$('agendaFields').querySelectorAll('input')].map((i) => i.value.trim());
const agendaChars = () => (curForm() ? agendaValues().join('').length + 80 : 0);
function clearAgendaValues() { $('agendaFields').querySelectorAll('input').forEach((i) => { i.value = ''; }); }
function buildQuestion(ask) {
  const f = curForm();
  if (!f) return ask;
  const vals = agendaValues();
  if (!ask && !vals.some(Boolean)) return '';
  const lines = f.fields.map((x, i) => `- ${x.label}: ${vals[i] || '미확인'}`);
  return `[안건: ${f.name}]\n${lines.join('\n')}\n(미확인 항목은 없는 것이 아니라 아직 확인되지 않은 정보입니다. 추측으로 채우지 말고, 결론에서 확인이 필요한 사항으로 정리해 주세요.)\n\n[질문]\n${ask || f.ask}`;
}
// 사전 점검: AI 를 부르기 전에 안건 양식의 빈 칸을 알려 준다. 앞쪽 세 칸(핵심)이 비었거나 절반 넘게 비면 확인을 받는다.
function precheck() {
  const f = curForm();
  if (!f) return true;
  const vals = agendaValues();
  const blanks = f.fields.filter((_, i) => !vals[i]).map((x) => x.label);
  if (!blanks.length) return true;
  const keyBlank = f.fields.slice(0, 3).filter((_, i) => !vals[i]).map((x) => x.label);
  if (!keyBlank.length && blanks.length * 2 <= f.fields.length) return true;
  const ok = confirm(`안건 양식에 비어 있는 칸이 ${blanks.length}개 있습니다.\n\n- ${blanks.join('\n- ')}\n\n비운 칸은 "미확인"으로 전달되어 AI 가 추측하지 않고 확인 필요 사항으로 정리합니다. AI 호출 비용이 드는 회의이니, 아는 값은 채우고 시작하는 편이 좋습니다.\n\n이대로 시작할까요? (취소하면 입력창으로 돌아갑니다)`);
  if (!ok) { qEl.value = qEl.value || ''; $('agendaBox').open = true; $('agendaFields').querySelector('input:placeholder-shown, input')?.focus(); }
  return ok;
}
$('agendaForm').addEventListener('change', () => renderAgenda(true));
$('agendaForm').addEventListener('click', (e) => e.stopPropagation());
function loadForms(list) {
  cfgForms = list || [];
  $('agendaForm').innerHTML = '<option value="">안건 양식: 없음</option>' + cfgForms.map((f) => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join('');
  $('agendaBox').hidden = !cfgForms.length;
}

// --- 백업·옮기기 ---
$('backupUp').addEventListener('click', () => $('backupFile').click());
$('backupFile').addEventListener('change', async () => {
  const f = $('backupFile').files[0];
  $('backupFile').value = '';
  const msg = $('backupMsg');
  if (!f) return;
  msg.textContent = '불러오는 중…';
  try {
    const r = await fetch('/api/backup/restore', { method: 'POST', headers: { 'content-type': 'application/zip' }, body: f });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    const prof = { restored: '회사 정보를 가져왔습니다', kept: '회사 정보는 이미 있어 덮어쓰지 않았습니다(백업 파일 안에 남아 있습니다)', same: '회사 정보는 같습니다', rejected: '회사 정보를 가져오지 못했습니다', none: '' }[d.profile] || '';
    msg.textContent = `회의록 ${d.added}건을 가져왔습니다${d.existing ? ` (이미 있어 건너뜀 ${d.existing}건)` : ''}${d.rejected ? ` · 읽지 못한 파일 ${d.rejected}건` : ''}. ${prof}`;
    if (d.profile === 'restored') { const p = await (await fetch('/api/profile')).json(); $('profileText').value = p.text || ''; profileState(); }
  } catch (err) {
    msg.textContent = `불러오지 못했습니다: ${err.message}`;
  }
});

// --- 회사 정보 ---
let profileTemplate = '';
const profileChars = () => ($('useProfile').checked ? Math.min(8000, $('profileText').value.length) : 0);
function profileState() {
  const n = $('profileText').value.trim().length;
  $('profileState').textContent = n ? `(${n.toLocaleString()}자${$('useProfile').checked ? ', 사용 중' : ', 사용 안 함'})` : '(비어 있음)';
}
async function loadProfile() {
  try { const r = await fetch('/api/profile'); const d = await r.json(); $('profileText').value = d.text || ''; } catch {}
  try { $('useProfile').checked = localStorage.getItem('useProfile') !== '0'; } catch {}
  profileState();
}
$('profileSave').addEventListener('click', async () => {
  try {
    const r = await postJson('/api/profile', { text: $('profileText').value });
    $('profileText').value = r.text;
    $('profileMsg').textContent = r.text ? '저장했습니다. 다음 회의부터 자료로 첨부됩니다.' : '비워서 저장했습니다. 회사 정보를 쓰지 않습니다.';
  } catch (e) { $('profileMsg').textContent = '저장 실패: ' + e.message; }
  profileState(); scheduleEstimate();
});
$('profileTemplate').addEventListener('click', () => {
  if ($('profileText').value.trim() && !confirm('지금 적어 둔 내용을 예시로 바꿉니다. 계속할까요?')) return;
  $('profileText').value = profileTemplate;
  $('profileMsg').textContent = '예시를 넣었습니다. 괄호 부분을 고친 뒤 저장하세요.';
  profileState();
});
$('useProfile').addEventListener('change', () => { try { localStorage.setItem('useProfile', $('useProfile').checked ? '1' : '0'); } catch {} profileState(); scheduleEstimate(); });
$('profileText').addEventListener('input', profileState);
loadProfile();

// --- 개인정보 보호 ---
const RD_KEYS = ['phone', 'rrn', 'email', 'account', 'plate'];
function redactBody() {
  const categories = {};
  document.querySelectorAll('[data-rd]').forEach((c) => { if (!c.checked) categories[c.dataset.rd] = false; });
  return { enabled: $('redactOn').checked, categories, names: $('redactNames').value.split('\n').map((x) => x.trim()).filter(Boolean) };
}
function privacyState() {
  const n = $('redactNames').value.split('\n').filter((x) => x.trim()).length;
  $('privacyState').textContent = $('redactOn').checked ? `(켜짐${n ? `, 이름 ${n}개` : ''})` : '(꺼짐)';
}
function savePrivacy() {
  try { localStorage.setItem('redact', JSON.stringify({ on: $('redactOn').checked, cats: RD_KEYS.filter((k) => !document.querySelector(`[data-rd=${k}]`).checked), names: $('redactNames').value })); } catch {}
  privacyState();
}
(function loadPrivacy() {
  try {
    const v = JSON.parse(localStorage.getItem('redact') || 'null');
    if (v) { $('redactOn').checked = v.on !== false; (v.cats || []).forEach((k) => { const c = document.querySelector(`[data-rd=${k}]`); if (c) c.checked = false; }); $('redactNames').value = v.names || ''; }
  } catch {}
  privacyState();
})();
$('redactOn').addEventListener('change', savePrivacy);
document.querySelectorAll('[data-rd]').forEach((c) => c.addEventListener('change', savePrivacy));
$('redactNames').addEventListener('input', savePrivacy);
$('redactPreviewBtn').addEventListener('click', async () => {
  const box = $('redactPreview');
  box.textContent = '확인하는 중…';
  try {
    const r = await postJson('/api/redact/preview', {
      question: buildQuestion(qEl.value.trim()) || qEl.value,
      attachments: attachments.map(({ name, text }) => ({ name, text })),
      useProfile: $('useProfile').checked,
      pinned: pinned.map(({ question, conclusion }) => ({ question, conclusion })),
      redact: redactBody(),
    });
    const rep = r.report;
    if (!$('redactOn').checked) { box.textContent = '가리기가 꺼져 있어 원문이 그대로 전송됩니다.'; return; }
    if (!rep.total) { box.textContent = '가릴 개인정보를 찾지 못했습니다. (주소와 목록에 없는 이름은 찾지 못합니다)'; return; }
    box.innerHTML = `<b>${esc(rep.total)}건</b>을 가려서 보냅니다: ${Object.entries(rep.counts).map(([k, v]) => `${esc(k)} ${esc(v)}`).join(', ')}<ul>${rep.samples.map((x) => `<li><small>${esc(x.type)}</small> <s>${esc(x.before)}</s> → <b>${esc(x.after)}</b></li>`).join('')}</ul>`;
  } catch (e) { box.textContent = '미리보기 실패: ' + e.message; }
});

// --- 지난 회의: 저장된 회의록을 찾아 이번 회의에 맥락으로 연결 ---
let pinned = []; // { id, title, question, conclusion }
function renderChips() {
  const box = $('ctxChips');
  box.hidden = !pinned.length;
  box.innerHTML = pinned.map((p, i) => `<span class="ctx-chip" title="${esc(p.question.slice(0, 200))}">이어 가는 회의: <b>${esc(p.title)}</b><button type="button" data-unpin="${i}" aria-label="${esc(p.title)} 연결 해제">×</button></span>`).join('');
  box.querySelectorAll('[data-unpin]').forEach((b) => b.addEventListener('click', () => { pinned.splice(Number(b.dataset.unpin), 1); renderChips(); scheduleEstimate(); }));
  scheduleEstimate();
}
const fmtDate = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
let pastTimer = 0;
async function loadPast() {
  const list = $('pastList');
  try {
    const r = await (await fetch('/api/minutes?q=' + encodeURIComponent($('pastQ').value.trim()))).json();
    if (!r.items.length) { list.innerHTML = '<p class="hint">저장된 회의록이 없거나 찾는 내용이 없습니다. 회의록은 실행파일 옆 <b>회의록</b> 폴더에 저장됩니다.</p>'; return; }
    list.innerHTML = r.items.map((it) => `<div class="past-item" role="listitem">
      <div class="past-top"><b>${esc(it.title)}</b><small>${esc(fmtDate(it.startedAt))} · ${esc(it.status)}${it.consensus ? ` · ${esc(it.consensus)}` : ''}</small></div>
      <div class="past-sub">${esc(it.participants.slice(0, 6).join(', '))}</div>
      <div class="past-body">${it.hasConclusion ? esc(it.conclusion) : '<i>결론이 없는 회의입니다</i>'}</div>
      <button type="button" class="ghost" data-past="${esc(it.id)}" ${it.hasConclusion ? '' : 'disabled'}>이어 가기</button></div>`).join('');
    list.querySelectorAll('[data-past]').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        const it = await (await fetch('/api/minutes/item?id=' + encodeURIComponent(b.dataset.past))).json();
        if (!it.conclusion) throw new Error('결론을 읽지 못했습니다');
        if (pinned.length >= 3) pinned.shift();
        pinned.push({ id: it.id, title: it.title, question: it.question, conclusion: it.conclusion });
        renderChips();
        $('pastDlg').close();
        qEl.focus();
      } catch (e) { b.disabled = false; b.textContent = '실패: ' + e.message; }
    }));
  } catch { list.innerHTML = '<p class="hint">회의록 목록을 불러오지 못했습니다.</p>'; }
}
$('pastBtn').addEventListener('click', () => { $('pastDlg').showModal(); $('pastQ').value = ''; loadPast(); $('pastQ').focus(); });
$('pastQ').addEventListener('input', () => { clearTimeout(pastTimer); pastTimer = setTimeout(loadPast, 250); });

// --- 엑셀: 시트·행·열을 골라 필요한 부분만 첨부 ---
let xl = null; // { token, name, sheets, sel }
const xv = (id) => $(id).value.trim();
async function openXlsxFile(file) {
  attachMsg('엑셀을 읽는 중…');
  const res = await fetch('/api/xlsx/inspect?name=' + encodeURIComponent(file.name), { method: 'POST', body: file });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
  attachMsg('');
  showXlsx(d);
}
async function openXlsxFolder(rel) {
  try {
    const d = await postJson('/api/xlsx/inspect-folder', { path: folderRoot || $('folderPath').value, rel });
    showXlsx(d);
  } catch (e) { attachMsg(e.message, 'err'); }
}
function showXlsx(d) {
  xl = { ...d, sel: 0 };
  $('xlsxTitle').textContent = d.name;
  $('xlsxSheets').innerHTML = d.sheets.map((s, i) => `<button type="button" class="xl-sheet" data-xs="${i}" role="radio">${esc(s.name)}<small>${esc(s.rows)}행 × ${esc(s.cols)}열${s.hidden ? ' · 숨김' : ''}</small></button>`).join('');
  $('xlsxSheets').querySelectorAll('[data-xs]').forEach((b) => b.addEventListener('click', () => pickSheet(Number(b.dataset.xs))));
  pickSheet(d.sheets.findIndex((s) => !s.hidden && s.rows) >= 0 ? d.sheets.findIndex((s) => !s.hidden && s.rows) : 0);
  $('xOut').textContent = ''; $('xMsg').textContent = '';
  if (!$('xlsxDlg').open) $('xlsxDlg').showModal();
}
// 제목 줄 추정: 맛보기 몇 줄 중, 칸이 충분히 채워진 첫 줄
function guessHeader(s) {
  const counts = s.preview.map((r) => r.cells.filter(Boolean).length);
  const max = Math.max(0, ...counts);
  const i = counts.findIndex((c) => c >= Math.max(2, Math.ceil(max * 0.6)));
  return i >= 0 ? s.preview[i].n : 0;
}
function pickSheet(i) {
  const s = xl.sheets[i];
  xl.sel = i;
  $('xlsxSheets').querySelectorAll('[data-xs]').forEach((b) => b.setAttribute('aria-checked', String(Number(b.dataset.xs) === i)));
  let h = guessHeader(s);
  if (h && h >= s.lastRow) h = 0; // 제목 줄 밖에 행이 없으면 제목 줄 없이 전부 가져온다
  $('xHeader').value = h || '';
  $('xFrom').value = h ? h + 1 : s.firstRow;
  $('xTo').value = s.lastRow;
  $('xContains').value = '';
  const labels = (s.preview.find((r) => r.n === h)?.cells) || [];
  const n = Math.min(s.cols, 60);
  $('xCols').innerHTML = Array.from({ length: n }, (_, c) => `<label class="check"><input type="checkbox" data-xc="${c}" checked> <span>${esc(labels[c] || '(열 ' + colLetter(c) + ')')}</span></label>`).join('') + (s.cols > 60 ? `<small>열이 많아 앞의 60개만 표시합니다</small>` : '');
  $('xOut').textContent = ''; $('xMsg').textContent = s.cut ? '행이 매우 많아 앞부분(20,000행)까지만 읽었습니다.' : (s.noValue ? `값이 저장되지 않은 수식 칸이 ${s.noValue}개 있어 비어 있습니다(엑셀에서 한 번 저장하면 채워집니다).` : '');
}
const colLetter = (i) => { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
function xPicks() {
  const s = xl.sheets[xl.sel];
  const all = [...$('xCols').querySelectorAll('[data-xc]')];
  const on = all.filter((c) => c.checked).map((c) => Number(c.dataset.xc));
  if (!on.length) throw new Error('보낼 열을 하나 이상 고르세요');
  const from = Number(xv('xFrom')) || s.firstRow, to = Number(xv('xTo')) || s.lastRow;
  if (to < from) throw new Error('끝 행이 시작 행보다 작습니다');
  return [{ sheet: xl.sel, from, to, header: Number(xv('xHeader')) || null, cols: on.length === all.length && s.cols <= 60 ? null : on, contains: xv('xContains') }];
}
async function xlsxRequest(preview) {
  return postJson('/api/xlsx/extract', { token: xl.token, picks: xPicks(), rowNumbers: $('xRowNo').checked, preview, maxChars: Math.max(500, ATTACH.maxChars - totalChars()) });
}
$('xPreview').addEventListener('click', async () => {
  try {
    const r = await xlsxRequest(true);
    $('xOut').textContent = r.text;
    $('xMsg').textContent = `보내면 ${r.rows}행, 약 ${fmt(r.chars)}자입니다. 남은 첨부 용량은 ${fmt(Math.max(0, ATTACH.maxChars - totalChars()))}자입니다.${r.notes.length ? ' ' + r.notes.join(' / ') : ''}`;
  } catch (e) { $('xMsg').textContent = e.message; }
});
$('xAdd').addEventListener('click', async () => {
  try {
    if (attachments.length >= ATTACH.maxFiles) throw new Error(`첨부는 최대 ${ATTACH.maxFiles}개까지입니다`);
    if (ATTACH.maxChars - totalChars() <= 500) throw new Error('첨부 용량이 가득 찼습니다');
    const p = xPicks()[0];
    const r = await xlsxRequest(false);
    if (!r.rows) throw new Error('고른 조건에 맞는 행이 없습니다');
    attachments.push({ name: `${xl.name} · ${xl.sheets[xl.sel].name} ${p.from}~${r.cutAt ?? p.to}행`, text: r.text, truncated: r.cutAt != null });
    renderAttachments();
    scheduleEstimate();
    $('xMsg').textContent = `첨부했습니다 (${r.rows}행, ${fmt(r.chars)}자). 다른 시트를 더 고르거나 닫아도 됩니다.${r.notes.length ? ' ' + r.notes.join(' / ') : ''}`;
  } catch (e) { $('xMsg').textContent = e.message; }
});
$('xColsAll').addEventListener('click', () => $('xCols').querySelectorAll('[data-xc]').forEach((c) => { c.checked = true; }));
$('xColsNone').addEventListener('click', () => $('xCols').querySelectorAll('[data-xc]').forEach((c) => { c.checked = false; }));
