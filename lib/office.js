// Office 문서(docx/xlsx/pptx) 글자 뽑기 + docx/xlsx 만들기. 외부 패키지 없음.
const { readZip, writeZip } = require('./zip');

const unesc = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, g) => {
    const l = g.toLowerCase();
    if (l[0] === '#') {
      const cp = l[1] === 'x' ? parseInt(l.slice(2), 16) : Number(l.slice(1));
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[l];
  });
const strip = (xml) => unesc(xml.replace(/<[^>]+>/g, ''));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const xml = (z, name) => (z.has(name) ? z.read(name).toString('utf8') : null);

function docxText(buf) {
  const x = xml(readZip(buf), 'word/document.xml');
  if (x == null) throw new Error('docx 가 아닙니다');
  return strip(
    x.replace(/<w:tab\/>/g, '\t').replace(/<w:br[^>]*\/>/g, '\n').replace(/<\/w:p>(?=\s*<\/w:tc>)/g, '')
      .replace(/<\/w:tc>/g, '\t').replace(/<\/w:tr>/g, '\n').replace(/<\/w:p>/g, '\n'),
  ).replace(/\n{3,}/g, '\n\n').trim();
}

function pptxText(buf) {
  const z = readZip(buf);
  const num = (n) => Number(n.match(/(\d+)\.xml$/)[1]);
  const slides = z.names().filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => num(a) - num(b));
  if (!slides.length) throw new Error('pptx 가 아닙니다');
  const out = [];
  for (const n of slides) {
    const i = num(n);
    const body = strip(z.read(n).toString('utf8').replace(/<\/a:p>/g, '\n').replace(/<a:br\/>/g, '\n').replace(/<\/a:tc>/g, '\t')).replace(/\n{2,}/g, '\n').trim();
    const notesX = xml(z, `ppt/notesSlides/notesSlide${i}.xml`);
    const notes = notesX ? strip(notesX.replace(/<\/a:p>/g, '\n')).replace(/\n{2,}/g, '\n').trim() : '';
    out.push(`## 슬라이드 ${i}\n${body}${notes ? `\n(발표자 노트) ${notes}` : ''}`);
  }
  return out.join('\n\n');
}

const colIndex = (ref) => [...ref.match(/^[A-Z]+/)[0]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

function xlsxText(buf, { maxRows = 500 } = {}) {
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
  const sheets = [...wb.matchAll(/<sheet\b[^>]*>/g)].map((m, i) => ({
    name: unesc(m[0].match(/\bname="([^"]*)"/)?.[1] || `Sheet${i + 1}`),
    file: rels[m[0].match(/\br:id="([^"]+)"/)?.[1]] || `xl/worksheets/sheet${i + 1}.xml`,
  }));
  const out = [];
  for (const s of sheets) {
    const sx = xml(z, s.file);
    if (sx == null) continue;
    const rows = [];
    let cut = false;
    for (const rm of sx.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      if (rows.length >= maxRows) { cut = true; break; }
      const cells = [];
      for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = cm[1].match(/\br="([A-Z]+\d+)"/)?.[1];
        const type = cm[1].match(/\bt="([^"]+)"/)?.[1];
        const inner = cm[2] || '';
        let v = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        if (type === 's') v = shared[Number(v)] ?? '';
        else if (type === 'inlineStr') v = strip(inner.replace(/<\/?is>/g, ''));
        else if (v != null) v = unesc(v);
        if (v == null || v === '') continue;
        const idx = ref ? colIndex(ref) : cells.length;
        while (cells.length < idx) cells.push('');
        cells[idx] = String(v).replace(/[\t\r\n]+/g, ' ');
      }
      if (cells.some((c) => c !== '' && c != null)) rows.push(cells.map((c) => c ?? '').join('\t'));
    }
    if (rows.length) out.push(`## 시트: ${s.name}\n${rows.join('\n')}${cut ? `\n(이하 ${maxRows}행까지만)` : ''}`);
  }
  return out.join('\n\n');
}

// --- 만들기 ---
const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

function docxBuild(markdown, title = '') {
  const run = (t, o = {}) => `<w:r><w:rPr>${o.b ? '<w:b/>' : ''}${o.sz ? `<w:sz w:val="${o.sz}"/>` : ''}</w:rPr><w:t xml:space="preserve">${esc(t)}</w:t></w:r>`;
  const para = (t, o) => `<w:p>${o?.ind ? `<w:pPr><w:ind w:left="${o.ind}"/></w:pPr>` : ''}${run(t, o)}</w:p>`;
  const inline = (s) => s.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1');
  const body = [];
  if (title) body.push(para(title, { b: true, sz: 40 }));
  for (const raw of String(markdown).split(/\r?\n/)) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) body.push('<w:p/>');
    else if ((m = line.match(/^(#{1,6})\s+(.*)$/))) body.push(para(inline(m[2]), { b: true, sz: [36, 32, 28, 26, 24, 24][m[1].length - 1] }));
    else if ((m = line.match(/^\s*[-*]\s+(.*)$/))) body.push(para('• ' + inline(m[1]), { ind: 360 }));
    else if ((m = line.match(/^\s*(\d+)[.)]\s+(.*)$/))) body.push(para(`${m[1]}. ${inline(m[2])}`, { ind: 360 }));
    else body.push(para(inline(line)));
  }
  return writeZip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
    { name: 'word/document.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W_NS}><w:body>${body.join('')}<w:sectPr/></w:body></w:document>` },
  ]);
}

const colName = (i) => { let s = ''; for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s; return s; };

// 내용에서 표를 찾는다: 마크다운 표(| a | b |) 우선, 없으면 CSV/탭 구분 줄, 그것도 아니면 줄마다 한 칸.
function tableRows(content) {
  const lines = String(content).split(/\r?\n/).filter((l) => l.trim());
  const pipe = lines.filter((l) => /^\s*\|.*\|\s*$/.test(l) && !/^\s*\|[\s:|-]+\|\s*$/.test(l));
  if (pipe.length) return pipe.map((l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
  if (lines.some((l) => l.includes('\t'))) return lines.map((l) => l.split('\t'));
  if (lines.some((l) => l.includes(','))) return lines.map(parseCsvLine);
  return lines.map((l) => [l]);
}
function parseCsvLine(line) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function xlsxBuild(content, sheetName = '결과') {
  const rows = tableRows(content).slice(0, 5000);
  const sheet = rows.map((r, ri) => `<row r="${ri + 1}">${r.slice(0, 200).map((c, ci) => (c === '' ? '' : `<c r="${colName(ci)}${ri + 1}" t="inlineStr"><is><t xml:space="preserve">${esc(c)}</t></is></c>`)).join('')}</row>`).join('');
  const name = esc(sheetName.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Sheet1');
  return writeZip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>' },
    { name: 'xl/worksheets/sheet1.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheet}</sheetData></worksheet>` },
  ]);
}

module.exports = { docxText, pptxText, xlsxText, docxBuild, xlsxBuild, tableRows };
