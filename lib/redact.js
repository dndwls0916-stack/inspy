// 개인정보 가리기: AI 로 보내기 전에 전화번호·주민등록번호·이메일·계좌번호·차량번호와
// 사용자가 적은 이름을 "[전화1]" 같은 가명으로 바꾼다. 같은 값은 같은 가명이라 AI 가 "같은 사람/번호"임은 알 수 있다.
// 완벽하지 않다: 주소, 이름(목록에 없는 것), 이미지 속 글자는 찾지 못한다. 그래서 미리보기와 이름 목록을 함께 제공한다.

const LABEL = { rrn: '주민등록번호', phone: '전화번호', email: '이메일', account: '계좌·긴 번호', plate: '차량번호', name: '이름' };
const PLATE_CHARS = '가나다라마거너더러머버서어저고노도로모보소오조구누두루무부수우주아바사자하허호배';
const REGION = '(?:(?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)\\s?)?';

const RULES = [
  ['email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g],
  ['rrn', /(?<!\d)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])[-\s]?[1-4]\d{6}(?!\d)/g],
  ['phone', /(?<!\d)01[016789][-.\s]?\d{3,4}[-.\s]?\d{4}(?!\d)/g],
  ['phone', /(?<!\d)0(?:2|[3-6][1-5]|70|80)[-.\s]?\d{3,4}[-.\s]?\d{4}(?!\d)/g],
  ['account', /(?<!\d)\d{2,6}(?:-\d{2,8}){2,3}(?!\d)/g, (m) => { const d = m.replace(/\D/g, ''); return d.length >= 10 && d.length <= 16 && !/^(?:01[016789]|0(?:2|[3-6][1-5]|70|80))/.test(d); }],
  ['plate', new RegExp(`(?<!\\d)${REGION}\\d{2,3}[${PLATE_CHARS}]\\s?\\d{4}(?!\\d)`, 'g')],
];
const PLACEHOLDER = /\[(?:주민번호|전화|이메일|계좌|차량|이름)\d+\]/g;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const TAG = { rrn: '주민번호', phone: '전화', email: '이메일', account: '계좌', plate: '차량', name: '이름' };

// opts: { categories: { rrn, phone, email, account, plate } (false 로 끄기), names: [이름...] }
function createRedactor(opts = {}) {
  const cats = opts.categories || {};
  const names = [...new Set((opts.names || []).map((n) => String(n).trim()).filter((n) => n.length >= 2))].sort((a, b) => b.length - a.length).slice(0, 200);
  const maps = {}; // 종류 -> Map(원래 값 -> 번호)
  const counts = {};
  const samples = [];
  const place = (type, value) => {
    const key = type === 'phone' || type === 'account' || type === 'rrn' ? value.replace(/\D/g, '') : value.replace(/\s/g, '').toLowerCase();
    const m = (maps[type] ||= new Map());
    if (!m.has(key)) m.set(key, m.size + 1);
    counts[type] = (counts[type] || 0) + 1;
    const out = `[${TAG[type]}${m.get(key)}]`;
    if (samples.length < 12 && !samples.some((s) => s.before === value)) samples.push({ type: LABEL[type], before: value, after: out });
    return out;
  };
  function text(input) {
    let s = String(input ?? '');
    if (!s) return s;
    // 이미 가명으로 바꾼 글(예: 이전 결론)은 건드리지 않도록 잠시 빼 둔다
    const keep = [];
    s = s.replace(PLACEHOLDER, (m) => { keep.push(m); return `\u0000${keep.length - 1}\u0000`; });
    for (const [type, re, ok] of RULES) {
      if (cats[type] === false) continue;
      s = s.replace(re, (m) => (ok && !ok(m) ? m : place(type, m)));
    }
    if (cats.name !== false) for (const n of names) s = s.replace(new RegExp(escapeRe(n), 'g'), (m) => place('name', m));
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => keep[Number(i)]);
  }
  const report = () => ({ total: Object.values(counts).reduce((a, b) => a + b, 0), counts: Object.fromEntries(Object.entries(counts).map(([k, v]) => [LABEL[k], v])), samples });
  return { text, report };
}

// 회의 요청 한 번에 들어가는 글(질문, 첨부, 이전 회의)을 한꺼번에 가린다. 같은 값은 요청 안에서 같은 가명이 된다.
function redactRequest({ question, attachments = [], history = [] }, opts) {
  const r = createRedactor(opts);
  const out = {
    question: r.text(question),
    attachments: attachments.map((a) => ({ ...a, name: r.text(a.name), text: r.text(a.text) })),
    history: history.map((h) => ({ ...h, question: r.text(h.question), conclusion: r.text(h.conclusion) })),
  };
  return { ...out, report: r.report(), redactor: r };
}

module.exports = { createRedactor, redactRequest, LABEL };
