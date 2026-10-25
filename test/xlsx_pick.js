// 엑셀 시트·행·열 고르기 검증. 실행: npm test
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.MOCK = '1';
const { writeZip } = require('../lib/zip');
const { parseWorkbook, describe, extractSelection, serialToText } = require('../lib/xlsx_pick');
const { readFolderXlsx } = require('../lib/folder');

// --- 테스트용 xlsx 만들기: 시트 2개(하나는 숨김), 날짜 서식, 공유 문자열, 값 없는 수식 ---
const strings = ['배차 실적표 (10월)', '날짜', '노선', '기사', '전화', '물량', '비고', 'A노선', 'B노선', '홍길동', '김철수', '010-1234-5678', '010-2222-3333', '지연', '합계', '요약표', '항목'];
const S = (t) => strings.indexOf(t);
const cs = (ref, t) => `<c r="${ref}" t="s"><v>${S(t)}</v></c>`;
const sheet1 = `<?xml version="1.0"?><worksheet><sheetData>
<row r="1">${cs('A1', '배차 실적표 (10월)')}</row>
<row r="3">${['날짜', '노선', '기사', '전화', '물량', '비고'].map((t, i) => cs(`${'ABCDEF'[i]}3`, t)).join('')}</row>
<row r="4"><c r="A4" s="1"><v>45219</v></c>${cs('B4', 'A노선')}${cs('C4', '홍길동')}${cs('D4', '010-1234-5678')}<c r="E4"><v>120</v></c></row>
<row r="5"><c r="A5" s="1"><v>45219.5</v></c>${cs('B5', 'B노선')}${cs('C5', '김철수')}${cs('D5', '010-2222-3333')}<c r="E5"><v>0.30000000000000004</v></c>${cs('F5', '지연')}</row>
<row r="6"><c r="A6" s="2"><v>45221</v></c>${cs('B6', 'A노선')}${cs('C6', '홍길동')}<c r="E6"><v>75</v></c></row>
<row r="7">${cs('A7', '합계')}<c r="E7"><f>SUM(E4:E6)</f></c></row>
</sheetData></worksheet>`;
const sheet2 = `<?xml version="1.0"?><worksheet><sheetData><row r="1">${cs('A1', '항목')}${cs('B1', '요약표')}</row></sheetData></worksheet>`;
const files = [
  { name: '[Content_Types].xml', data: '<Types/>' },
  { name: 'xl/workbook.xml', data: '<workbook><sheets><sheet name="배차실적" sheetId="1" r:id="rId1"/><sheet name="요약" sheetId="2" state="hidden" r:id="rId2"/></sheets></workbook>' },
  { name: 'xl/_rels/workbook.xml.rels', data: '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>' },
  { name: 'xl/sharedStrings.xml', data: `<sst>${strings.map((t) => `<si><t>${t}</t></si>`).join('')}</sst>` },
  { name: 'xl/styles.xml', data: '<styleSheet><numFmts><numFmt numFmtId="164" formatCode="yyyy&quot;-&quot;mm&quot;-&quot;dd"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/></cellXfs></styleSheet>' },
  { name: 'xl/worksheets/sheet1.xml', data: sheet1 },
  { name: 'xl/worksheets/sheet2.xml', data: sheet2 },
];
const buf = writeZip(files);

// --- 읽기·구조 ---
assert.equal(serialToText(45219), '2023-10-20');
assert.equal(serialToText(45219.5), '2023-10-20 12:00');
const wb = parseWorkbook(buf);
const d = describe(wb);
assert.equal(d.length, 2);
assert.equal(d[0].name, '배차실적');
assert.equal(d[0].rows, 6, '비어 있는 행(2행)은 세지 않는다');
assert.equal(d[0].firstRow, 1);
assert.equal(d[0].lastRow, 7);
assert(d[1].hidden, '숨김 시트 표시');
assert.equal(d[0].noValue, 1, '값 없는 수식 1칸');
assert.equal(d[0].preview[0].cells[0], '배차 실적표 (10월)');

// --- 고르기: 제목 줄 + 행 범위 + 열 ---
let r = extractSelection(wb, [{ sheet: 0, from: 4, to: 6, header: 3 }]);
const lines = r.text.split('\n');
assert.equal(lines[0], '## 시트: 배차실적 — 4~6행');
assert.equal(lines[1], '행\t날짜\t노선\t기사\t전화\t물량\t비고', '제목 줄을 붙인다');
assert.equal(lines[2], '4\t2023-10-20\tA노선\t홍길동\t010-1234-5678\t120', '날짜는 날짜로');
assert(lines[3].startsWith('5\t2023-10-20 12:00\tB노선'), '시간이 있으면 시각까지');
assert(lines[3].includes('\t0.3\t'), '0.30000000000000004 같은 찌꺼기 정리');
assert(lines[4].startsWith('6\t2023-10-22'), '사용자 지정 날짜 서식도 인식');
assert.equal(r.rows, 3);
assert(r.notes.some((n) => n.includes('수식')), '값 없는 수식 안내');

// 열 선택(전화 열 빼기): 개인정보 열을 아예 보내지 않는다
r = extractSelection(wb, [{ sheet: 0, from: 4, to: 6, header: 3, cols: [0, 1, 2, 4] }]);
assert(!r.text.includes('010-') && r.text.includes('120') && r.text.includes('홍길동'), '고른 열만');
assert(r.text.split('\n')[1] === '행\t날짜\t노선\t기사\t물량');
// 행 번호 끄기
r = extractSelection(wb, [{ sheet: 0, from: 4, to: 4, header: 3 }], { rowNumbers: false });
assert(r.text.split('\n')[1].startsWith('날짜\t') && r.text.split('\n')[2].startsWith('2023-10-20'));
// 글자 포함 행만
r = extractSelection(wb, [{ sheet: 0, from: 1, to: 20, header: 3, contains: '홍길동' }]);
assert.equal(r.rows, 2);
assert(r.text.includes('(조건: "홍길동" 포함)'));
r = extractSelection(wb, [{ sheet: 0, from: 1, to: 20, contains: '없는글자' }]);
assert(r.text.includes('맞는 행이 없습니다'));
// 코드 계산: 합계·평균, 묶음별 합계, 번호·전화 열은 제외, 꺼 두면 없음
const { toNumber } = require('../lib/xlsx_pick');
assert.equal(toNumber('1,234'), 1234); assert.equal(toNumber('(300)'), -300); assert.equal(toNumber('12.5%'), 12.5);
assert.equal(toNumber('010-1234-5678'), null); assert.equal(toNumber('00123'), null); assert.equal(toNumber('1234567890123'), null); assert.equal(toNumber('abc'), null); assert.equal(toNumber(''), null);
r = extractSelection(wb, [{ sheet: 0, from: 4, to: 6, header: 3, groupBy: 1 }], { stats: true });
assert(r.text.includes('## 코드로 계산한 값') && r.statsCols === 1);
assert(/\| 물량 \| 3 \| 195\.3 \| 65\.1 \| 0\.3 \| 120 \| 0 \|/.test(r.text), r.text);
assert(/\| A노선 \| 2 \| 195 \|/.test(r.text) && /\| B노선 \| 1 \| 0\.3 \|/.test(r.text));
assert(!r.text.includes('| 전화 |'), '전화 열은 계산하지 않는다');
r = extractSelection(wb, [{ sheet: 0, from: 4, to: 6, header: 3 }]);
assert(!r.text.includes('코드로 계산한'));
r = extractSelection(wb, [{ sheet: 1, from: 1, to: 5 }], { stats: true });
assert(r.notes.some((n) => n.includes('숫자 열이 없습니다')));
// 시트 여러 개
r = extractSelection(wb, [{ sheet: 0, from: 3, to: 3 }, { sheet: 1, from: 1, to: 5 }]);
assert(r.text.includes('## 시트: 배차실적') && r.text.includes('## 시트: 요약') && r.text.includes('항목\t요약표'));
// 용량 제한: 행 단위로 자르고 어디까지 넣었는지 알려 준다
r = extractSelection(wb, [{ sheet: 0, from: 3, to: 7, header: 3 }], { maxChars: 110 });
assert(r.cutAt != null && r.notes.some((n) => n.includes('까지만')), `용량 제한 안내: ${JSON.stringify(r.notes)}`);
assert(r.chars <= 140);
// 맛보기
r = extractSelection(wb, [{ sheet: 0, from: 1, to: 7, header: 3 }], { previewLines: 3 });
assert.equal(r.text.split('\n').length, 3);
// 잘못된 입력
assert.throws(() => extractSelection(wb, [{ sheet: 9, from: 1, to: 2 }]), /없는 시트/);
assert.throws(() => parseWorkbook(Buffer.from('not a zip')), /zip|xlsx/);

// --- 폴더 안 파일을 안전하게 읽기 ---
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xlsxp-'));
fs.mkdirSync(path.join(tmp, 'sub'));
fs.writeFileSync(path.join(tmp, 'sub', '실적.xlsx'), buf);
fs.writeFileSync(path.join(tmp, 'passwords.xlsx'), buf);
fs.writeFileSync(path.join(tmp, 'a.txt'), 'x');
fs.writeFileSync(path.join(os.tmpdir(), 'outside-xlsxp.xlsx'), buf);
assert.equal(readFolderXlsx(tmp, 'sub/실적.xlsx').name, '실적.xlsx');
for (const bad of ['../outside-xlsxp.xlsx', '/etc/passwd', 'a.txt', 'passwords.xlsx', 'sub/없는.xlsx', '']) assert.throws(() => readFolderXlsx(tmp, bad), undefined, `거부: ${bad}`);
try { fs.symlinkSync(path.join(tmp, 'sub', '실적.xlsx'), path.join(tmp, 'link.xlsx')); assert.throws(() => readFolderXlsx(tmp, 'link.xlsx'), /읽을 수 없는/, '링크는 따라가지 않는다'); } catch (e) { if (e.code !== 'EPERM') throw e; }

// --- 서버 API ---
const { server } = require('../server');
server.listen(0, '127.0.0.1', async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (u, b) => fetch(base + u, { method: 'POST', body: JSON.stringify(b) });
  try {
    const up = await (await fetch(base + '/api/xlsx/inspect?name=' + encodeURIComponent('실적.xlsx'), { method: 'POST', body: buf })).json();
    assert(up.token && up.sheets.length === 2 && up.name === '실적.xlsx');
    const ex = await (await post('/api/xlsx/extract', { token: up.token, picks: [{ sheet: 0, from: 4, to: 6, header: 3, cols: [0, 1, 2, 4] }], maxChars: 5000 })).json();
    assert(ex.text.includes('홍길동') && !ex.text.includes('010-') && ex.rows === 3);
    const pv = await (await post('/api/xlsx/extract', { token: up.token, picks: [{ sheet: 0, from: 1, to: 7 }], preview: true })).json();
    assert(pv.text.split('\n').length <= 14);
    assert.equal((await post('/api/xlsx/extract', { token: 'nope', picks: [{ sheet: 0, from: 1, to: 2 }] })).status, 404);
    assert.equal((await post('/api/xlsx/extract', { token: up.token, picks: [] })).status, 400);
    const bad = await fetch(base + '/api/xlsx/inspect?name=a.xlsx', { method: 'POST', body: Buffer.from('xxxx') });
    assert.equal(bad.status, 400);
    const fo = await (await post('/api/xlsx/inspect-folder', { path: tmp, rel: 'sub/실적.xlsx' })).json();
    assert(fo.token && fo.sheets[0].name === '배차실적');
    assert.equal((await post('/api/xlsx/inspect-folder', { path: tmp, rel: '../outside-xlsxp.xlsx' })).status, 400);
    console.log('xlsx_pick.js: ok');
  } catch (e) { console.error(e); process.exitCode = 1; } finally { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(path.join(os.tmpdir(), 'outside-xlsxp.xlsx'), { force: true }); }
});
