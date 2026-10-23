// 안전 묶음 검증: 호출 상한, 동시 회의 제한, 예상 호출 수, 회의록 자동 저장. 실행: npm test
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.MOCK = '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'council-minutes-'));
process.env.MINUTES_DIR = path.join(tmp, '회의록');
const { server } = require('../server');
const { estimate } = require('../lib/estimate');
const { renderMinutes, createMinutes } = require('../lib/minutes');

// --- 예상 호출 수: council.js 의 호출 구조와 같은 식 ---
assert.deepEqual(estimate({ n: 3, rounds: 2 }).calls, { min: 7, max: 7, uncapped: 7, capped: false }, '고정 라운드: 3×2 + 결론 1');
assert.equal(estimate({ n: 3, rounds: 2, persona: true }).calls.max, 8, '삼국지 모드는 제갈량 호출 +1');
for (const [args, label] of [[{ n: 8, consensus: true, unlimited: true, maxCalls: 10 }, '8명 합의 상한 10'], [{ n: 3, rounds: 3, persona: true, maxCalls: 10 }, '3명 3라운드 제갈량 상한 10'], [{ n: 4, rounds: 3, maxCalls: 10 }, '4명 3라운드 상한 10'], [{ n: 3, consensus: true, unlimited: true, maxCalls: 30 }, '합의 제한 없음 상한 30']]) {
  const x = estimate(args);
  assert(x.calls.min <= x.calls.max, `${label}: 범위가 뒤집히지 않는다 (${x.calls.min}~${x.calls.max})`);
  assert(x.inputTokens.min <= x.inputTokens.max && x.calls.max <= args.maxCalls + (args.persona ? 1 : 0) + 8, `${label}: 최대는 상한 근처`);
}
assert.equal(estimate({ n: 1, rounds: 1 }).calls.max, 2);
let e = estimate({ n: 3, consensus: true, maxRounds: 4 });
assert.equal(e.calls.min, 11, '합의 최소: 2라운드 발언 6 + 판정 1 + 확인 3 + 결론 1');
assert.equal(e.calls.max, 3 * 4 + 3 * (1 + 3) + 1, '합의 최대: 매 라운드 판정+확인');
e = estimate({ n: 3, consensus: true, unlimited: true, maxCalls: 120 });
assert(e.calls.capped && e.calls.max <= 120 && e.calls.max > 100 && e.calls.uncapped > 120, `제한 없음은 호출 상한(라운드 단위)에서 잘린다: ${e.calls.max}`);
assert.equal(estimate({ n: 1, consensus: true, unlimited: true }).calls.max, 2, '혼자면 합의 모드여도 1라운드');
assert(estimate({ n: 3, rounds: 2, chars: 40000 }).inputTokens.min > estimate({ n: 3, rounds: 2, chars: 0 }).inputTokens.min * 5, '첨부가 크면 입력 토큰이 크게 늘어난다');

// --- 회의록 렌더링 ---
const evs = [
  { type: 'start', consensus: true, unlimited: false, maxRounds: 4, rounds: 2, participants: [{ label: 'GPT', roleName: '변호사', model: 'gpt-x', effort: 'high', via: 'api' }] },
  { type: 'round', round: 1 }, { type: 'turn', round: 1, who: 'gpt', label: 'GPT', roleName: '변호사', text: '의견 본문', model: 'gpt-x' },
  { type: 'turn_error', round: 1, who: 'gemini', label: 'Gemini', error: '429' },
  { type: 'consensus', round: 2, reached: true, pendingRatify: true, summary: '요약', disagreements: [] },
  { type: 'ratify', round: 2, reached: false, summary: '요약', missing: ['Gemini'], votes: [{ who: 'gpt', label: 'GPT', roleName: '변호사', vote: 'conditional', condition: '비용 상한', reason: '' }] },
  { type: 'budget', message: '호출 상한 도달' },
  { type: 'final', label: 'GPT', text: '## 결론\n끝', consensus: { reached: false, reason: '호출 상한', partial: false }, missing: ['Gemini']},
  { type: 'usage', calls: 12, maxCalls: 30 },
];
const md = renderMinutes(evs, { question: '계약 괜찮을까?\n둘째 줄', status: '완료', attachments: ['a.pdf'], mode: 'api' });
for (const must of ['# 회의록: 계약 괜찮을까?', '> 둘째 줄', '| GPT | 변호사 | gpt-x | high | api |', '의견 본문', 'Gemini', '오류', '합의 후보', '**조건부** GPT · 변호사 — 비용 상한', '호출 상한 도달', '불참: Gemini', 'AI 호출 12회 / 상한 30회', 'a.pdf', '내용은 저장하지 않음']) assert(md.includes(must), `회의록에 "${must}" 포함`);
assert(!renderMinutes([], { question: 'q', status: '중단됨' }).includes('undefined'), '빈 기록도 렌더링');
assert(renderMinutes([], { question: 'q', status: '중단됨' }).includes('중단되어 최종 결론이 없습니다'));

// createMinutes: 이벤트마다 JSONL, 덮어쓰기 금지, 저장 실패해도 예외 없음
const dir = path.join(tmp, 'direct');
const m1 = createMinutes({ dir, question: '../../evil/이름: 테스트?' });
m1.push({ type: 'thinking', who: 'x' }); m1.push({ type: 'turn', text: '기록' });
const f1 = m1.finish('완료');
assert(f1.startsWith(dir) && f1.endsWith('.md') && !f1.includes('..'), '회의록 폴더 밖으로 나가지 않는다');
assert.equal(fs.readFileSync(f1.replace(/\.md$/, '.jsonl'), 'utf8').trim().split('\n').filter((l) => JSON.parse(l).type === 'turn').length, 1, 'thinking 은 기록하지 않고 turn 만');
const m2 = createMinutes({ dir, question: '../../evil/이름: 테스트?' });
assert.equal(fs.readdirSync(dir).length >= 3, true, '같은 이름이라도 새 파일(덮어쓰기 없음)');
const m3 = createMinutes({ dir, question: '강제 종료될 긴 질문\n둘째 줄', attachments: ['x.txt'], mode: 'api' });
m3.push({ type: 'turn', text: '발언' }); // finish 없이 프로세스가 죽은 상황
const crashed = fs.readdirSync(dir).filter((f) => f.includes('강제 종료될') && f.endsWith('.jsonl'));
const first = JSON.parse(fs.readFileSync(path.join(dir, crashed[0]), 'utf8').split('\n')[0]);
assert(first.type === 'meta' && first.question.includes('둘째 줄') && first.attachments[0] === 'x.txt', '질문과 설정이 JSONL 맨 앞줄에 남는다');
const m4 = createMinutes({ dir, question: '정상 종료' }); m4.finish('완료');
const lines4 = fs.readFileSync(path.join(dir, fs.readdirSync(dir).find((f) => f.includes('정상 종료') && f.endsWith('.jsonl'))), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
assert(lines4.at(-1).type === 'end' && lines4.at(-1).status === '완료', '종료 상태가 마지막 줄에 남는다');
const bad = createMinutes({ dir: path.join(__filename, 'x'), question: 'q' }); // 파일 아래에 폴더를 만들 수 없음
bad.push({ type: 'turn', text: 'x' });
assert.equal(bad.finish('완료'), null, '저장할 수 없어도 예외 없이 null');

// --- 한 호출 안의 재시도(노력 설정 거절 → 설정 없이 재시도)도 요청 수로 센다 ---
const prov = require('../lib/providers');
async function retryTests() {
  process.env.MOCK = '0'; delete process.env.MOCK;
  process.env.OPENAI_API_KEY = 'k';
  const realFetch = global.fetch;
  let hits = 0;
  global.fetch = async (url, init) => {
    hits++;
    const body = JSON.parse(init.body);
    if (body.reasoning_effort) return new Response(JSON.stringify({ error: { message: "Unsupported parameter: 'reasoning_effort'" } }), { status: 400 });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
  };
  let reqs = 0;
  assert.equal(await prov.callProvider('gpt', { mode: 'api', model: 'gpt-4o', system: 's', prompt: 'p', effort: 'high', onRequest: () => reqs++ }), 'ok');
  assert.equal(reqs, 2, '거절 후 재시도까지 요청 2회로 센다'); assert.equal(hits, 2);
  // 상한 오류는 재시도 체인을 끊는다
  hits = 0;
  const budgetErr = Object.assign(new Error('상한'), { budget: true });
  let n = 0;
  await assert.rejects(prov.callProvider('gpt', { mode: 'api', model: 'gpt-4o', system: 's', prompt: 'p', effort: 'high', onRequest: () => { if (n++ >= 1) throw budgetErr; } }), (e) => e.budget === true);
  assert.equal(hits, 1, '두 번째 요청은 보내지 않는다');
  global.fetch = realFetch;
  process.env.MOCK = '1';
}


const used = (r) => r.events.find((x) => x.type === 'usage');

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
  const P3 = [{ id: 'gpt' }, { id: 'gemini' }, { id: 'claude' }];
  const b = (q, extra = {}) => ({ question: q, participants: P3, moderator: 'claude', mode: 'api', ...extra });
  try {
    // 1) 호출 상한: 상한에 닿으면 멈추고 결론을 정리, 호출 수는 상한을 넘지 않는다
    let r = await run(base, b('NEVER-AGREE 상한', { consensus: true, unlimited: true, maxCalls: 30 }));
    assert.equal(r.status, 200);
    const bud = r.events.find((x) => x.type === 'budget');
    assert(bud && bud.max === 30 && bud.used <= 30, `상한 알림: ${JSON.stringify(bud)}`);
    let fin = r.events.find((x) => x.type === 'final');
    assert(fin && fin.budgetStopped && fin.maxCalls === 30, '상한으로 멈춤 표시');
    assert(used(r).calls <= 30 && used(r).calls >= 20, `실제 사용 ${used(r).calls}/30`);
    assert(!fin.consensus.reached && fin.consensus.reason.includes('호출 상한'));
    assert(r.events.findIndex((x) => x.type === 'budget') < r.events.findIndex((x) => x.type === 'final'), '상한 알림 뒤에 결론');
    assert(fin.text.includes('프롬프트'), 'mock 은 최종 프롬프트를 표시'); // (mock 문구 확인)
    // 1-b) 대체 호출(결론/판정 실패 → 다른 참가자)이 있어도 상한을 넘지 않는다
    r = await run(base, b('FAIL-FINAL-CLAUDE 대체', { rounds: 3, maxCalls: 10 }));
    assert(r.events.some((x) => x.type === 'turn_error' && x.round === 'final'), '사회자 결론 호출 실패');
    assert(r.events.some((x) => x.type === 'final' && x.who !== 'claude'), '다른 참가자가 대신 결론을 정리');
    assert(used(r).calls <= 10, `대체 호출 포함 ${used(r).calls}/10`);
    r = await run(base, b('FAIL-JUDGE-CLAUDE NEVER-AGREE', { consensus: true, maxRounds: 4, maxCalls: 12 }));
    assert(used(r).calls <= 12, `판정 대체 호출 포함 ${used(r).calls}/12`);
    // 1-c) AI 에게 결론을 시킬 호출조차 남지 않으면 AI 호출 없이 마지막 발언을 모아 보여 준다
    const C8 = Array.from({ length: 8 }, (_, i) => ({ id: i ? `claude-${i + 1}` : 'claude' }));
    r = await run(base, b('FAIL-FINAL-CLAUDE 전부 실패', { participants: C8, rounds: 1, maxCalls: 10 }));
    fin = r.events.find((x) => x.type === 'final');
    assert(fin && fin.local && fin.text.includes('호출 상한(10회)에 도달해 AI가 결론을 정리하지 못했습니다') && fin.text.includes('참가자별 마지막 발언'), '로컬 결론');
    assert.equal(used(r).calls, 10, '상한 정확히 10회');
    // 1-d) 제갈량(삼국지) 호출도 사용량에 포함: 3×2 + 결론 + 제갈량 = 8
    r = await run(base, b('제갈량 호출 포함', { rounds: 2, persona: true, maxCalls: 60 }));
    assert.equal(used(r).calls, 8, '삼국지 모드 사용 호출 8회(제갈량 포함)');
    assert(r.events.findIndex((x) => x.type === 'sage') < r.events.findIndex((x) => x.type === 'usage'), '사용량은 제갈량 뒤에 알린다');
    // 고정 라운드도 상한을 지킨다: 3명 × 3라운드(10회)를 8회 상한으로
    const P4 = [...P3, { id: 'gpt-2' }];
    r = await run(base, b('상한 고정', { participants: P4, rounds: 3, maxCalls: 10 }));
    fin = r.events.find((x) => x.type === 'final');
    assert(used(r).calls <= 10 && fin.budgetStopped, `4명×3라운드(13회)를 10회 상한으로: 호출 ${used(r).calls}/10`);
    assert.equal(used(r).calls, estimate({ n: 4, rounds: 3, maxCalls: 10 }).calls.max, '예상 호출 수가 실제와 같다(상한 적용)');
    assert.equal(r.events.filter((x) => x.type === 'round').length, 2, '3라운드는 감당할 수 없어 2라운드에서 멈춤');
    r = await run(base, b('충분한 상한', { rounds: 2, maxCalls: 60 }));
    fin = r.events.find((x) => x.type === 'final');
    assert.equal(used(r).calls, 7, '상한에 안 닿으면 계획대로 7회'); assert(!fin.budgetStopped && !r.events.some((x) => x.type === 'budget'));
    // 너무 작은 상한은 시작 전에 거절 / 기본값 / 범위 보정
    r = await run(base, b('작은 상한', { rounds: 1, maxCalls: 3 }));
    assert.equal(r.events.find((x) => x.type === 'start').maxCalls, 10, '너무 작은 상한은 10 으로 보정');
    r = await run(base, b('기본 상한', { rounds: 1 }));
    assert.equal(r.events.find((x) => x.type === 'start').maxCalls, 120, '기본 상한 120');
    r = await run(base, b('큰 상한', { rounds: 1, maxCalls: 999999 }));
    assert.equal(r.events.find((x) => x.type === 'start').maxCalls, 500, '상한은 500 까지');

    // 2) 동시 회의 제한: 3번째는 429
    const slow = () => fetch(`${base}/api/council`, { method: 'POST', body: JSON.stringify(b('동시', { rounds: 3 })) });
    const [a1, a2] = [await slow(), await slow()];
    const a3 = await slow();
    assert.equal(a3.status, 429, '동시에 3개째는 거절'); assert((await a3.json()).error.includes('진행 중'));
    for (const x of [a1, a2]) { for await (const _ of x.body); }
    const a4 = await run(base, b('끝난 뒤', { rounds: 1 }));
    assert.equal(a4.status, 200, '끝나면 다시 시작할 수 있다');

    // 3) 예상 호출 수 엔드포인트 (Host/Origin 검사 포함)
    let er = await fetch(`${base}/api/estimate`, { method: 'POST', body: JSON.stringify({ n: 3, rounds: 2 }) });
    assert.equal((await er.json()).calls.max, 7);
    er = await fetch(`${base}/api/estimate`, { method: 'POST', headers: { origin: 'https://evil.example' }, body: '{}' });
    assert.equal(er.status, 403);
    // 계산과 실제 호출 수가 일치: 고정 3라운드 / 합의(3라운드에 합의)
    r = await run(base, b('일치', { rounds: 3, maxCalls: 120 }));
    assert.equal(used(r).calls, estimate({ n: 3, rounds: 3 }).calls.max);
    r = await run(base, b('일치 합의', { consensus: true, maxRounds: 4, maxCalls: 120 }));
    fin = r.events.find((x) => x.type === 'final');
    const est = estimate({ n: 3, consensus: true, maxRounds: 4 });
    assert(used(r).calls >= est.calls.min && used(r).calls <= est.calls.max, `실제 ${used(r).calls}회는 예상 ${est.calls.min}~${est.calls.max} 안`);

    // 4) 회의록 자동 저장
    fs.rmSync(process.env.MINUTES_DIR, { recursive: true, force: true });
    r = await run(base, b('회의록 테스트 질문', { rounds: 1 }));
    const mev = r.events.find((x) => x.type === 'minutes');
    assert(mev && mev.path.startsWith(process.env.MINUTES_DIR) && fs.existsSync(mev.path), '완료 후 회의록 경로 알림');
    const text = fs.readFileSync(mev.path, 'utf8');
    assert(text.includes('상태: 완료') && text.includes('회의록 테스트 질문') && text.includes('## 최종 결론') && text.includes('GPT'));
    const lines = fs.readFileSync(mev.path.replace(/\.md$/, '.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert(lines.some((x) => x.type === 'final') && lines.every((x) => x.type !== 'thinking') && lines[0].type === 'meta' && lines.at(-1).type === 'end');
    assert.equal(r.events.at(-1).type, 'done'); assert.equal(r.events.at(-2).type, 'minutes');
    // 첨부 내용은 저장하지 않는다
    r = await run(base, b('첨부 있음', { rounds: 1, attachments: [{ name: 'secret.txt', text: '극비내용-XYZ123' }] }));
    const t2 = fs.readFileSync(r.events.find((x) => x.type === 'minutes').path, 'utf8');
    assert(t2.includes('secret.txt') && !t2.includes('극비내용-XYZ123'), '첨부는 이름만');
    const j2 = fs.readFileSync(r.events.find((x) => x.type === 'minutes').path.replace(/\.md$/, '.jsonl'), 'utf8');
    assert(!j2.includes('극비내용-XYZ123'), 'JSONL 에도 첨부 내용 없음');
    // 끄면 저장하지 않는다
    const before = fs.readdirSync(process.env.MINUTES_DIR).length;
    r = await run(base, b('저장 안 함', { rounds: 1, saveMinutes: false }));
    assert(!r.events.some((x) => x.type === 'minutes') && fs.readdirSync(process.env.MINUTES_DIR).length === before);
    // 중단(클라이언트가 연결을 끊음)해도 그때까지의 기록이 남는다
    const ac = new AbortController();
    const cut = await fetch(`${base}/api/council`, { method: 'POST', signal: ac.signal, body: JSON.stringify(b('중단될 회의', { rounds: 3 })) });
    const rd = cut.body.getReader();
    let got = '';
    while (!got.includes('"type":"turn"')) got += Buffer.from((await rd.read()).value).toString();
    ac.abort();
    await new Promise((res) => setTimeout(res, 1500));
    const files = fs.readdirSync(process.env.MINUTES_DIR).filter((f) => f.includes('중단될 회의') && f.endsWith('.md'));
    assert.equal(files.length, 1, '중단돼도 회의록 생성');
    const t3 = fs.readFileSync(path.join(process.env.MINUTES_DIR, files[0]), 'utf8');
    assert(t3.includes('상태: 중단됨') && t3.includes('중단되어 최종 결론이 없습니다'), '중단 상태와 그때까지의 기록');
    server.close();
    await retryTests();
    console.log('safety.js: ok');
  } catch (err) { console.error(err); process.exitCode = 1; } finally { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
});
