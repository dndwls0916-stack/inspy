// 평가 케이스(저장·실행 결과 채점·백업) 검증. 실행: npm test
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.MOCK = '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'evals-'));
process.env.MINUTES_DIR = path.join(tmp, 'm');
process.env.PROFILE_FILE = path.join(tmp, 'p.md');
const E = require('../lib/evals');
const backup = require('../lib/backup');
const dir = process.env.MINUTES_DIR;

assert.throws(() => E.addCase(dir, { question: '짧' }), /질문을 입력/);
const c = E.addCase(dir, { title: '단가 인상 대응', question: 'B캠프 용차 단가 1200원 인상 요구에 어떻게 대응할까', expect: '협상\n 원가 \n협상\n\n일정' });
assert.deepEqual(c.expect, ['협상', '원가', '일정'], '기대 포인트는 줄마다 하나, 중복·빈 줄 제거');
assert.equal(E.addCase(dir, { question: '제목 없는 케이스입니다 질문' }).title, '제목 없는 케이스입니다 질문');

// 채점: 기대 포인트(띄어쓰기 무시), 질문에 없는 숫자
let r = E.addRun(dir, c.id, { label: 'A 설정', config: 'GPT+Claude · api', conclusion: '## 결론\n원가를 확인한 뒤 협 상 날짜를 잡는다. 인상폭은 1200원이 아니라 3500원까지 가능', reached: true, calls: 9, inChars: 5000, outChars: 900, ms: 12000 });
assert.deepEqual(r.score.hit, ["협상", "원가"]); assert.deepEqual(r.score.miss, ["일정"]);
assert.equal(r.score.expectTotal, 3);
assert.deepEqual(r.score.invented, ['3500원'], '질문에 없는 숫자만 걸린다');
assert.equal(r.ok, true);
const r2 = E.addRun(dir, c.id, { label: 'B 설정', conclusion: '' , error: '호출 실패' });
assert.equal(r2.ok, false); assert.equal(r2.score, null);
assert.throws(() => E.addRun(dir, 'nope', { conclusion: 'x' }), /없는 케이스/);
assert.equal(E.readAll(dir).runs.length, 2);

// 수정·삭제(케이스를 지우면 결과도 함께)
E.updateCase(dir, c.id, { expect: '원가' });
assert.deepEqual(E.readAll(dir).cases[0].expect, ['원가']);
E.removeRun(dir, r2.id);
assert.equal(E.readAll(dir).runs.length, 1);

// 백업 왕복(새 케이스와 그 결과가 함께 들어오고, 두 번째는 변화 없음)
const { buffer } = backup.build({ minutesDir: dir, profileText: '' });
const dest = path.join(tmp, 'other');
const noop = { minutesDir: dest, readProfile: () => '', writeProfile() {} };
assert.equal(backup.restore(buffer, noop).evalCases, 2);
assert.equal(E.readAll(dest).runs.length, 1);
assert.equal(backup.restore(buffer, noop).evalCases, 0);
E.removeCase(dir, c.id);
assert.equal(E.readAll(dir).runs.length, 0, '케이스를 지우면 결과도 지워진다');
assert.equal(E.merge(dest, { cases: [{ id: '../x', question: '질문입니다 충분히' }] }), 0);

const { server } = require('../server');
server.listen(0, '127.0.0.1', async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (u, b, h) => fetch(base + u, { method: 'POST', headers: h, body: JSON.stringify(b) });
  try {
    const a = await (await post('/api/evals/add', { title: 'API', question: 'API 로 추가한 질문입니다', expect: ['포인트'] })).json();
    const run = await (await post('/api/evals/run', { caseId: a.item.id, run: { label: 'x', conclusion: '포인트 있음' } })).json();
    assert.deepEqual(run.item.score.hit, ['포인트']);
    const all = await (await fetch(`${base}/api/evals`)).json();
    assert.equal(all.cases.some((x) => x.id === a.item.id), true);
    assert.equal((await post('/api/evals/run-delete', { id: run.item.id })).status, 200);
    assert.equal((await post('/api/evals/delete', { id: a.item.id })).status, 200);
    assert.equal((await post('/api/evals/add', { question: 'x' })).status, 400);
    assert.equal((await post('/api/evals/nope', {})).status, 404);
    assert.equal((await post('/api/evals/add', { question: '다른 사이트의 요청입니다' }, { origin: 'http://evil.example' })).status, 403);
    console.log('evals.js: ok');
  } catch (e) { console.error(e); process.exitCode = 1; } finally { server.close(); }
});
