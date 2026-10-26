// 근거 대조: 최종 결론에 나온 숫자와 따옴표 인용이 첨부 자료·질문에 실제로 있는지 글자로 찾아 본다(AI 호출 없음).
// 세 갈래로 나눈다: 자료에서 확인됨 / 회의 발언에만 있음(AI 가 한 말) / 어디에도 없음(AI 가 만들었거나 계산한 값일 수 있음).
// 글자 대조일 뿐이라 자료에 있는 숫자라도 맞게 해석했는지는 알 수 없고, 계산해서 나온 숫자는 "없음"으로 나온다.

const UNITS = '(?:%|퍼센트|원|만원|천원|억원|억|조|대|명|건|톤|t|km|kg|회|곳|개|시간|분)';
const NUM_RE = new RegExp(`(?<![\\w.,/:-])(\\d{1,3}(?:,\\d{3})+|\\d+)(\\.\\d+)?\\s?(${UNITS})?(?![\\w/:-]\\d)`, 'g');
const SCALE = { 억: 1e8, 억원: 1e8, 조: 1e12, 만원: 1e4, 천원: 1e3 };
const MAX_LIST = 12;

const norm = (s) => String(s ?? '').replace(/(\d),(?=\d{3}(?!\d))/g, '$1');
const flat = (s) => String(s ?? '').replace(/\s+/g, '').toLowerCase();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const has = (hay, core) => new RegExp(`(?<![\\d.])${esc(core)}(?!\\d|\\.\\d)`).test(hay);

// 실행 계획 표(담당·기한은 AI 의 제안)는 검사하지 않는다. 목록 번호("1.")도 숫자로 보지 않는다.
function checkable(text) {
  const out = [];
  let skip = false;
  for (const line of String(text).split('\n')) {
    if (/^##\s/.test(line)) skip = /^##\s*실행 계획/.test(line);
    if (!skip) out.push(line.replace(/^\s*(?:[-*]\s+)?\d+[.)]\s+/, ''));
  }
  return out.join('\n');
}

function extractNumbers(text) {
  const found = [], seen = new Set();
  for (const m of checkable(text).matchAll(NUM_RE)) {
    const intPart = m[1].replace(/,/g, ''), dec = m[2] || '', unit = m[3] || '';
    const value = Number(intPart + dec);
    if (!unit && !dec && value < 100) continue; // 단위 없는 작은 정수(순번, 라운드 수 등)
    if (!unit && !dec && intPart.length === 4 && value >= 1900 && value <= 2100) continue; // 연도
    const core = intPart + dec;
    const key = core + unit;
    if (seen.has(key)) continue;
    seen.add(key);
    const at = m.index;
    found.push({ text: m[0].trim(), core, unit, context: checkable(text).slice(Math.max(0, at - 14), at + m[0].length + 10).replace(/\s+/g, ' ').trim() });
  }
  return found;
}

function extractQuotes(text) {
  const out = [], seen = new Set();
  for (const m of checkable(text).matchAll(/[“"「]([^”"」\n]{6,120})[”"」]/g)) {
    const q = m[1].trim();
    if (!seen.has(q)) { seen.add(q); out.push(q); }
  }
  return out;
}

// sources: [{ name, text }] 사용자가 준 자료, meeting: 회의 발언·진행자 말을 이어 붙인 글
function checkEvidence(conclusion, sources, meeting = '') {
  const srcText = norm(sources.map((s) => s.text).join('\n'));
  const meetText = norm(meeting);
  const verified = [], meetingOnly = [], missing = [];
  const nums = extractNumbers(conclusion);
  for (const n of nums) {
    const scaled = SCALE[n.unit] ? String(Math.round(Number(n.core) * SCALE[n.unit])) : null;
    const inSrc = has(srcText, n.core) || (scaled && has(srcText, scaled));
    const inMeet = !inSrc && (has(meetText, n.core) || (scaled && has(meetText, scaled)));
    (inSrc ? verified : inMeet ? meetingOnly : missing).push(n);
  }
  const qs = extractQuotes(conclusion);
  const srcFlat = flat(sources.map((s) => s.text).join('\n') + '\n'), meetFlat = flat(meeting);
  const qv = [], qm = [], qx = [];
  for (const q of qs) {
    const f = flat(q);
    (srcFlat.includes(f) ? qv : meetFlat.includes(f) ? qm : qx).push(q);
  }
  const cut = (a) => a.slice(0, MAX_LIST);
  return {
    sources: sources.map((s) => s.name),
    numbers: { total: nums.length, verified: cut(verified.map(({ text }) => text)), meetingOnly: cut(meetingOnly.map(({ text, context }) => ({ text, context }))), missing: cut(missing.map(({ text, context }) => ({ text, context }))), counts: { verified: verified.length, meetingOnly: meetingOnly.length, missing: missing.length } },
    quotes: { total: qs.length, verified: cut(qv), meetingOnly: cut(qm), missing: cut(qx), counts: { verified: qv.length, meetingOnly: qm.length, missing: qx.length } },
  };
}

module.exports = { checkEvidence, extractNumbers, extractQuotes };
