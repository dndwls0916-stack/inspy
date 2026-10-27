// 평가 케이스: 대표 안건을 저장해 두고, 설정(참가자·역할·방식·라운드)을 바꿔 같은 안건으로 다시 돌려 결과를 나란히 비교한다.
// 기계적으로 확인할 수 있는 것만 채점한다: 기대 포인트(사람이 적은 낱말)가 결론에 있는가, 질문에 없는 숫자가 결론에 있는가, 호출 수·시간·길이.
// 결론이 "좋은지"를 AI 가 평가하지 않는다. 사람이 두 결론을 읽고 판단한다.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { checkEvidence } = require('./evidence');

const FILE = '평가케이스.json';
const MAX_CASES = 50;
const MAX_RUNS = 300;
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, n);

const fileOf = (dir) => path.join(dir, FILE);
function readAll(dir) {
  try {
    const d = JSON.parse(fs.readFileSync(fileOf(dir), 'utf8'));
    return { cases: Array.isArray(d.cases) ? d.cases.filter((x) => x && x.id && x.title) : [], runs: Array.isArray(d.runs) ? d.runs.filter((x) => x && x.id && x.caseId) : [] };
  } catch { return { cases: [], runs: [] }; }
}
function writeAll(dir, data) {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${fileOf(dir)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, ...data }, null, 1), 'utf8');
  fs.renameSync(tmp, fileOf(dir));
}
const parseExpect = (v) => [...new Set((Array.isArray(v) ? v : String(v || '').split(/\r?\n/)).map((x) => clean(x, 60)).filter(Boolean))].slice(0, 15);

function addCase(dir, { title, question, expect }) {
  const q = clean(question, 4000);
  if (q.length < 5) throw new Error('질문을 입력하세요');
  const data = readAll(dir);
  if (data.cases.length >= MAX_CASES) throw new Error(`케이스는 최대 ${MAX_CASES}개까지입니다`);
  const c = { id: crypto.randomBytes(6).toString('hex'), title: clean(title, 60) || q.split('\n')[0].slice(0, 40), question: q, expect: parseExpect(expect), created: new Date().toISOString() };
  data.cases.push(c);
  writeAll(dir, data);
  return c;
}
function updateCase(dir, id, patch) {
  const data = readAll(dir);
  const c = data.cases.find((x) => x.id === id);
  if (!c) throw new Error('없는 케이스입니다');
  const p = patch || {};
  if (p.title !== undefined) c.title = clean(p.title, 60) || c.title;
  if (p.question !== undefined) { const q = clean(p.question, 4000); if (q.length < 5) throw new Error('질문을 입력하세요'); c.question = q; }
  if (p.expect !== undefined) c.expect = parseExpect(p.expect);
  writeAll(dir, data);
  return c;
}
function removeCase(dir, id) {
  const data = readAll(dir);
  if (!data.cases.some((x) => x.id === id)) throw new Error('없는 케이스입니다');
  writeAll(dir, { cases: data.cases.filter((x) => x.id !== id), runs: data.runs.filter((x) => x.caseId !== id) });
}
function removeRun(dir, id) {
  const data = readAll(dir);
  if (!data.runs.some((x) => x.id === id)) throw new Error('없는 결과입니다');
  writeAll(dir, { ...data, runs: data.runs.filter((x) => x.id !== id) });
}

// 결과 한 건을 채점해 저장한다. conclusion 은 최종 결론 글, run 은 화면이 모은 실행 정보.
function score(c, conclusion) {
  const flat = (s) => String(s).replace(/\s+/g, '').toLowerCase();
  const text = flat(conclusion);
  const hit = c.expect.filter((e) => text.includes(flat(e)));
  const miss = c.expect.filter((e) => !text.includes(flat(e)));
  const ev = checkEvidence(conclusion, [{ name: '질문', text: c.question }], '');
  return { expectTotal: c.expect.length, hit, miss, invented: ev.numbers.missing.map((x) => x.text), inventedQuotes: ev.quotes.missing };
}
function addRun(dir, caseId, run) {
  const data = readAll(dir);
  const c = data.cases.find((x) => x.id === caseId);
  if (!c) throw new Error('없는 케이스입니다');
  const conclusion = clean(run?.conclusion, 20000);
  const r = {
    id: crypto.randomBytes(6).toString('hex'), caseId,
    label: clean(run?.label, 60) || '이름 없는 설정', config: clean(run?.config, 300),
    at: new Date().toISOString(),
    ok: Boolean(conclusion) && run?.ok !== false,
    error: clean(run?.error, 300),
    conclusion,
    reached: run?.reached === true ? true : run?.reached === false ? false : null,
    calls: Math.max(0, Math.floor(Number(run?.calls)) || 0),
    inChars: Math.max(0, Math.floor(Number(run?.inChars)) || 0),
    outChars: Math.max(0, Math.floor(Number(run?.outChars)) || 0),
    ms: Math.max(0, Math.floor(Number(run?.ms)) || 0),
    score: conclusion ? score(c, conclusion) : null,
  };
  data.runs.push(r);
  if (data.runs.length > MAX_RUNS) data.runs = data.runs.slice(-MAX_RUNS);
  writeAll(dir, data);
  return r;
}

function merge(dir, incoming) {
  const data = readAll(dir);
  const ids = new Set(data.cases.map((x) => x.id));
  let added = 0;
  const fresh = new Set();
  for (const c of Array.isArray(incoming?.cases) ? incoming.cases : []) {
    if (!c || !/^[0-9a-f]{12}$/.test(String(c.id)) || ids.has(c.id) || data.cases.length >= MAX_CASES) continue;
    const q = clean(c.question, 4000);
    if (q.length < 5) continue;
    data.cases.push({ id: c.id, title: clean(c.title, 60) || q.slice(0, 40), question: q, expect: parseExpect(c.expect), created: clean(c.created, 40) || new Date().toISOString() });
    ids.add(c.id); fresh.add(c.id); added++;
  }
  // 새로 들어온 케이스의 결과도 함께(이미 있던 케이스의 결과는 건드리지 않는다)
  for (const r of Array.isArray(incoming?.runs) ? incoming.runs : []) {
    if (!r || !fresh.has(r.caseId) || !/^[0-9a-f]{12}$/.test(String(r.id)) || data.runs.some((x) => x.id === r.id)) continue;
    data.runs.push({ id: r.id, caseId: r.caseId, label: clean(r.label, 60), config: clean(r.config, 300), at: clean(r.at, 40), ok: r.ok === true, error: clean(r.error, 300), conclusion: clean(r.conclusion, 20000), reached: r.reached === true ? true : r.reached === false ? false : null, calls: Number(r.calls) || 0, inChars: Number(r.inChars) || 0, outChars: Number(r.outChars) || 0, ms: Number(r.ms) || 0, score: r.score && typeof r.score === 'object' ? r.score : null });
  }
  if (added) writeAll(dir, data);
  return added;
}

module.exports = { FILE, readAll, addCase, updateCase, removeCase, removeRun, addRun, score, merge, parseExpect };
