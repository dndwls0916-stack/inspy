// 사용량 요약(회의록에서 호출 수·글자 수 집계) 검증. 실행: npm test
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.MOCK = '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-'));
process.env.MINUTES_DIR = path.join(tmp, 'm');
const U = require('../lib/usage');
const dir = process.env.MINUTES_DIR;

// 옛 형식 회의록(상세 없음)과 오래된 회의록을 직접 만든다
fs.mkdirSync(dir, { recursive: true });
const old = (name, startedAt, usage) => fs.writeFileSync(path.join(dir, `${name}.jsonl`), [{ type: 'meta', question: '[안건: 옛 회의]\nx', startedAt, mode: 'api' }, { type: 'start', participants: [{ id: 'gpt' }, { id: 'claude' }], rounds: 2 }, usage, { type: 'end', status: '완료' }].filter(Boolean).map((x) => JSON.stringify(x)).join('\n'));
old('2020-01-01_000000_옛', '2020-01-01T00:00:00Z', { type: 'usage', calls: 5, maxCalls: 120 });
old('2026-01-01_000000_상세없음', new Date().toISOString(), { type: 'usage', calls: 7, maxCalls: 120 });
fs.writeFileSync(path.join(dir, 'broken.jsonl'), 'not json\n');

const { runCouncil } = require('../lib/council');
(async () => {
  const got = [];
  await runCouncil({ question: '사용량 시험 질문', participants: [{ id: 'gpt' }, { id: 'claude' }], attachments: [{ name: 'a', text: '자료' }], rounds: 1, maxCalls: 50, moderator: 'claude', mode: 'api', emit: (e) => got.push(e), signal: new AbortController().signal });
  const u = got.find((e) => e.type === 'usage');
  assert(u.detail.gpt && u.detail.claude, '회의 이벤트에 AI 별 상세가 있다');
  const sum = Object.values(u.detail).reduce((a, d) => a + d.calls, 0);
  assert.equal(sum, u.calls, '상세의 호출 합 = 전체 호출 수(재시도 없음)');
  assert(u.detail.gpt.inChars > 100 && u.detail.gpt.outChars > 10 && u.detail.gpt.via === 'api');

  // 실제 파일에 남기기(서버 경로와 같은 createMinutes)
  const { createMinutes } = require('../lib/minutes');
  const mm = createMinutes({ dir, question: '사용량 시험 질문', attachments: ['a'], mode: 'api' });
  got.forEach((e) => mm.push(e));
  mm.finish?.('완료');
  const all = U.summarize(dir, { days: 0 });
  assert.equal(all.totals.meetings, 3, '깨진 파일은 건너뛴다');
  assert.equal(all.totals.withDetail, 1);
  assert.equal(all.totals.calls, 5 + 7 + u.calls);
  assert.equal(all.totals.inChars, Object.values(u.detail).reduce((a, d) => a + d.inChars, 0));
  const g = all.byProvider.find((b) => b.provider === 'gpt');
  assert(g && g.via === 'api' && g.calls === u.detail.gpt.calls);
  const recent = U.summarize(dir, { days: 30 });
  assert.equal(recent.totals.meetings, 2, '기간 밖(2020년) 회의는 빠진다');
  assert(recent.meetings.some((m) => m.title === '옛 회의' && !m.hasDetail));

  const { server } = require('../server');
  server.listen(0, '127.0.0.1', async () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const r = await (await fetch(`${base}/api/usage?days=30`)).json();
      assert.equal(r.totals.meetings, 2); assert.equal(r.labels.gpt, 'GPT');
      assert.equal((await (await fetch(`${base}/api/usage?days=abc`)).json()).totals.meetings, 3, '잘못된 값은 전체');
      console.log('usage.js: ok');
    } catch (e) { console.error(e); process.exitCode = 1; } finally { server.close(); }
  });
})().catch((e) => { console.error(e); process.exit(1); });
