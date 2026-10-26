// 할 일(실행 계획) 추출·저장·이월·백업 검증. 실행: npm test
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.MOCK = '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'actions-'));
process.env.MINUTES_DIR = path.join(tmp, 'm');
process.env.PROFILE_FILE = path.join(tmp, '회사정보.md');
const A = require('../lib/actions');
const backup = require('../lib/backup');

// 표 읽기: 머리글·구분선·"미정" 처리, 다음 제목에서 멈춤, 표가 없으면 빈 목록
const table = '## 결론\n가\n## 실행 계획\n| 할 일 | 담당(제안) | 기한(제안) | 확인 지표 |\n|---|---|---|---|\n| 대체차량 3대 확보 | 운영팀장 | 10/30 | 확보 대수 |\n| 일정 공유 | 미정 | 미정 | |\n\n표 아래 설명\n## 다음\n| 무시 | a | b | c |';
const items = A.parseActionTable(table);
assert.deepEqual(items, [{ text: '대체차량 3대 확보', owner: '운영팀장', due: '10/30', metric: '확보 대수' }, { text: '일정 공유', owner: '', due: '', metric: '' }]);
assert.deepEqual(A.parseActionTable('## 결론\n표 없음'), []);
assert.deepEqual(A.parseActionTable(''), []);

// 추가·중복 건너뛰기·수정·삭제·이월 자료
const dir = process.env.MINUTES_DIR;
assert.equal(A.carryAttachment(dir), null);
let r = A.add(dir, '10월 운영 회의', items);
assert.deepEqual([r.added, r.skipped, r.open], [2, 0, 2]);
r = A.add(dir, '다음 회의', [{ text: ' 대체차량  3대 확보 ' }, { text: '새 항목' }]);
assert.deepEqual([r.added, r.skipped], [1, 1], '같은 내용의 미완료 항목은 건너뛴다');
let list = A.load(dir);
const first = list.find((x) => x.text.startsWith('대체차량'));
assert.equal(first.status, 'open'); assert.equal(first.meeting, '10월 운영 회의');
A.update(dir, first.id, { owner: '김팀장', due: '11/05', note: '업체 확인 중' });
assert.equal(A.load(dir).find((x) => x.id === first.id).owner, '김팀장');
assert.throws(() => A.update(dir, first.id, { status: 'weird' }), /상태/);
assert.throws(() => A.update(dir, first.id, { text: '  ' }), /비울 수 없/);
assert.throws(() => A.update(dir, 'nope', {}), /없는 항목/);
const carry = A.carryAttachment(dir);
assert.equal(carry.count, 3);
assert(carry.text.includes('담당: 김팀장') && carry.text.includes('기한: 11/05') && carry.text.includes('메모: 업체 확인 중'));
A.update(dir, first.id, { status: 'done' });
assert.equal(A.carryAttachment(dir).count, 2, '완료된 항목은 이월하지 않는다');
A.add(dir, 'x', [{ text: '대체차량 3대 확보' }]);
assert.equal(A.load(dir).filter((x) => x.text.startsWith('대체차량')).length, 2, '완료된 항목과 같은 내용은 다시 추가할 수 있다');
A.remove(dir, first.id);
assert.throws(() => A.remove(dir, first.id), /없는 항목/);

// 백업: 할 일도 함께 담기고, 가져올 때 같은 id 는 덮어쓰지 않는다
const before = A.load(dir).length;
const { buffer } = backup.build({ minutesDir: dir, profileText: '' });
const dest = path.join(tmp, 'other');
let rep = backup.restore(buffer, { minutesDir: dest, readProfile: () => '', writeProfile() {} });
assert.equal(rep.actions, before);
rep = backup.restore(buffer, { minutesDir: dest, readProfile: () => '', writeProfile() {} });
assert.equal(rep.actions, 0);
assert.equal(A.merge(dest, [{ id: '../../evil', text: 'x' }, { id: 'zzzzzzzzzzzz', text: 'x' }]), 0, '이상한 id 는 거절');

// 회의 흐름: 결론 뒤 actions 이벤트, 이월 켜면 자료와 안내가 들어간다
const { server } = require('../server');
server.listen(0, '127.0.0.1', async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const meet = async (extra) => {
    const res = await fetch(`${base}/api/council`, { method: 'POST', body: JSON.stringify({ question: 'ACTION-TEST 회의', rounds: 1, moderator: 'claude', mode: 'api', participants: [{ id: 'gpt' }, { id: 'claude' }], useProfile: false, ...extra }) });
    return (await res.text()).split('\n\n').filter((x) => x.startsWith('data: ')).map((x) => JSON.parse(x.slice(6)));
  };
  const post = (u, b) => fetch(base + u, { method: 'POST', body: JSON.stringify(b) });
  try {
    let evs = await meet({});
    const a = evs.find((e) => e.type === 'actions');
    assert(a && a.items.length === 2 && a.items[0].owner === '운영팀장');
    assert(!evs.find((e) => e.type === 'final').text.includes('이월전달'));
    assert.equal(evs.find((e) => e.type === 'start').attachments.length, 0);
    evs = await meet({ carryActions: true });
    const fin = evs.find((e) => e.type === 'final').text;
    assert(fin.includes('이월전달') && fin.includes('이월자료'), fin.slice(0, 80));
    assert(evs.find((e) => e.type === 'start').attachments.some((n) => n.includes('미완료 할 일')));
    // 할 일 API
    assert.equal((await (await post('/api/actions/add', { meeting: 'API', items: [{ text: 'API 로 추가' }] })).json()).added, 1);
    const all = (await (await fetch(`${base}/api/actions`)).json()).items;
    const it = all.find((x) => x.text === 'API 로 추가');
    assert.equal((await (await post('/api/actions/update', { id: it.id, patch: { status: 'done' } })).json()).item.status, 'done');
    assert.equal((await post('/api/actions/update', { id: it.id, patch: { status: 'bad' } })).status, 400);
    assert.equal((await post('/api/actions/delete', { id: it.id })).status, 200);
    assert.equal((await post('/api/actions/nope', {})).status, 404);
    const evil = await fetch(`${base}/api/actions/add`, { method: 'POST', headers: { origin: 'http://evil.example' }, body: JSON.stringify({ items: [{ text: 'x' }] }) });
    assert.equal(evil.status, 403);
    console.log('actions.js: ok');
  } catch (e) { console.error(e); process.exitCode = 1; } finally { server.close(); }
});
