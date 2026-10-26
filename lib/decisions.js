// 의사결정 기록: 회의 결론을 "결정"으로 확정해 두고, 재검토 시점에 결과를 적고, 비슷한 안건을 열 때 과거 결정을 참고한다.
// 저장 위치는 회의록 폴더의 결정기록.json. 재검토일·결과는 사람이 적는다(AI 가 정하지 않는다).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = '결정기록.json';
const MAX_ITEMS = 300;
const STATUS = ['decided', 'reviewed', 'dropped'];
const OUTCOME = ['', 'good', 'mixed', 'bad'];
const OUTCOME_LABEL = { good: '잘 됨', mixed: '절반만 됨', bad: '잘 안 됨' };
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/[ \t]+/g, ' ').trim().slice(0, n);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

// 결론 글에서 "## 결론" 부분만(없으면 앞부분)
function conclusionSection(text) {
  const t = String(text || '');
  const m = t.match(/(?:^|\n)##\s*결론[^\n]*\n([\s\S]*?)(?=\n##\s|$)/);
  return clean((m ? m[1] : t).replace(/\s*\n\s*/g, ' '), 700);
}

const fileOf = (dir) => path.join(dir, FILE);
function load(dir) {
  try {
    const d = JSON.parse(fs.readFileSync(fileOf(dir), 'utf8'));
    return Array.isArray(d.items) ? d.items.filter((x) => x && x.id && x.title) : [];
  } catch { return []; }
}
function save(dir, items) {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${fileOf(dir)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, items }, null, 1), 'utf8');
  fs.renameSync(tmp, fileOf(dir));
}

function add(dir, { title, question, conclusion, meeting, reviewDate }) {
  const items = load(dir);
  if (items.length >= MAX_ITEMS) throw new Error(`결정 기록은 최대 ${MAX_ITEMS}건까지 보관합니다. 오래된 기록을 지워 주세요`);
  const summary = conclusionSection(conclusion);
  if (!summary) throw new Error('기록할 결론이 없습니다');
  const t = clean(title, 80) || clean(meeting, 80) || '결정';
  const rd = clean(reviewDate, 10);
  if (rd && !isDate(rd)) throw new Error('재검토 날짜는 YYYY-MM-DD 형식이어야 합니다');
  const it = { id: crypto.randomBytes(6).toString('hex'), title: t, question: clean(question, 600), summary, meeting: clean(meeting, 80), reviewDate: rd, status: 'decided', outcome: '', result: '', created: new Date().toISOString(), updated: new Date().toISOString() };
  items.push(it);
  save(dir, items);
  return it;
}

function update(dir, id, patch) {
  const items = load(dir);
  const it = items.find((x) => x.id === id);
  if (!it) throw new Error('없는 기록입니다');
  const p = patch || {};
  if (p.status !== undefined) { if (!STATUS.includes(p.status)) throw new Error('알 수 없는 상태입니다'); it.status = p.status; }
  if (p.outcome !== undefined) { if (!OUTCOME.includes(p.outcome)) throw new Error('알 수 없는 결과입니다'); it.outcome = p.outcome; }
  if (p.reviewDate !== undefined) { const d = clean(p.reviewDate, 10); if (d && !isDate(d)) throw new Error('재검토 날짜는 YYYY-MM-DD 형식이어야 합니다'); it.reviewDate = d; }
  for (const [k, n] of [['title', 80], ['result', 500]]) if (p[k] !== undefined) it[k] = clean(p[k], n);
  if (!it.title) throw new Error('제목은 비울 수 없습니다');
  // 결과를 적으면서 결과 평가까지 했다면 재검토를 끝낸 것으로 본다
  if ((p.outcome !== undefined && it.outcome) || (p.result !== undefined && it.result)) { if (it.status === 'decided' && p.status === undefined) it.status = 'reviewed'; }
  it.updated = new Date().toISOString();
  save(dir, items);
  return it;
}
function remove(dir, id) {
  const items = load(dir);
  const next = items.filter((x) => x.id !== id);
  if (next.length === items.length) throw new Error('없는 기록입니다');
  save(dir, next);
}

const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
// 재검토할 때가 된(날짜가 지났고 아직 결과를 안 적은) 결정
const due = (dir, now = today()) => load(dir).filter((x) => x.status === 'decided' && x.reviewDate && x.reviewDate <= now);

// --- 비슷한 안건 찾기: AI 없이 글자 조각(한글 두 글자씩, 영문·숫자 낱말) 겹침으로 ---
const STOP = new Set(['미확인', '질문', '안건', '회의', '관련', '대한', '대해', '어떻', '하는', '합니', '니다', '세요', '해주', '주세', '있는', '없는', '입니', '여부', '때문', '방안', '검토', '정리', '제안', '판단', '미확', '확인', '조치', '순서', '내용', '결정']);
function grams(text) {
  const t = String(text || '').toLowerCase().replace(/\(미확인 항목은[^)]*\)/g, ' ').replace(/\[안건:[^\]]*\]/g, ' ');
  const out = new Set();
  for (const run of t.match(/[가-힣]+/g) || []) {
    for (let i = 0; i + 2 <= run.length; i++) { const g = run.slice(i, i + 2); if (!STOP.has(g)) out.add(g); }
  }
  for (const w of t.match(/[a-z0-9]{2,}/g) || []) out.add(w);
  return out;
}
function similarity(a, b) {
  if (!a.size || !b.size) return { score: 0, shared: 0 };
  let shared = 0;
  for (const g of a) if (b.has(g)) shared++;
  return { score: (2 * shared) / (a.size + b.size), shared };
}
// 질문과 비슷한 기록된 결정을 점수 순으로(최대 limit). 기준은 보수적으로 잡아 엉뚱한 참고를 줄인다.
function similar(dir, question, limit = 3) {
  const q = grams(question);
  if (q.size < 4) return [];
  return load(dir).filter((x) => x.status !== 'dropped').map((x) => ({ x, ...similarity(q, grams(`${x.title} ${x.title} ${x.question} ${x.summary}`)) }))
    .filter((r) => r.shared >= 4 && r.score >= 0.22).sort((a, b) => b.score - a.score).slice(0, limit)
    .map((r) => ({ ...r.x, score: Math.round(r.score * 100) / 100 }));
}

// 사용자가 고른 과거 결정을 이번 회의 자료로(id 로만 받아 저장된 내용을 쓴다)
function precedentAttachment(dir, ids) {
  const want = new Set((Array.isArray(ids) ? ids : []).slice(0, 3).map(String));
  const list = load(dir).filter((x) => want.has(x.id));
  if (!list.length) return null;
  const lines = list.map((x, i) => `${i + 1}. [${x.created.slice(0, 10)}] ${x.title}\n   당시 결론: ${x.summary}\n   결과: ${x.outcome ? OUTCOME_LABEL[x.outcome] : '아직 기록 없음'}${x.result ? ` — ${x.result}` : ''}${x.reviewDate && x.status === 'decided' ? ` (재검토 예정 ${x.reviewDate})` : ''}`);
  return { name: '과거 결정 (기록된 것)', text: `이번 안건과 비슷한 과거 결정 ${list.length}건입니다. 결과 칸은 사람이 적은 것입니다.\n${lines.join('\n')}`, count: list.length };
}

function merge(dir, incoming) {
  const items = load(dir);
  const ids = new Set(items.map((x) => x.id));
  let added = 0;
  for (const x of Array.isArray(incoming) ? incoming : []) {
    if (!x || typeof x.id !== 'string' || !/^[0-9a-f]{12}$/.test(x.id) || ids.has(x.id) || items.length >= MAX_ITEMS) continue;
    const title = clean(x.title, 80), summary = clean(x.summary, 700);
    if (!title || !summary) continue;
    items.push({ id: x.id, title, question: clean(x.question, 600), summary, meeting: clean(x.meeting, 80), reviewDate: isDate(clean(x.reviewDate, 10)) ? x.reviewDate : '', status: STATUS.includes(x.status) ? x.status : 'decided', outcome: OUTCOME.includes(x.outcome) ? x.outcome : '', result: clean(x.result, 500), created: clean(x.created, 40) || new Date().toISOString(), updated: clean(x.updated, 40) });
    added++;
  }
  if (added) save(dir, items);
  return added;
}

module.exports = { FILE, OUTCOME_LABEL, conclusionSection, load, add, update, remove, due, similar, precedentAttachment, merge, grams, similarity };
