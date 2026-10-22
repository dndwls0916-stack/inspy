// 참가자 수 자유(같은 AI 여러 자리) + 제한 없는 합의 토론 검증. 실행: npm test
const assert = require('assert');
process.env.MOCK = '1';
const { server } = require('../server');
const { transcriptOf } = require('../lib/council');

// --- 회의록 압축: 4라운드부터 첫 라운드 + 최근 2라운드만 원문, 중간은 판정 요약 ---
const label = (id) => id;
const rounds = [1, 2, 3, 4, 5, 6].map((n) => [{ who: 'a', text: `원문${n}` }]);
const sums = { 2: '요약2', 3: '요약3', 4: '요약4' };
const t = transcriptOf(rounds, label, 6, sums);
assert(t.includes('원문1') && t.includes('원문5') && t.includes('원문6'), '첫 라운드와 최근 2라운드는 원문');
assert(!t.includes('원문2') && !t.includes('원문3') && !t.includes('원문4'), '중간 라운드는 원문이 빠진다');
assert(t.includes('요약2') && t.includes('요약3') && t.includes('요약4'));
assert(transcriptOf(rounds, label, 3, sums).includes('원문2'), '3라운드까지는 원문 그대로');
assert(transcriptOf(rounds, label, 6, {}).includes('원문3'), '요약이 없으면 원문 유지(정보를 잃지 않는다)');
const long = Array.from({ length: 30 }, (_, i) => [{ who: 'a', text: 'x'.repeat(3000) + i }]);
const longSums = Object.fromEntries(long.map((_, i) => [i + 1, '요약']));
assert(transcriptOf(long, label, 30, longSums).length < 3 * 3100 + 30 * 100, '30라운드여도 회의록 길이가 선형으로 커지지 않는다');

async function run(base, body) {
  const res = await fetch(`${base}/api/council`, { method: 'POST', body: JSON.stringify(body) });
  if (!res.headers.get('content-type').includes('event-stream')) return { status: res.status, json: await res.json() };
  const events = [];
  let buf = '';
  for await (const c of res.body) {
    buf += Buffer.from(c).toString();
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 2); if (l.startsWith('data: ')) events.push(JSON.parse(l.slice(6))); }
  }
  return { status: 200, events };
}

server.listen(0, '127.0.0.1', async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // 1) 한 명만
    let r = await run(base, { question: 'Q', rounds: 1, moderator: 'claude', mode: 'api', participants: [{ id: 'claude' }] });
    assert(r.events.some((e) => e.type === 'final'), '혼자서도 회의가 끝난다');
    // 2) 같은 AI 여러 자리 + 다른 역할
    r = await run(base, { question: 'Q', rounds: 1, moderator: 'claude-2', mode: 'api', participants: [{ id: 'claude', role: 'lawyer' }, { id: 'claude-2', role: 'critic' }, { id: 'gpt', role: 'investor' }] });
    const start = r.events.find((e) => e.type === 'start');
    assert.deepEqual(start.participants.map((p) => [p.id, p.provider, p.label]), [['claude', 'claude', 'Claude 1'], ['claude-2', 'claude', 'Claude 2'], ['gpt', 'gpt', 'GPT']]);
    const turns = r.events.filter((e) => e.type === 'turn');
    assert.equal(turns.length, 3);
    const byWho = Object.fromEntries(turns.map((x) => [x.who, x]));
    assert(byWho.claude.text.includes('(역할: 변호사)') && byWho['claude-2'].text.includes('(역할: 비판자(악마의 변호인))'), '같은 AI 라도 자리마다 다른 역할');
    assert.equal(byWho['claude-2'].label, 'Claude 2');
    assert.equal(r.events.find((e) => e.type === 'final').who, 'claude-2', '사회자는 자리 id 로 지정');
    // 3) 여섯 자리 / 잘못된 id 무시 / 8자리 초과는 자름
    const six = ['gpt', 'gpt-2', 'gemini', 'gemini-2', 'claude', 'claude-2'].map((id) => ({ id }));
    r = await run(base, { question: 'Q', rounds: 1, moderator: 'gpt', mode: 'api', participants: six });
    assert.equal(r.events.filter((e) => e.type === 'turn').length, 6);
    r = await run(base, { question: 'Q', rounds: 1, moderator: 'gpt', mode: 'api', participants: [{ id: 'gpt' }, { id: '../etc' }, { id: 'evil-99x' }, { id: 'nope' }, { id: 'gpt' }] });
    assert.equal(r.events.find((e) => e.type === 'start').participants.length, 1, '잘못된/중복 id 는 무시');
    const many = Array.from({ length: 12 }, (_, i) => ({ id: i ? `gpt-${i + 1}` : 'gpt' }));
    r = await run(base, { question: 'Q', rounds: 1, moderator: 'gpt', mode: 'api', participants: many });
    assert.equal(r.events.find((e) => e.type === 'start').participants.length, 8, '최대 8자리');
    // 4) 구성되지 않은 AI 이름으로 오류
    // (MOCK 에서는 모두 구성된 것으로 보므로, 모르는 모드/빈 참가자만 확인)
    r = await run(base, { question: 'Q', participants: [{ id: 'nope' }] });
    assert.equal(r.status, 400);

    // 5) 합의까지 제한 없음: 상한 30, 합의되면 그 라운드에서 종료
    r = await run(base, { question: 'Q', consensus: true, unlimited: true, moderator: 'claude', mode: 'api', participants: [{ id: 'gpt' }, { id: 'claude' }] });
    const s2 = r.events.find((e) => e.type === 'start');
    assert.equal(s2.unlimited, true); assert.equal(s2.maxRounds, 30);
    const fin = r.events.find((e) => e.type === 'final');
    assert(fin.consensus.reached && fin.consensus.round === 3, '합의되면 제한과 상관없이 바로 끝난다');
    // 평행선(STALL)이면 상한까지 가지 않고 멈춘다
    r = await run(base, { question: 'STALL 평행선', consensus: true, unlimited: true, moderator: 'claude', mode: 'api', participants: [{ id: 'gpt' }, { id: 'claude' }] });
    const f2 = r.events.find((e) => e.type === 'final');
    assert(!f2.consensus.reached && f2.consensus.reason.includes('평행선') && f2.consensus.round <= 4);
    // unlimited 는 합의 모드에서만 의미가 있다
    r = await run(base, { question: 'Q', rounds: 2, unlimited: true, moderator: 'claude', mode: 'api', participants: [{ id: 'gpt' }, { id: 'claude' }] });
    assert.equal(r.events.find((e) => e.type === 'start').unlimited, false);
    console.log('seats.js: ok');
  } catch (e) { console.error(e); process.exitCode = 1; } finally { server.close(); }
});
