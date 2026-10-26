// 할 일(실행 항목) 추적: 결론의 "실행 계획" 표를 읽어, 사람이 확정한 항목만 저장하고 다음 회의에 미완료 항목을 올린다.
// AI 가 낸 담당·기한은 제안일 뿐이므로 저장 전에 사람이 보고 고친다.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = '실행항목.json';
const MAX_ITEMS = 500;
const STATUS = ['open', 'done', 'hold', 'cancel'];
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
const blank = (s) => (/^(미정|없음|-|—|n\/a|tbd)?$/i.test(String(s).trim()) ? '' : String(s).trim());

// "## 실행 계획" 아래 마크다운 표에서 항목을 뽑는다. 열 순서: 할 일 | 담당 | 기한 | 확인 지표
function parseActionTable(text) {
  const lines = String(text || '').split('\n');
  const start = lines.findIndex((l) => /^##\s*실행 계획/.test(l));
  if (start < 0) return [];
  const items = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i].trim();
    if (/^##\s/.test(l)) break;
    if (!l.startsWith('|')) continue;
    const cells = l.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')) continue; // 구분선
    if (/^할\s*일$/.test(cells[0])) continue; // 머리글
    const task = clean(cells[0], 300);
    if (!task) continue;
    items.push({ text: task, owner: blank(clean(cells[1], 60)), due: blank(clean(cells[2], 40)), metric: blank(clean(cells[3], 200)) });
    if (items.length >= 20) break;
  }
  return items;
}

const fileOf = (dir) => path.join(dir, FILE);
function load(dir) {
  try {
    const d = JSON.parse(fs.readFileSync(fileOf(dir), 'utf8'));
    return Array.isArray(d.items) ? d.items.filter((x) => x && x.id && x.text) : [];
  } catch { return []; }
}
function save(dir, items) {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${fileOf(dir)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, items }, null, 1), 'utf8');
  fs.renameSync(tmp, fileOf(dir));
}
const key = (t) => String(t).replace(/\s+/g, '').toLowerCase();

// 사람이 확인한 항목을 추가한다. 같은 내용의 미완료 항목이 있으면 건너뛴다.
function add(dir, meeting, list) {
  const items = load(dir);
  const have = new Set(items.filter((x) => x.status === 'open' || x.status === 'hold').map((x) => key(x.text)));
  let added = 0, skipped = 0;
  for (const raw of (Array.isArray(list) ? list : []).slice(0, 20)) {
    const text = clean(raw?.text, 300);
    if (!text) continue;
    if (have.has(key(text))) { skipped++; continue; }
    if (items.length >= MAX_ITEMS) throw new Error(`할 일은 최대 ${MAX_ITEMS}개까지 보관합니다. 완료된 항목을 지워 주세요`);
    items.push({ id: crypto.randomBytes(6).toString('hex'), text, owner: clean(raw.owner, 60), due: clean(raw.due, 40), metric: clean(raw.metric, 200), note: '', status: 'open', meeting: clean(meeting, 80), created: new Date().toISOString(), updated: new Date().toISOString() });
    have.add(key(text));
    added++;
  }
  save(dir, items);
  return { added, skipped, open: items.filter((x) => x.status === 'open').length };
}

function update(dir, id, patch) {
  const items = load(dir);
  const it = items.find((x) => x.id === id);
  if (!it) throw new Error('없는 항목입니다');
  const p = patch || {};
  if (p.status !== undefined) { if (!STATUS.includes(p.status)) throw new Error('알 수 없는 상태입니다'); it.status = p.status; }
  for (const [k, n] of [['text', 300], ['owner', 60], ['due', 40], ['metric', 200], ['note', 300]]) if (p[k] !== undefined) it[k] = clean(p[k], n);
  if (!it.text) throw new Error('할 일 내용은 비울 수 없습니다');
  it.updated = new Date().toISOString();
  save(dir, items);
  return it;
}
function remove(dir, id) {
  const items = load(dir);
  const next = items.filter((x) => x.id !== id);
  if (next.length === items.length) throw new Error('없는 항목입니다');
  save(dir, next);
}

// 다음 회의에 올릴 미완료 항목을 첨부 자료로 만든다(없으면 null). 담당·기한·메모는 사람이 확정·기록한 값이다.
function carryAttachment(dir, limit = 15) {
  const open = load(dir).filter((x) => x.status === 'open').slice(0, limit);
  if (!open.length) return null;
  const lines = open.map((x, i) => `${i + 1}. ${x.text}${x.owner ? ` / 담당: ${x.owner}` : ''}${x.due ? ` / 기한: ${x.due}` : ''}${x.metric ? ` / 확인 지표: ${x.metric}` : ''}${x.note ? ` / 메모: ${x.note}` : ''}${x.meeting ? ` (정한 회의: ${x.meeting})` : ''}`);
  return { name: '미완료 할 일 (이전 회의에서 사람이 확정)', text: `이전 회의에서 정해졌으나 아직 끝나지 않은 할 일 ${open.length}건입니다.\n${lines.join('\n')}`, count: open.length };
}

// 백업·가져오기용: 같은 id 는 덮어쓰지 않고 새 항목만 합친다
function merge(dir, incoming) {
  const items = load(dir);
  const ids = new Set(items.map((x) => x.id));
  let added = 0;
  for (const x of Array.isArray(incoming) ? incoming : []) {
    if (!x || typeof x.id !== 'string' || !/^[0-9a-f]{12}$/.test(x.id) || ids.has(x.id) || items.length >= MAX_ITEMS) continue;
    const text = clean(x.text, 300);
    if (!text) continue;
    items.push({ id: x.id, text, owner: clean(x.owner, 60), due: clean(x.due, 40), metric: clean(x.metric, 200), note: clean(x.note, 300), status: STATUS.includes(x.status) ? x.status : 'open', meeting: clean(x.meeting, 80), created: clean(x.created, 40), updated: clean(x.updated, 40) });
    added++;
  }
  if (added) save(dir, items);
  return added;
}

module.exports = { FILE, parseActionTable, load, add, update, remove, carryAttachment, merge };
