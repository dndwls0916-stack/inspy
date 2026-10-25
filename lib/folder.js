// 폴더 읽기(글자 뽑기)와 결과물 저장. 결과물은 지정 폴더 안의 '결과물' 폴더에만, 덮어쓰지 않고 새 파일로만 쓴다.
const fs = require('fs');
const path = require('path');
const { docxText, pptxText, xlsxText, docxBuild, xlsxBuild, pptxBuild } = require('./office');

const OUT_DIR = '결과물';
const MAX_DEPTH = 3;
const MAX_VISIT = 400; // 훑어보는 항목 수 상한
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_FILE_CHARS = 30_000; // 파일 하나당 읽는 글자 상한
const SKIP_DIR = /^(\.|node_modules$|__pycache__$|dist$|build$|\$RECYCLE\.BIN$|System Volume Information$)/i;
// 비밀이 들어 있기 쉬운 파일은 AI 에게 보내지 않도록 목록에서도 제외한다.
const SECRET = /(^\.env|\.(pem|key|pfx|p12|kdbx|ppk)$|^id_(rsa|dsa|ecdsa|ed25519)|credential|secret|passw)/i;
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|xml|html?|css|js|mjs|ts|tsx|jsx|py|java|c|cpp|h|cs|go|rs|rb|php|sh|bat|ps1|sql|ya?ml|toml|ini|cfg|conf|log|srt|vtt|tex)$/i;
const OFFICE = { '.docx': docxText, '.pptx': pptxText, '.xlsx': xlsxText };
const UNSUPPORTED_HINT = { '.pdf': 'PDF 는 폴더 읽기에서 아직 안 됩니다(📎 첨부로는 가능)', '.xls': '옛 .xls 는 안 됩니다(.xlsx 로 저장해 주세요)', '.ppt': '옛 .ppt 는 안 됩니다(.pptx 로 저장해 주세요)', '.doc': '옛 .doc 는 안 됩니다(.docx 로 저장해 주세요)', '.hwp': 'hwp 는 아직 안 됩니다', '.hwpx': 'hwpx 는 아직 안 됩니다' };

function decodeText(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, '');
  } catch {
    try { return new TextDecoder('euc-kr').decode(buf); } catch { return buf.toString('latin1'); }
  }
}

function resolveDir(p) {
  const raw = String(p || '').trim().replace(/^["']|["']$/g, '');
  if (!raw) throw new Error('폴더 경로를 입력하세요');
  if (raw.includes('\0')) throw new Error('경로가 올바르지 않습니다');
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const dir = path.resolve(raw.startsWith('~') && home ? path.join(home, raw.slice(1)) : raw);
  if (path.parse(dir).root === dir) throw new Error('드라이브/루트 전체는 지정할 수 없습니다. 작업할 폴더를 지정하세요');
  let st;
  try { st = fs.statSync(dir); } catch { throw new Error('폴더를 찾을 수 없습니다'); }
  if (!st.isDirectory()) throw new Error('폴더가 아니라 파일입니다');
  return fs.realpathSync(dir);
}

function extract(file, ext, size) {
  if (OFFICE[ext]) return OFFICE[ext](fs.readFileSync(file));
  if (TEXT_EXT.test(ext) || ext === '') return decodeText(fs.readFileSync(file));
  return null;
}

function scanFolder(p) {
  const root = resolveDir(p);
  const files = [];
  let visited = 0;
  let truncatedScan = false;
  const walk = (dir, depth) => {
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    items.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    for (const it of items) {
      if (++visited > MAX_VISIT) { truncatedScan = true; return; }
      const full = path.join(dir, it.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (it.isSymbolicLink()) continue; // 폴더 밖으로 새지 않도록 링크는 따라가지 않는다
      if (it.isDirectory()) {
        if (depth < MAX_DEPTH && !SKIP_DIR.test(it.name) && !(depth === 0 && it.name === OUT_DIR)) walk(full, depth + 1);
        continue;
      }
      if (!it.isFile() || it.name.startsWith('~$') || it.name.startsWith('.')) continue;
      const ext = path.extname(it.name).toLowerCase();
      const entry = { rel, size: 0, ok: false, text: '', note: '' };
      try { entry.size = fs.statSync(full).size; } catch { continue; }
      if (SECRET.test(it.name)) { entry.note = '비밀 정보일 수 있어 제외했습니다'; files.push(entry); continue; }
      if (entry.size > MAX_FILE_BYTES) { entry.note = '파일이 너무 큽니다(20MB 초과)'; files.push(entry); continue; }
      if (!OFFICE[ext] && !TEXT_EXT.test(ext)) { entry.note = UNSUPPORTED_HINT[ext] || '읽을 수 없는 형식입니다'; files.push(entry); continue; }
      try {
        let text = extract(full, ext, entry.size).replace(/\u0000/g, '').trim();
        if (!text) { entry.note = '글자가 없습니다'; files.push(entry); continue; }
        if (text.length > MAX_FILE_CHARS) { text = text.slice(0, MAX_FILE_CHARS) + '\n(이하 용량 제한으로 생략)'; entry.truncated = true; }
        entry.ok = true;
        entry.text = text;
      } catch (err) {
        entry.note = `읽지 못했습니다: ${String(err.message || err).slice(0, 80)}`;
      }
      files.push(entry);
    }
  };
  walk(root, 0);
  return { root, outDir: OUT_DIR, files, truncatedScan };
}

// 폴더 안의 엑셀 한 개의 바이트를 안전하게 읽는다(시트·행 고르기용). 폴더 밖·링크·비밀 파일·다른 형식은 거부한다.
function readFolderXlsx(folder, rel) {
  const root = resolveDir(folder);
  const r = String(rel || '');
  if (!r || r.includes('\0') || path.isAbsolute(r) || r.split(/[\\/]/).includes('..')) throw new Error('파일 경로가 올바르지 않습니다');
  const full = path.resolve(root, r);
  if (!full.startsWith(root + path.sep)) throw new Error('폴더 밖의 파일은 읽을 수 없습니다');
  const name = path.basename(full);
  if (path.extname(name).toLowerCase() !== '.xlsx' || name.startsWith('~$') || name.startsWith('.') || SECRET.test(name)) throw new Error('읽을 수 없는 파일입니다');
  let st;
  try { st = fs.lstatSync(full); } catch { throw new Error('파일을 찾을 수 없습니다'); }
  if (!st.isFile() || st.isSymbolicLink()) throw new Error('읽을 수 없는 파일입니다');
  if (st.size > MAX_FILE_BYTES) throw new Error('파일이 너무 큽니다(20MB 초과)');
  return { name, buf: fs.readFileSync(full) };
}

const FORMATS = {
  md: { ext: '.md' }, txt: { ext: '.txt' }, html: { ext: '.html' }, csv: { ext: '.csv' }, docx: { ext: '.docx' }, xlsx: { ext: '.xlsx' }, pptx: { ext: '.pptx' },
};

function safeBase(name) {
  const base = String(name || '').replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\.{2,}/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+|[. ]+$/g, '').slice(0, 80);
  return base || '회의결과';
}

const htmlEsc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
function render(format, content, title) {
  if (format === 'docx') return docxBuild(content, title);
  if (format === 'xlsx') return xlsxBuild(content);
  if (format === 'pptx') return pptxBuild(content, title);
  if (format === 'html') return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${htmlEsc(title)}</title><style>body{font-family:sans-serif;max-width:800px;margin:2rem auto;padding:0 1rem;line-height:1.7}pre{white-space:pre-wrap}</style></head><body><h1>${htmlEsc(title)}</h1><pre>${htmlEsc(content)}</pre></body></html>`;
  if (format === 'csv') return '﻿' + content; // 엑셀에서 한글이 깨지지 않도록 BOM
  return content;
}

function saveOutput(p, { name, format, content }) {
  const root = resolveDir(p);
  const fmt = FORMATS[format];
  if (!fmt) throw new Error('지원하지 않는 저장 형식입니다');
  const text = String(content || '');
  if (!text.trim()) throw new Error('저장할 내용이 없습니다');
  if (text.length > 500_000) throw new Error('내용이 너무 깁니다');
  const outDir = path.join(root, OUT_DIR);
  if (fs.existsSync(outDir)) {
    const st = fs.lstatSync(outDir);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`'${OUT_DIR}' 가 폴더가 아니거나 링크입니다. 이름을 바꾸거나 지워 주세요`);
  } else fs.mkdirSync(outDir);
  const base = safeBase(name);
  const data = render(format, text, base);
  // 기존 파일을 덮어쓰지 않는다: 이미 있으면 -2, -3 ...
  for (let n = 1; n < 1000; n++) {
    const file = path.join(outDir, `${base}${n > 1 ? `-${n}` : ''}${fmt.ext}`);
    if (path.dirname(file) !== outDir) throw new Error('경로가 올바르지 않습니다');
    try {
      fs.writeFileSync(file, data, { flag: 'wx' });
      return { path: file, rel: `${OUT_DIR}/${path.basename(file)}` };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  throw new Error('파일 이름을 정하지 못했습니다');
}

module.exports = { scanFolder, saveOutput, resolveDir, readFolderXlsx, OUT_DIR };
