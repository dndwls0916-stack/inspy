// 합의 모드 검증(데모 응답 사용). 실행: npm test
const assert = require('assert');
process.env.MOCK = '1';
const { server } = require('../server');
const { parseVerdict } = require('../lib/council');

// --- 판정 응답 해석: 형식이 깨져도 "합의"로 오인하지 않는다 ---
assert.deepEqual(parseVerdict('{"consensus": true, "summary": "같음", "disagreements": [], "stalled": false}'), { reached: true, summary: '같음', disagreements: [], positions: [], stalled: false });
assert.equal(parseVerdict('```json\n{"consensus": true, "summary": "x"}\n```').reached, true, '코드블록으로 감싸도 해석');
assert.equal(parseVerdict('판정 결과입니다. {"consensus": false, "disagreements": ["가", "나"]} 끝.').disagreements.length, 2, '앞뒤 설명이 붙어도 해석');
assert.equal(parseVerdict('합의되었습니다').reached, false, 'JSON 이 아니면 합의 아님');
assert.equal(parseVerdict('{"consensus": "true"}').reached, false, '문자열 "true" 는 합의로 보지 않음');
assert.equal(parseVerdict('{깨진 json').reached, false);
assert.equal(parseVerdict('').reached, false);

async function run(base, body) {
  const res = await fetch(`${base}/api/council`, { method: 'POST', body: JSON.stringify(body) });
  const events = [];
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6)));
    }
  }
  return events;
}
const P3 = [{ id: 'gpt' }, { id: 'gemini' }, { id: 'claude' }];

server.listen(0, '127.0.0.1', async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // 1) 합의될 때까지: 데모는 3라운드째에 합의 → 3라운드 x 3명 = 9발언, 판정 2회(2·3라운드)
    let ev = await run(base, { question: '테스트', participants: P3, consensus: true, maxRounds: 6, moderator: 'claude' });
    assert.equal(ev.filter((e) => e.type === 'round').length, 3, '합의되면 거기서 멈춤');
    assert.equal(ev.filter((e) => e.type === 'turn').length, 9);
    const cs = ev.filter((e) => e.type === 'consensus');
    assert.deepEqual(cs.map((c) => c.reached), [false, true], '2라운드 불합의 → 3라운드 합의');
    assert.equal(cs[0].round, 2, '1라운드는 독립 의견이라 판정하지 않음');
    assert(cs[0].disagreements.length > 0, '남은 쟁점 전달');
    const fin = ev.find((e) => e.type === 'final');
    assert.deepEqual(fin.consensus, { reached: true, round: 3, reason: '', partial: false, missing: [] });
    assert.equal(ev.at(-1).type, 'done');

    // 2) 끝까지 합의 못함: 상한(3)에서 멈추고 합의 못함으로 표시
    ev = await run(base, { question: 'NEVER-AGREE', participants: P3, consensus: true, maxRounds: 3, moderator: 'claude' });
    assert.equal(ev.filter((e) => e.type === 'round').length, 3, '상한에서 멈춤');
    assert.equal(ev.find((e) => e.type === 'final').consensus.reached, false);
    assert(ev.find((e) => e.type === 'final').consensus.reason.includes('최대 3라운드'), '이유 표시');

    // 3) 평행선: 진전 없음이 두 번 연속이면 상한 전에 멈춘다
    ev = await run(base, { question: 'STALL', participants: P3, consensus: true, maxRounds: 8, moderator: 'claude' });
    assert.equal(ev.filter((e) => e.type === 'round').length, 3, '2·3라운드 판정이 연속 stalled → 3라운드에서 중단');
    assert(ev.find((e) => e.type === 'final').consensus.reason.includes('평행선'));

    // 4) 혼자면 토론할 상대가 없으므로 1라운드로 끝
    ev = await run(base, { question: '혼자', participants: [{ id: 'claude' }], consensus: true, maxRounds: 6, moderator: 'claude' });
    assert.equal(ev.filter((e) => e.type === 'round').length, 1);
    assert.equal(ev.filter((e) => e.type === 'consensus').length, 0);

    // 5) 상한은 비용 보호를 위해 8 로 제한
    ev = await run(base, { question: 'NEVER-AGREE', participants: [{ id: 'gpt' }, { id: 'claude' }], consensus: true, maxRounds: 999, moderator: 'claude' });
    assert.equal(ev.find((e) => e.type === 'start').maxRounds, 8, '최대 8라운드로 제한');

    // 6) 일반 모드는 그대로: 판정 없음
    ev = await run(base, { question: '일반', participants: P3, rounds: 2, moderator: 'claude' });
    assert.equal(ev.filter((e) => e.type === 'consensus').length, 0);
    assert.equal(ev.find((e) => e.type === 'final').consensus, null);
    console.log('OK: 합의 모드');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});
