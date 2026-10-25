// 데이터 백업·옮기기: 회의록 폴더와 회사정보.md 를 zip 하나로 묶고, 다른 PC에서 다시 풀어 넣는다.
// API 키(.env)와 첨부 원본은 넣지 않는다. 가져오기는 이미 있는 파일을 덮어쓰지 않는다.
const fs = require('fs');
const path = require('path');
const { readZip, writeZip } = require('./zip');

const MAX_FILES = 3000;
const MAX_FILE = 5 * 1024 * 1024;
const MAX_TOTAL = 200 * 1024 * 1024;
const SAFE_NAME = /^[^\\/:*?"<>|\u0000-\u001f]{1,200}\.(md|jsonl)$/i;
const MARK = 'backup.json';

function build({ minutesDir, profileText }) {
  const entries = [];
  let total = 0, skipped = 0, minutes = 0;
  let names = [];
  try { names = fs.readdirSync(minutesDir).filter((n) => SAFE_NAME.test(n)).sort(); } catch {}
  for (const n of names.slice(0, MAX_FILES)) {
    try {
      const p = path.join(minutesDir, n);
      const st = fs.statSync(p);
      if (!st.isFile() || st.size > MAX_FILE || total + st.size > MAX_TOTAL) { skipped++; continue; }
      entries.push({ name: `회의록/${n}`, data: fs.readFileSync(p) });
      total += st.size;
      if (n.endsWith('.jsonl')) minutes++;
    } catch { skipped++; }
  }
  const hasProfile = Boolean(profileText && profileText.trim());
  if (hasProfile) entries.push({ name: '회사정보.md', data: profileText });
  const meta = { app: 'ai-council', created: new Date().toISOString(), minutes, profile: hasProfile, skipped };
  entries.unshift({ name: MARK, data: JSON.stringify(meta, null, 2) });
  return { buffer: writeZip(entries), meta };
}

function restore(buf, { minutesDir, readProfile, writeProfile }) {
  let z;
  try { z = readZip(buf); } catch { throw new Error('백업 파일(zip)을 읽지 못했습니다'); }
  if (!z.has(MARK)) throw new Error('이 프로그램의 백업 파일이 아닙니다');
  const rep = { added: 0, existing: 0, rejected: 0, profile: 'none' };
  fs.mkdirSync(minutesDir, { recursive: true });
  let count = 0, total = 0;
  for (const name of z.names()) {
    if (!name.startsWith('회의록/')) continue;
    const base = name.slice('회의록/'.length);
    if (++count > MAX_FILES || !SAFE_NAME.test(base) || base.includes('..')) { rep.rejected++; continue; }
    let data;
    try { data = z.read(name); } catch { rep.rejected++; continue; }
    total += data.length;
    if (data.length > MAX_FILE || total > MAX_TOTAL) { rep.rejected++; continue; }
    try {
      fs.writeFileSync(path.join(minutesDir, base), data, { flag: 'wx' }); // 있으면 덮어쓰지 않는다
      rep.added++;
    } catch (e) {
      if (e.code === 'EEXIST') rep.existing++; else rep.rejected++;
    }
  }
  if (z.has('회사정보.md')) {
    const incoming = z.read('회사정보.md').toString('utf8');
    const cur = readProfile();
    if (!cur.trim()) { try { writeProfile(incoming); rep.profile = 'restored'; } catch { rep.profile = 'rejected'; } }
    else rep.profile = cur.trim() === incoming.trim() ? 'same' : 'kept';
  }
  return rep;
}

module.exports = { build, restore };
