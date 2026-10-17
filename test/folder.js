// 폴더 읽기/결과물 저장 검증. 실행: npm test
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.MOCK = '1';
const { server } = require('../server');
const { scanFolder, saveOutput } = require('../lib/folder');
const { writeZip, readZip } = require('../lib/zip');
const { xlsxBuild, xlsxText, docxBuild, docxText, pptxBuild, pptxText, slidesFromMarkdown, tableRows } = require('../lib/office');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'council-folder-'));
fs.mkdirSync(path.join(tmp, 'sub'));
fs.mkdirSync(path.join(tmp, 'node_modules'));
fs.writeFileSync(path.join(tmp, 'a.md'), '# 제목\n본문');
fs.writeFileSync(path.join(tmp, 'sub', 'b.csv'), 'x,y\n1,2');
fs.writeFileSync(path.join(tmp, '.env'), 'KEY=secret');
fs.writeFileSync(path.join(tmp, 'id_rsa'), 'secret');
fs.writeFileSync(path.join(tmp, 'node_modules', 'n.js'), '1');
fs.writeFileSync(path.join(tmp, 'x.pdf'), '%PDF');
fs.writeFileSync(path.join(tmp, 'big.txt'), 'a'.repeat(40_000));
fs.writeFileSync(path.join(tmp, 'k.txt'), Buffer.from([0xc7, 0xd1, 0xb1, 0xdb])); // CP949 '한글'

// zip 왕복 + 오피스 만들기/읽기
const z = readZip(writeZip([{ name: 'a/b.txt', data: '가나다' }]));
assert.equal(z.read('a/b.txt').toString(), '가나다');
assert.equal(xlsxText(xlsxBuild('| 이름 | 값 |\n|---|---|\n| a & b | 1 |')), '## 시트: 결과\n이름\t값\na & b\t1');
assert(docxText(docxBuild('# 제목\n- 항목\n본문', 'T')).includes('• 항목'));
assert.deepEqual(tableRows('a,"b,c"\n1,2'), [['a', 'b,c'], ['1', '2']]);

// pptx 만들기: 제목줄마다 슬라이드, 7개 넘으면 (계속), 특수문자 이스케이프, 읽기와 왕복
const md = '# 결론\n요약 & <b>\n\n## 방향\n- 하나\n  - 하위\n1. 번호\n\n## 위험\n' + Array.from({ length: 9 }, (_, i) => `- 위험${i + 1}`).join('\n');
const sl = slidesFromMarkdown(md, 'T');
assert.deepEqual(sl.map((x) => x.title), ['결론', '방향', '위험', '위험 (계속)']);
assert.equal(sl[3].bullets.length, 2);
const back = pptxText(pptxBuild(md, 'T'));
assert(back.includes('## 슬라이드 4\n위험 (계속)\n위험8\n위험9') && back.includes('요약 & <b>'));
assert.equal(slidesFromMarkdown('제목 없는 본문', '이름')[0].title, '이름', '제목줄이 없으면 파일 이름이 제목');
assert.equal(slidesFromMarkdown('', 'x').length, 1);
assert(slidesFromMarkdown(Array.from({ length: 200 }, (_, i) => `## s${i}\n- a`).join('\n'), 'x').length <= 60, '슬라이드 수 상한');

// 스캔: 비밀/숨김/무시 폴더 제외, 인코딩, 용량 제한
const r = scanFolder(tmp);
const by = Object.fromEntries(r.files.map((f) => [f.rel, f]));
assert(by['a.md'].ok && by['sub/b.csv'].ok);
assert(!by['.env'] && !by['node_modules/n.js'], '숨김 파일과 node_modules 는 목록에 없다');
assert(by['id_rsa'] && !by['id_rsa'].ok && !by['id_rsa'].text, '비밀 파일은 내용을 읽지 않는다');
assert(!by['x.pdf'].ok && by['x.pdf'].note.includes('PDF'));
assert(by['big.txt'].truncated && by['big.txt'].text.length < 31_000);
assert.equal(by['k.txt'].text, '한글', 'CP949 해석');
assert.throws(() => scanFolder(path.parse(tmp).root), /루트/);
assert.throws(() => scanFolder(path.join(tmp, 'nope')), /찾을 수 없/);
assert.throws(() => scanFolder(path.join(tmp, 'a.md')), /폴더가 아니라/);

// 저장: 결과물 폴더, 덮어쓰기 금지, 이름 정화
let s = saveOutput(tmp, { name: '../../evil/보고서.md', format: 'md', content: '내용' });
assert.equal(path.dirname(s.path), path.join(fs.realpathSync(tmp), '결과물'), '경로 탈출 불가');
assert(!s.path.includes('..'));
const s2 = saveOutput(tmp, { name: '../../evil/보고서', format: 'md', content: '다른 내용' });
assert.notEqual(s.path, s2.path, '같은 이름이면 새 파일');
assert.equal(fs.readFileSync(s.path, 'utf8'), '내용', '기존 파일 유지');
assert.throws(() => saveOutput(tmp, { name: 'x', format: 'exe', content: 'a' }), /형식/);
assert.throws(() => saveOutput(tmp, { name: 'x', format: 'md', content: '  ' }), /내용이 없/);
const sx = saveOutput(tmp, { name: '표', format: 'xlsx', content: '| a | b |\n| 1 | 2 |' });
assert.equal(xlsxText(fs.readFileSync(sx.path)), '## 시트: 결과\na\tb\n1\t2');
const sp = saveOutput(tmp, { name: '발표', format: 'pptx', content: md });
assert(pptxText(fs.readFileSync(sp.path)).includes('## 슬라이드 2\n방향'));
// 결과물 폴더는 다시 스캔할 때 제외
assert(!scanFolder(tmp).files.some((f) => f.rel.startsWith('결과물/')));

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers, body: JSON.stringify(body) });
  try {
    let res = await post('/api/folder/scan', { path: tmp });
    assert.equal(res.status, 200);
    assert((await res.json()).files.length >= 4);
    res = await post('/api/folder/scan', { path: '' });
    assert.equal(res.status, 400);
    res = await post('/api/folder/save', { path: tmp, name: 'n', format: 'txt', content: 'hi' });
    assert.equal(res.status, 200);
    // 다른 웹사이트에서 온 요청 / 외부 호스트 이름은 거절
    res = await post('/api/folder/scan', { path: tmp }, { origin: 'https://evil.example' });
    assert.equal(res.status, 403, '낯선 Origin 거절');
    res = await post('/api/folder/save', { path: tmp, name: 'n', format: 'txt', content: 'hi' }, { origin: 'http://evil.example' });
    assert.equal(res.status, 403);
    // fetch 는 Host 헤더를 바꿀 수 없으므로 http 로 직접 보낸다
    const status = await new Promise((resolve, reject) => {
      const rq = require('http').request({ host: '127.0.0.1', port, path: '/api/folder/scan', method: 'POST', headers: { host: 'evil.example' } }, (r) => { r.resume(); resolve(r.statusCode); });
      rq.on('error', reject);
      rq.end(JSON.stringify({ path: tmp }));
    });
    assert.equal(status, 403, '낯선 Host(DNS rebinding) 거절');
    res = await post('/api/folder/scan', { path: tmp }, { origin: base });
    assert.equal(res.status, 200, '같은 Origin 은 허용');
    console.log('folder.js: ok');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
