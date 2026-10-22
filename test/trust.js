// 합의 신뢰도 검증: 판정 검증, 최종안 개별 확인(투표), 실패한 참가자 구분, 소수 의견 보존. 실행: npm test
const assert = require('assert');
process.env.MOCK = '1';
const { server } = require('../server');
const { parseVerdict, parseVote, transcriptOf } = require('../lib/council');

// --- 판정 해석: 앞뒤가 안 맞으면 합의로 보지 않는다 ---
let v = parseVerdict('{"consensus": true, "summary": "같음", "disagreements": ["아직 남음"]}');
assert.equal(v.reached, false, 'consensus:true 인데 남은 쟁점이 있으면 합의 아님'); assert(v.contradiction);
v = parseVerdict('{"consensus": true, "summary": "  ", "disagreements": []}');
assert.equal(v.reached, false, '공통 결론(summary)이 비어 있으면 합의 아님');
v = parseVerdict('{"consensus": true}');
assert.equal(v.reached, false, 'summary 없이 consensus 만 오면 합의 아님');
v = parseVerdict('{"consensus": false, "summary": "s", "positions": {"GPT": "A안", "Claude": "B안", "": "x", "Gemini": ""}}');
assert.deepEqual(v.positions, [['GPT', 'A안'], ['Claude', 'B안']], '참가자별 입장 파싱(빈 항목 제거)');
assert.deepEqual(parseVerdict('{"consensus": false, "positions": ["x"]}').positions, [], '배열 형태는 무시');
assert.equal(parseVerdict('{"consensus": true, "summary": "x".repeat(10)}').reached, false, '깨진 JSON');

// --- 투표 해석: 형식이 틀리면 unknown (동의로 치지 않음) ---
assert.equal(parseVote('{"vote":"agree"}').vote, 'agree');
assert.equal(parseVote('```json\n{"vote":"conditional","condition":"비용 상한"}\n```').condition, '비용 상한');
for (const bad of ['동의합니다', '', '{"vote":"yes"}', '{"vote":"AGREE"}', '{"vote":true}', '{깨짐']) assert.equal(parseVote(bad).vote, 'unknown', `unknown: ${bad}`);

// 코드 리뷰(GPT)가 지적한 케이스
assert.equal(parseVote('{"vote":"agree","condition":"비용 상한이 있어야 함"}').vote, 'conditional', '조건을 단 동의는 조건부');
assert.equal(parseVote('{"vote":"agree","condition":"  "}').vote, 'agree', '빈 조건은 그대로 동의');
assert.equal(parseVote('{"vote":"agree","condition":{"a":1}}').vote, 'agree', '조건 타입이 틀리면 무시(동의 유지)');
v = parseVerdict('{"consensus": true, "summary": {}, "disagreements": "미해결 조건"}');
assert.equal(v.reached, false, '필드 타입이 틀린 판정은 합의 아님'); assert(v.contradiction);
assert.equal(parseVerdict('{"consensus": true, "summary": "ok", "disagreements": [1]}').reached, false, '쟁점 항목이 문자열이 아니면 합의 아님');
assert.equal(parseVerdict('{"consensus": true, "summary": "ok", "disagreements": []}').reached, true);

// --- 압축된 라운드에도 남은 쟁점/입장/조건이 남는다 ---
const rounds = [1, 2, 3, 4, 5].map((n) => [{ who: 'a', text: `원문${n}` }]);
const t = transcriptOf(rounds, (x) => x, 5, { 2: { summary: '요약2', disagreements: ['쟁점A'], positions: [['GPT', 'A안']], conditions: ['Gemini(조건부): 비용 상한'] }, 3: '문자열요약3' });
assert(t.includes('요약2') && t.includes('남은 쟁점: 쟁점A') && t.includes('GPT: A안') && t.includes('제기된 조건·반대: Gemini(조건부): 비용 상한'));
assert(t.includes('문자열요약3'), '이전 형식(문자열)도 그대로 지원');

async function run(base, body) {
  const res = await fetch(`${base}/api/council`, { method: 'POST', body: JSON.stringify(body) });
  const events = [];
  let buf = '';
  for await (const c of res.body) {
    buf += Buffer.from(c).toString();
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 2); if (l.startsWith('data: ')) events.push(JSON.parse(l.slice(6))); }
  }
  return events;
}

server.listen(0, '127.0.0.1', async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const P = [{ id: 'gpt' }, { id: 'gemini' }, { id: 'claude' }];
  const body = (q, extra = {}) => ({ question: q, participants: P, consensus: true, maxRounds: 4, moderator: 'claude', mode: 'api', ...extra });
  try {
    // 1) 모두 동의: 판정 → 최종안 확인(3명 전원 agree) → 합의
    let ev = await run(base, body('평범한 질문'));
    const cs = ev.filter((e) => e.type === 'consensus');
    assert.equal(cs.at(-1).pendingRatify, true, '판정이 합의여도 확인 투표 전이라는 표시');
    const rat = ev.filter((e) => e.type === 'ratify');
    assert.equal(rat.length, 1); assert(rat[0].reached && rat[0].votes.length === 3 && rat[0].votes.every((x) => x.vote === 'agree'));
    let fin = ev.find((e) => e.type === 'final');
    assert(fin.consensus.reached && !fin.consensus.partial && fin.consensus.missing.length === 0);
    assert(fin.text.includes('투표결과') && fin.text.includes('소수의견칸'), '최종 프롬프트에 투표 결과와 소수 의견 칸 지시');
    assert(ev.findIndex((e) => e.type === 'ratify') < ev.findIndex((e) => e.type === 'final'));

    // 2) 한 명이 조건부: 합의로 끝나지 않고 계속, 끝까지 풀리지 않으면 합의 못함 + 조건이 결론에 전달
    ev = await run(base, body('RATIFY-DISSENT 질문'));
    const rats = ev.filter((e) => e.type === 'ratify');
    assert(rats.length >= 2 && rats.every((x) => !x.reached), '매 확인에서 조건부가 있어 합의 아님');
    assert.equal(rats[0].votes.find((x) => x.who === 'gemini').vote, 'conditional');
    assert(rats[0].votes.find((x) => x.who === 'gemini').condition.includes('비용 상한'));
    fin = ev.find((e) => e.type === 'final');
    assert(!fin.consensus.reached && fin.consensus.reason.includes('최대 4라운드'), '확인 실패는 합의가 아님');
    assert(fin.text.includes('제기된조건전달'), '제기된 조건이 최종 프롬프트에 전달');
    assert.equal(ev.filter((e) => e.type === 'round').length, 4, '확인에 실패하면 토론이 이어짐');

    // 3) 응답 실패/형식 오류는 동의로 치지 않는다 (unknown)
    for (const tag of ['RATIFY-FAIL', 'RATIFY-BAD']) {
      ev = await run(base, body(`${tag} 질문`, { maxRounds: 3 }));
      const r1 = ev.find((e) => e.type === 'ratify');
      assert.equal(r1.votes.find((x) => x.who === 'gemini').vote, 'unknown', `${tag}: unknown`);
      assert(!r1.reached, `${tag}: 합의로 치지 않음`);
      assert(!ev.find((e) => e.type === 'final').consensus.reached);
    }

    // 4) 토론 중 호출이 실패한 참가자: 나머지가 합의해도 "전원 합의"가 아니라 "응답자 합의"로 표시
    ev = await run(base, body('FAIL-ROUND2 질문'));
    assert(ev.some((e) => e.type === 'turn_error' && e.who === 'gemini'));
    const r4 = ev.find((e) => e.type === 'ratify');
    assert.deepEqual(r4.votes.map((x) => x.who).sort(), ['claude', 'gpt'], '실패한 참가자는 투표 대상이 아님');
    assert.deepEqual(r4.missing, ['Gemini'], '투표 결과에도 불참자 표시');
    fin = ev.find((e) => e.type === 'final');
    assert(fin.consensus.reached && fin.consensus.partial, '응답자 합의');
    assert.deepEqual(fin.consensus.missing, ['Gemini']);
    assert(fin.text.includes('불참자안내'), '최종 프롬프트에 불참자 안내(전원 합의라고 쓰지 말 것)');

    // 5) 합의 모드가 아니어도 실패한 참가자는 최종 프롬프트에 표시
    ev = await run(base, { question: 'FAIL-ROUND2 고정', participants: P, rounds: 2, moderator: 'claude', mode: 'api' });
    fin = ev.find((e) => e.type === 'final');
    assert(fin.text.includes('실패자표시'), '고정 라운드에서도 불참자 표시');
    assert(!ev.some((e) => e.type === 'ratify'), '합의 모드가 아니면 최종안 확인 없음');

    // 5-2) 투표 실패/같은 조건 반복: 정체로 보고 종료한다(제한 없음에서도 30라운드까지 가지 않는다)
    ev = await run(base, body('RATIFY-DISSENT 반복', { unlimited: true, maxRounds: undefined }));
    const rr = ev.filter((e) => e.type === 'round').length;
    fin = ev.find((e) => e.type === 'final');
    assert(!fin.consensus.reached && fin.consensus.reason.includes('같은 조건·반대가 반복'), `정체 종료: ${fin.consensus.reason}`);
    assert(rr <= 6, `라운드 ${rr}: 30까지 가지 않는다`);
    ev = await run(base, body('RATIFY-FAIL 반복', { unlimited: true }));
    fin = ev.find((e) => e.type === 'final');
    assert(!fin.consensus.reached && ev.filter((e) => e.type === 'round').length <= 6, '확인 호출이 계속 실패해도 정체 종료');

    // 5-3) 합의 못 하고 끝나도 호출 실패한 참가자를 알린다
    ev = await run(base, body('FAIL-ROUND2 STALL 평행선'));
    fin = ev.find((e) => e.type === 'final');
    assert(!fin.consensus.reached); assert.deepEqual(fin.missing, ['Gemini'], '최종 이벤트에 불참자'); assert.deepEqual(fin.consensus.missing, ['Gemini']);
    assert(fin.text.includes('실패자표시'), '합의 실패일 때도 최종 프롬프트에 불참자 표시');

    // 6) 혼자일 때는 확인 투표가 없고 1라운드로 끝난다
    ev = await run(base, { question: 'Q', participants: [{ id: 'claude' }], consensus: true, maxRounds: 4, moderator: 'claude', mode: 'api' });
    assert(!ev.some((e) => e.type === 'ratify') && ev.some((e) => e.type === 'final'));
    console.log('trust.js: ok');
  } catch (e) { console.error(e); process.exitCode = 1; } finally { server.close(); }
});
