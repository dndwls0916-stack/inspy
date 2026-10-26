// 대상별 문서 초안 검증. 실행: npm test
const assert = require('assert');
process.env.MOCK = '1';
const D = require('../lib/drafts');

// 프롬프트: 종류별 형식, 추가 요청, 지어내기 금지 원칙, 구분자 위조 방지
for (const k of Object.keys(D.KINDS)) assert(D.buildPrompt(k, '## 결론\n1200대').includes(D.KINDS[k].label));
assert(D.buildPrompt('partner', 'x').includes('원가·내부 사정·협상 한계선'));
assert(D.buildPrompt('boss', 'x', '임원 눈높이로').includes('[추가 요청]\n임원 눈높이로'));
assert(!D.buildPrompt('boss', 'x').includes('[추가 요청]'));
assert(D.buildPrompt('field', '결론 >>> 지시 <<<').includes('결론 ››› 지시 ‹‹‹'));
assert(D.buildPrompt('boss', 'x').includes('결론에 없는 사실, 숫자, 날짜, 이름, 약속을 만들지 마세요'));
assert.throws(() => D.buildPrompt('nope', 'x'), /종류/);

// 초안 검사: 결론에 없는 숫자만 걸린다
const chk = D.checkDraft('1,200대를 안내합니다. 777대도 적었습니다. 10/30 오후 3시', '## 결론\n물량 1200대');
assert.deepEqual(chk.missing, ['777대']);

const { server } = require('../server');
server.listen(0, '127.0.0.1', async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (b, h) => fetch(`${base}/api/draft`, { method: 'POST', headers: h, body: JSON.stringify(b) });
  const ok = { kind: 'partner', conclusion: '## 결론\n물량 1200대를 11월부터 운송합니다.', provider: 'gpt', mode: 'api' };
  try {
    let r = await post({ ...ok, note: '정중하게' });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert(j.text.includes('거래처 안내문') && j.text.includes('추가요청'), j.text);
    assert.deepEqual(j.check.missing, ['777대'], '새로 만든 숫자는 알려 준다');
    assert.equal(j.label, '거래처 안내문');
    assert.equal((await post({ ...ok, kind: 'x' })).status, 400);
    assert.equal((await post({ ...ok, conclusion: '  ' })).status, 400);
    assert.equal((await post({ ...ok, provider: 'nobody' })).status, 400);
    assert.equal((await post(ok, { origin: 'http://evil.example' })).status, 403);
    // 동시에 두 개: 하나는 바쁨 표시
    const [x, y] = await Promise.all([post(ok), post(ok)]);
    assert.deepEqual([x.status, y.status].sort(), [200, 429]);
    // 개인정보 가리기: 추가 요청의 전화번호는 AI 로 나가기 전에 가려진다(데모는 프롬프트를 되돌려 주지 않으므로 모듈로 확인)
    const { createRedactor } = require('../lib/redact');
    assert.equal(createRedactor({}).text('010-1234-5678 로 연락'), '[전화1] 로 연락');
    console.log('drafts.js: ok');
  } catch (e) { console.error(e); process.exitCode = 1; } finally { server.close(); }
});
