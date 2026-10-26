// 의사결정 기록·재검토·비슷한 결정 참고 검증. 실행: npm test
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.MOCK = '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'decisions-'));
process.env.MINUTES_DIR = path.join(tmp, 'm');
process.env.PROFILE_FILE = path.join(tmp, 'p.md');
const D = require('../lib/decisions');
const backup = require('../lib/backup');
const dir = process.env.MINUTES_DIR;

// 결론 부분만 뽑기
assert.equal(D.conclusionSection('## 결론\n단가를 3% 올린다.\n둘째 줄\n## 합의된 점\n- x'), '단가를 3% 올린다. 둘째 줄');
assert.equal(D.conclusionSection('제목 없는 결론'), '제목 없는 결론');

// 기록·수정·재검토 시점
assert.throws(() => D.add(dir, { title: 'x', conclusion: '' }), /결론이 없/);
assert.throws(() => D.add(dir, { title: 'x', conclusion: '## 결론\n가', reviewDate: '내일' }), /YYYY-MM-DD/);
const a = D.add(dir, { title: 'B캠프 용차 단가 협의', question: 'B캠프 용차 단가 인상 요구에 어떻게 대응할까', conclusion: '## 결론\n단가를 3% 올리는 선에서 합의한다.', meeting: '10월 회의', reviewDate: '2026-11-30' });
const b = D.add(dir, { title: '신규 안전 교육 일정', question: '분기 안전 교육 일정과 TBM 운영', conclusion: '## 결론\n매월 첫째 주에 한다.', reviewDate: '2026-01-01' });
assert.equal(a.status, 'decided');
assert.deepEqual(D.due(dir, '2026-12-01').map((x) => x.id).sort(), [a.id, b.id].sort());
assert.deepEqual(D.due(dir, '2026-06-01').map((x) => x.id), [b.id], '날짜가 지난 것만');
D.update(dir, b.id, { outcome: 'good', result: '참석률 90%' });
assert.equal(D.load(dir).find((x) => x.id === b.id).status, 'reviewed', '결과를 적으면 재검토 완료');
assert.equal(D.due(dir, '2026-06-01').length, 0);
assert.throws(() => D.update(dir, a.id, { outcome: 'great' }), /결과/);
assert.throws(() => D.update(dir, a.id, { reviewDate: '11/30' }), /YYYY-MM-DD/);
assert.throws(() => D.update(dir, 'nope', {}), /없는 기록/);

// 비슷한 결정: 겹치면 찾고, 엉뚱한 건 안 찾고, 양식 안내문은 무시
let sim = D.similar(dir, '12월 B캠프 용차 단가 인상 요청 대응');
assert.equal(sim.length, 1); assert.equal(sim[0].id, a.id);
assert.equal(D.similar(dir, '신입 기사 채용 공고 문구').length, 0);
assert.equal(D.similar(dir, '[안건: 정산·손익 검토]\n- 대상 기간: 미확인\n(미확인 항목은 없는 것이 아니라 아직 확인되지 않은 정보입니다.)').length, 0);
assert.equal(D.similar(dir, '짧').length, 0);
D.update(dir, a.id, { status: 'dropped' });
assert.equal(D.similar(dir, '12월 B캠프 용차 단가 인상 요청 대응').length, 0, '폐기한 결정은 참고하지 않는다');
D.update(dir, a.id, { status: 'decided', outcome: 'bad', result: '업체가 이탈' });

// 참고 자료: id 로만, 결과 포함
const pa = D.precedentAttachment(dir, [a.id, '../evil', 'zz']);
assert.equal(pa.count, 1);
assert(pa.text.includes('당시 결론: 단가를 3% 올리는 선') && pa.text.includes('결과: 잘 안 됨 — 업체가 이탈'));
assert.equal(D.precedentAttachment(dir, ['nope']), null);

// 백업 왕복
const { buffer } = backup.build({ minutesDir: dir, profileText: '' });
const dest = path.join(tmp, 'other');
let rep = backup.restore(buffer, { minutesDir: dest, readProfile: () => '', writeProfile() {} });
assert.equal(rep.decisions, 2);
assert.equal(backup.restore(buffer, { minutesDir: dest, readProfile: () => '', writeProfile() {} }).decisions, 0);
assert.equal(D.merge(dest, [{ id: '../x', title: 't', summary: 's' }]), 0);

// 회의 흐름과 API
const { server } = require('../server');
server.listen(0, '127.0.0.1', async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (u, body, h) => fetch(base + u, { method: 'POST', headers: h, body: JSON.stringify(body) });
  const meet = async (extra) => {
    const res = await post('/api/council', { question: 'DECISION-TEST B캠프 용차 단가 인상 요청 대응', rounds: 1, moderator: 'claude', mode: 'api', participants: [{ id: 'gpt' }, { id: 'claude' }], useProfile: false, ...extra });
    return (await res.text()).split('\n\n').filter((x) => x.startsWith('data: ')).map((x) => JSON.parse(x.slice(6)));
  };
  try {
    let evs = await meet({});
    assert(!evs.find((e) => e.type === 'final').text.includes('과거결정전달'));
    evs = await meet({ precedents: [a.id] });
    const fin = evs.find((e) => e.type === 'final').text;
    assert(fin.includes('과거결정전달') && fin.includes('과거자료'), fin.slice(0, 80));
    assert(evs.find((e) => e.type === 'start').attachments.includes('과거 결정 (기록된 것)'));
    const st = await (await fetch(`${base}/api/decisions`)).json();
    assert.equal(st.items.length, 2); assert(Array.isArray(st.due));
    const s2 = await (await post('/api/decisions/similar', { question: '12월 B캠프 용차 단가 인상 요청 대응' })).json();
    assert.equal(s2.items.length, 1); assert(!('question' in s2.items[0]));
    const added = await (await post('/api/decisions/add', { title: 'API 결정', conclusion: '## 결론\n진행', reviewDate: '2030-01-01' })).json();
    assert.equal(added.item.title, 'API 결정');
    assert.equal((await post('/api/decisions/update', { id: added.item.id, patch: { outcome: 'mixed' } })).status, 200);
    assert.equal((await post('/api/decisions/update', { id: added.item.id, patch: { status: 'x' } })).status, 400);
    assert.equal((await post('/api/decisions/delete', { id: added.item.id })).status, 200);
    assert.equal((await post('/api/decisions/nope', {})).status, 404);
    assert.equal((await post('/api/decisions/add', { title: 'x', conclusion: '## 결론\n가' }, { origin: 'http://evil.example' })).status, 403);
    console.log('decisions.js: ok');
  } catch (e) { console.error(e); process.exitCode = 1; } finally { server.close(); }
});
