// 엑셀(.xlsx)에서 필요한 시트·행·열만 골라 글자로 뽑는다. 외부 패키지 없음.
// 올릴 때 한 번 읽어 구조(시트, 행 수, 제목 줄, 맛보기)를 보여 주고, 사용자가 고른 부분만 첨부 글로 만든다.
// 날짜 칸은 엑셀 일련번호(예: 45219)가 아니라 날짜(2023-10-20)로 바꿔 준다. 수식은 계산하지 않고 저장된 값을 읽는다.
const { readZip } = require('./zip');

const MAX_ROWS_PARSE = 20000; // 시트 하나에서 읽는 행 상한(메모리 보호)
const MAX_COLS = 200;
const PREVIEW_ROWS = 5;

const unesc = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, g) => {
  const l = g.toLowerCase();
  if (l[0] === '#') {
    const cp = l[1] === 'x' ? parseInt(l.slice(2), 16) : Number(l.slice(1));
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
  }
  return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[l];
});
const strip = (x) => unesc(x.replace(/<[^>]+>/g, ''));
const xml = (z, name) => (z.has(name) ? z.read(name).toString('utf8') : null);
const colIndex = (ref) => [...ref.match(/^[A-Z]+/)[0]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
const colName = (i) => { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };

// 날짜 서식인 칸 번호(cellXfs 의 위치) 찾기
function dateStyles(z) {
  const st = xml(z, 'xl/styles.xml');
  if (!st) return new Set();
  const custom = {};
  for (const m of st.matchAll(/<numFmt\b[^>]*>/g)) {
    const id = m[0].match(/numFmtId="(\d+)"/)?.[1];
    const code = m[0].match(/formatCode="([^"]*)"/)?.[1];
    if (id != null && code != null) custom[id] = unesc(code);
  }
  const builtin = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
  const isDateCode = (c) => /[ymdhs]/i.test(String(c).replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '').replace(/General/gi, ''));
  const block = st.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] || '';
  const out = new Set();
  [...block.matchAll(/<xf\b[^>]*>/g)].forEach((m, i) => {
    const id = m[0].match(/numFmtId="(\d+)"/)?.[1];
    if (id == null) return;
    if (custom[id] != null ? isDateCode(custom[id]) : builtin.has(Number(id))) out.add(i);
  });
  return out;
}

const pad = (n) => String(n).padStart(2, '0');
function serialToText(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 2958465) return String(v);
  const days = Math.floor(n);
  const mins = Math.round((n - days) * 1440);
  const d = new Date(Date.UTC(1899, 11, 30) + days * 86400000);
  const time = mins ? ` ${pad(Math.floor(mins / 60) % 24)}:${pad(mins % 60)}` : '';
  if (days === 0) return time.trim() || '00:00';
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}${time}`;
}
const tidyNumber = (v) => (/^-?\d+\.\d{10,}$/.test(v) ? String(parseFloat(Number(v).toPrecision(12))) : v);

function parseWorkbook(buf) {
  const z = readZip(buf);
  const wb = xml(z, 'xl/workbook.xml');
  if (wb == null) throw new Error('xlsx 가 아닙니다');
  const shared = [];
  const ss = xml(z, 'xl/sharedStrings.xml');
  if (ss) for (const m of ss.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(strip([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')));
  const rels = {};
  for (const m of (xml(z, 'xl/_rels/workbook.xml.rels') || '').matchAll(/<Relationship\b[^>]*>/g)) {
    const id = m[0].match(/\bId="([^"]+)"/)?.[1];
    const target = m[0].match(/\bTarget="([^"]+)"/)?.[1];
    if (id && target) rels[id] = target.replace(/^\/?(xl\/)?/, 'xl/');
  }
  const dates = dateStyles(z);
  const sheets = [];
  [...wb.matchAll(/<sheet\b[^>]*>/g)].forEach((m, i) => {
    const name = unesc(m[0].match(/\bname="([^"]*)"/)?.[1] || `Sheet${i + 1}`);
    const hidden = /\bstate="(hidden|veryHidden)"/.test(m[0]);
    const file = rels[m[0].match(/\br:id="([^"]+)"/)?.[1]] || `xl/worksheets/sheet${i + 1}.xml`;
    const sx = xml(z, file);
    if (sx == null) return;
    const rows = [];
    let cut = false, noValue = 0, maxCol = 0, rowNo = 0;
    for (const rm of sx.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
      rowNo = Number(rm[1].match(/\br="(\d+)"/)?.[1]) || rowNo + 1;
      if (rows.length >= MAX_ROWS_PARSE) { cut = true; break; }
      const cells = [];
      for (const cm of rm[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = cm[1].match(/\br="([A-Z]+\d+)"/)?.[1];
        const type = cm[1].match(/\bt="([^"]+)"/)?.[1];
        const style = Number(cm[1].match(/\bs="(\d+)"/)?.[1]);
        const inner = cm[2] || '';
        let v = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        if (type === 's') v = shared[Number(v)] ?? '';
        else if (type === 'inlineStr') v = strip(inner.replace(/<\/?is>/g, ''));
        else if (type === 'b') v = v === '1' ? 'TRUE' : 'FALSE';
        else if (v != null) {
          v = unesc(v);
          if (type !== 'str' && type !== 'e' && dates.has(style)) v = serialToText(v);
          else if (type !== 'str' && type !== 'e') v = tidyNumber(v);
        }
        if ((v == null || v === '') && /<f\b/.test(inner)) noValue++;
        if (v == null || v === '') continue;
        const idx = Math.min(ref ? colIndex(ref) : cells.length, MAX_COLS - 1);
        while (cells.length < idx) cells.push('');
        cells[idx] = String(v).replace(/[\t\r\n]+/g, ' ').trim();
      }
      if (cells.some((c) => c !== '' && c != null)) {
        rows.push({ n: rowNo, cells: cells.map((c) => c ?? '') });
        maxCol = Math.max(maxCol, cells.length);
      }
    }
    sheets.push({ name, hidden, rows, cols: maxCol, cut, noValue });
  });
  if (!sheets.length) throw new Error('읽을 수 있는 시트가 없습니다');
  return { sheets };
}

// 화면에 보여 줄 구조: 시트별 행 수, 제목 줄 후보(첫 행), 맛보기 몇 줄
function describe(wb) {
  return wb.sheets.map((s, index) => ({
    index,
    name: s.name,
    hidden: s.hidden,
    rows: s.rows.length,
    cols: s.cols,
    firstRow: s.rows[0]?.n || 0,
    lastRow: s.rows[s.rows.length - 1]?.n || 0,
    header: (s.rows[0]?.cells || []).slice(0, 60),
    preview: s.rows.slice(0, PREVIEW_ROWS).map((r) => ({ n: r.n, cells: r.cells.slice(0, 12) })),
    cut: s.cut,
    noValue: s.noValue,
  }));
}

// picks: [{ sheet, from, to, header (행 번호 또는 null), cols: [열 번호...] 또는 null, contains: '글자' }]
function extractSelection(wb, picks, { maxChars = 80000, rowNumbers = true, previewLines = 0 } = {}) {
  const blocks = [];
  let total = 0, rowsOut = 0, cutAt = null;
  const notes = [];
  const limit = previewLines ? Infinity : maxChars;
  for (const p of picks) {
    const s = wb.sheets[Number(p.sheet)];
    if (!s) throw new Error('없는 시트입니다');
    const from = Math.max(1, Math.floor(Number(p.from)) || 1);
    const to = Math.max(from, Math.floor(Number(p.to)) || from);
    const contains = String(p.contains || '').trim().toLowerCase();
    const cols = Array.isArray(p.cols) && p.cols.length ? [...new Set(p.cols.map(Number).filter((c) => c >= 0 && c < MAX_COLS))].sort((a, b) => a - b) : null;
    const pick = (cells) => (cols ? cols.map((c) => cells[c] ?? '') : cells);
    const headerRow = p.header ? s.rows.find((r) => r.n === Math.floor(Number(p.header))) : null;
    const lines = [];
    const title = `## 시트: ${s.name} — ${from}~${to}행${contains ? ` (조건: "${p.contains}" 포함)` : ''}${cols ? ` · 열 ${cols.length}개 선택` : ''}`;
    lines.push(title);
    if (headerRow) lines.push(`${rowNumbers ? '행\t' : ''}${pick(headerRow.cells).join('\t')}`);
    let any = false, last = null;
    for (const r of s.rows) {
      if (r.n < from) continue;
      if (r.n > to) break;
      if (headerRow && r.n === headerRow.n) continue;
      if (contains && !r.cells.some((c) => String(c).toLowerCase().includes(contains))) continue;
      const line = `${rowNumbers ? `${r.n}\t` : ''}${pick(r.cells).join('\t')}`;
      if (total + line.length + 1 > limit) { cutAt = last ?? r.n - 1; notes.push(`용량 제한으로 ${s.name} 시트는 ${cutAt}행까지만 넣었습니다`); break; }
      lines.push(line);
      total += line.length + 1;
      rowsOut++;
      any = true;
      last = r.n;
    }
    if (!any) lines.push('(고른 조건에 맞는 행이 없습니다)');
    if (s.noValue) notes.push(`${s.name} 시트에는 값이 저장되지 않은 수식 칸이 ${s.noValue}개 있어 비어 있습니다(엑셀에서 열어 저장하면 값이 채워집니다)`);
    blocks.push(lines.join('\n'));
    if (cutAt != null) break;
  }
  let text = blocks.join('\n\n');
  const chars = text.length; // 맛보기여도 전체 글자 수를 알려 준다
  if (previewLines) text = text.split('\n').slice(0, previewLines).join('\n');
  return { text, rows: rowsOut, chars, cutAt, notes: [...new Set(notes)] };
}

module.exports = { parseWorkbook, describe, extractSelection, serialToText, colName };
