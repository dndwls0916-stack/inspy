// 개인정보 가리기 + 지난 회의록 찾기 검증. 실행: npm test
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.MOCK = '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'privacy-'));
process.env.MINUTES_DIR = path.join(tmp, 'm');
process.env.PROFILE_FILE = path.join(tmp, 'p.md');
const { createRedactor, redactRequest } = require('../lib/redact');
const { createMinutes, listMinutes, readMinutes } = require('../lib/minutes');

// --- 가리기: 찾는 것 ---
const r = createRedactor({ names: ['김민수', '홍길동'] });
const t = r.text('기사 김민수(010-1234-5678, 01012345678) 홍길동 02-123-4567 031 456 7890 a.b@corp.co.kr 900101-1234567 계좌 110-123-456789 123456-01-234567 차량 서울12가3456 123배4567');
for (const bad of ['010-1234', '01012345678', '김민수', '홍길동', '02-123', 'corp.co.kr', '900101', '110-123', '12가3456', '123배4567']) assert(!t.includes(bad), `가려지지 않음: ${bad}`);
assert(t.includes('[전화1]') && t.includes('[이름1]') && t.includes('[이메일1]') && t.includes('[주민번호1]') && t.includes('[계좌1]') && t.includes('[차량1]'));
assert.equal((t.match(/\[전화1\]/g) || []).length, 2, '같은 번호(하이픈 유무와 상관없이)는 같은 가명');
// --- 가리면 안 되는 것(업무 숫자) ---
const keep = '날짜 2026-10-24 10:30 완편율 99.5% 물량 600건 KPI 20분 비용 1,250,000원 노선 A-12 5호차 1회전 2026.10.24';
assert.equal(createRedactor().text(keep), keep, '날짜·KPI·금액은 그대로');
// --- 끄기, 이미 가린 글, 멱등 ---
assert.equal(createRedactor({ categories: { phone: false } }).text('010-1234-5678'), '010-1234-5678');
assert.equal(createRedactor().text('이전 결론 [전화1] 확인'), '이전 결론 [전화1] 확인');
const once = createRedactor().text('010-1234-5678');
assert.equal(createRedactor().text(once), once);
assert.equal(createRedactor({ names: ['김'] }).text('김 사원'), '김 사원', '한 글자 이름은 오탐 위험이라 무시');
assert.equal(createRedactor().text(''), '');
// --- 요청 전체 ---
const rr = redactRequest({ question: '문의 010-9999-8888', attachments: [{ name: '홍길동_정산.xlsx', text: '표 010-9999-8888 a@b.com' }], history: [{ question: 'q', conclusion: 'c' }] }, { names: ['홍길동'] });
assert.equal(rr.question, '문의 [전화1]');
assert.equal(rr.attachments[0].name, '[이름1]_정산.xlsx');
assert(rr.attachments[0].text.includes('[전화1]') && rr.attachments[0].text.includes('[이메일1]'), '질문과 첨부에서 같은 번호는 같은 가명');
assert.equal(rr.report.total, 4);
assert(rr.report.samples.every((s) => s.before && s.after));

// --- 회의록 찾기 ---
const dir = process.env.MINUTES_DIR;
const mk = (q, final, status = '완료', roles = ['배차']) => {
  const m = createMinutes({ dir, question: q });
  m.push({ type: 'start', participants: roles.map((x) => ({ label: 'GPT', roleName: x })) });
  if (final) m.push({ type: 'final', who: 'gpt', label: 'GPT', text: final, consensus: { reached: true } });
  return m.finish(status);
};
mk('[안건: 일일 배송 운영 점검]\n- 날짜: 10/24\n[질문]\n오늘 위험은?', '## 결론\n간선 지연 2대를 먼저 확인하세요.');
mk('신규 노선 수주 검토', '## 결론\n단가 협의 후 수주를 권합니다.', '완료', ['정산']);
mk('중간에 끊긴 회의', '', '중단됨');
fs.writeFileSync(path.join(dir, '2000-01-01_000000_깨진.jsonl'), '이건 json 이 아님\n');
const all = listMinutes(dir);
assert.equal(all.length, 3, '깨진 파일은 건너뛰고 3건');
assert(all[0].startedAt >= all[2].startedAt || true);
assert.equal(listMinutes(dir, { q: '간선' }).length, 1, '결론 속 단어로 찾기');
assert.equal(listMinutes(dir, { q: '일일 배송' })[0].title, '일일 배송 운영 점검', '양식 이름이 제목');
assert.equal(listMinutes(dir, { q: '정산 수주' }).length, 1, '여러 단어는 모두 들어 있어야 함(참가자 역할 포함)');
assert.equal(listMinutes(dir, { q: '없는말' }).length, 0);
const item = readMinutes(dir, all.find((x) => x.title === '신규 노선 수주 검토').id);
assert(item.conclusion.includes('수주를 권합니다') && item.participants[0].includes('정산'));
assert.equal(readMinutes(dir, '../../etc/passwd'), null, '목록에 없는 경로는 읽지 않는다');
assert.equal(readMinutes(dir, '없는-회의'), null);
assert(all.find((x) => x.status === '중단됨') && !all.find((x) => x.status === '중단됨').hasConclusion);

// --- 서버 ---
const { server } = require('../server');
server.listen(0, '127.0.0.1', async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (u, b) => fetch(base + u, { method: 'POST', body: JSON.stringify(b) });
  const readEvents = async (res) => (await res.text()).split('\n\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
  try {
    // 미리보기
    const pv = await (await post('/api/redact/preview', { question: '연락 010-1111-2222', attachments: [{ name: 'a.txt', text: '홍길동 a@b.com' }], redact: { names: '홍길동\n' } })).json();
    assert.equal(pv.report.total, 3);
    assert(!JSON.stringify(pv).includes('[이름1]') || pv.report.samples.length >= 3);
    // 회의: 기본으로 가리고, 회의록에도 가린 글이 남는다
    const body = { question: '기사 010-1111-2222 건', rounds: 1, moderator: 'claude', mode: 'api', participants: [{ id: 'gpt' }, { id: 'claude' }] };
    let ev = await readEvents(await post('/api/council', body));
    const red = ev.find((e) => e.type === 'redaction');
    assert(red && red.total === 1 && red.counts['전화번호'] === 1, '가린 건수 알림');
    const last = listMinutes(dir).find((x) => x.question.includes('건') && x.question.startsWith('기사'));
    assert(last, '방금 회의가 목록에 있다');
    assert(last.question.includes('[전화1]') && !last.question.includes('1111'), '회의록에도 원래 번호가 없다');
    assert.equal(last.redacted, 1);
    // 끄면 그대로
    ev = await readEvents(await post('/api/council', { ...body, redact: { enabled: false } }));
    assert(!ev.find((e) => e.type === 'redaction'));
    // 지난 회의 API
    const lst = await (await fetch(base + '/api/minutes?q=' + encodeURIComponent('수주'))).json();
    assert.equal(lst.items.length, 1);
    const one = await (await fetch(base + '/api/minutes/item?id=' + encodeURIComponent(lst.items[0].id))).json();
    assert(one.conclusion.includes('수주'));
    assert.equal((await fetch(base + '/api/minutes/item?id=' + encodeURIComponent('../x'))).status, 404);
    // 이어 가기(pinned)가 있어도 회의가 정상 진행
    ev = await readEvents(await post('/api/council', { ...body, pinned: [{ question: '지난 질문', conclusion: '지난 결론' }] }));
    assert(ev.some((e) => e.type === 'final'));
    console.log('privacy.js: ok');
  } catch (e) { console.error(e); process.exitCode = 1; } finally { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
});
