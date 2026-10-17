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

// 마크다운 → 슬라이드: 제목줄(# ~ ###)마다 새 슬라이드, 그 아래 줄들은 글머리. 한 장에 글머리 7개까지, 넘치면 "(계속)".
function slidesFromMarkdown(markdown, title) {
  const slides = [];
  let cur = null;
  const push = () => { if (cur && (cur.bullets.length || cur.title)) slides.push(cur); };
  const clean = (t) => t.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').trim();
  for (const raw of String(markdown).split(/\r?\n/)) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim() || /^\s*\|[\s:|-]+\|\s*$/.test(line) || /^\s*[-*_]{3,}\s*$/.test(line)) continue;
    if ((m = line.match(/^#{1,3}\s+(.*)$/))) { push(); cur = { title: clean(m[1]), bullets: [] }; continue; }
    if (!cur) cur = { title: title || '', bullets: [] };
    let text = line;
    let level = 0, num = false;
    if ((m = line.match(/^(\s*)[-*]\s+(.*)$/))) { level = m[1].length >= 2 ? 1 : 0; text = m[2]; }
    else if ((m = line.match(/^\s*(\d+[.)])\s+(.*)$/))) { text = `${m[1]} ${m[2]}`; num = true; }
    else if (/^\s*\|.*\|\s*$/.test(line)) text = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()).join('  ·  ');
    cur.bullets.push({ text: clean(text), level, num });
  }
  push();
  if (!slides.length) slides.push({ title: title || '', bullets: [] });
  const out = [];
  for (const sl of slides) {
    for (let i = 0; i === 0 || i < sl.bullets.length; i += 7) {
      out.push({ title: i ? `${sl.title} (계속)` : sl.title, bullets: sl.bullets.slice(i, i + 7) });
      if (!sl.bullets.length) break;
    }
  }
  return out.slice(0, 60);
}

const A_NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const rels = (list) => `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list.map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`).join('')}</Relationships>`;
const grp = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
const LATIN = '<a:latin typeface="Malgun Gothic"/><a:ea typeface="Malgun Gothic"/>';

function pptxBuild(markdown, title = '') {
  const slides = slidesFromMarkdown(markdown, title);
  const W = 12192000, H = 6858000; // 16:9
  const slideXml = (sl, i) => {
    const titleSp = `<p:sp><p:nvSpPr><p:cNvPr id="2" name="제목"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="609600" y="365760"/><a:ext cx="${W - 1219200}" cy="1005840"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr anchor="ctr"><a:normAutofit/></a:bodyPr><a:lstStyle/><a:p><a:r><a:rPr lang="ko-KR" sz="3200" b="1" dirty="0"><a:solidFill><a:srgbClr val="1F2937"/></a:solidFill>${LATIN}</a:rPr><a:t>${esc(sl.title || ' ')}</a:t></a:r></a:p></p:txBody></p:sp>`;
    const paras = sl.bullets.map((b) => `<a:p><a:pPr marL="${b.level ? 685800 : 342900}" indent="-285750"><a:spcBef><a:spcPts val="900"/></a:spcBef>${b.num ? '<a:buNone/>' : `<a:buFont typeface="Arial"/><a:buChar char="${b.level ? '–' : '•'}"/>`}</a:pPr><a:r><a:rPr lang="ko-KR" sz="${b.level ? 1800 : 2000}" dirty="0"><a:solidFill><a:srgbClr val="374151"/></a:solidFill>${LATIN}</a:rPr><a:t>${esc(b.text)}</a:t></a:r></a:p>`).join('');
    const body = sl.bullets.length ? `<p:sp><p:nvSpPr><p:cNvPr id="3" name="내용"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="609600" y="1463040"/><a:ext cx="${W - 1219200}" cy="${H - 2103120}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr wrap="square"><a:normAutofit/></a:bodyPr><a:lstStyle/>${paras}</p:txBody></p:sp>` : '';
    return `${HEAD}<p:sld ${A_NS}><p:cSld><p:spTree>${grp}${titleSp}${body}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
  };
  const n = slides.length;
  const types = `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>${slides.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('')}</Types>`;
  const theme = `${HEAD}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Council"><a:themeElements><a:clrScheme name="Council"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F2937"/></a:dk2><a:lt2><a:srgbClr val="F3F4F6"/></a:lt2><a:accent1><a:srgbClr val="2563EB"/></a:accent1><a:accent2><a:srgbClr val="DC2626"/></a:accent2><a:accent3><a:srgbClr val="16A34A"/></a:accent3><a:accent4><a:srgbClr val="D97706"/></a:accent4><a:accent5><a:srgbClr val="7C3AED"/></a:accent5><a:accent6><a:srgbClr val="0891B2"/></a:accent6><a:hlink><a:srgbClr val="2563EB"/></a:hlink><a:folHlink><a:srgbClr val="7C3AED"/></a:folHlink></a:clrScheme><a:fontScheme name="Council"><a:majorFont><a:latin typeface="Malgun Gothic"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Malgun Gothic"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Council"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;
  const master = `${HEAD}<p:sldMaster ${A_NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree>${grp}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`;
  const layout = `${HEAD}<p:sldLayout ${A_NS} type="blank" preserve="1"><p:cSld name="빈 화면"><p:spTree>${grp}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
  const pres = `${HEAD}<p:presentation ${A_NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join('')}</p:sldIdLst><p:sldSz cx="${W}" cy="${H}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`;
  return writeZip([
    { name: '[Content_Types].xml', data: types },
    { name: '_rels/.rels', data: rels([['rId1', 'officeDocument', 'ppt/presentation.xml']]) },
    { name: 'ppt/presentation.xml', data: pres },
    { name: 'ppt/_rels/presentation.xml.rels', data: rels([['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'], ...slides.map((_, i) => [`rId${i + 2}`, 'slide', `slides/slide${i + 1}.xml`]), [`rId${n + 2}`, 'theme', 'theme/theme1.xml']]) },
    { name: 'ppt/slideMasters/slideMaster1.xml', data: master },
    { name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data: rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'], ['rId2', 'theme', '../theme/theme1.xml']]) },
    { name: 'ppt/slideLayouts/slideLayout1.xml', data: layout },
    { name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', data: rels([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']]) },
    { name: 'ppt/theme/theme1.xml', data: theme },
    ...slides.flatMap((sl, i) => [
      { name: `ppt/slides/slide${i + 1}.xml`, data: slideXml(sl, i) },
      { name: `ppt/slides/_rels/slide${i + 1}.xml.rels`, data: rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml']]) },
    ]),
  ]);
}

module.exports = { docxText, pptxText, xlsxText, docxBuild, xlsxBuild, pptxBuild, slidesFromMarkdown, tableRows };
