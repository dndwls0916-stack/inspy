// 근거 대조(결론의 숫자·인용을 자료와 글자로 비교) 검증. 실행: npm test
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.MOCK = '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-'));
process.env.MINUTES_DIR = path.join(tmp, 'm');
const { checkEvidence, extractNumbers, extractQuotes } = require('../lib/evidence');

// 숫자 뽑기: 순번·작은 정수·날짜·시각·연도·실행 계획 표는 제외
const c = '## 결론\n1. 물량은 1,200대에서 15% 늘어 1380대가 됩니다.\n- 예산 2.5억원, 2024년 10/24 09:30 기준 3대, 라운드 2\n## 실행 계획\n| 일정 | 7일 | 500대 |\n## 다음\n매출 12,500,000원';
const n = extractNumbers(c).map((x) => x.text);
assert.deepEqual(n, ['1,200대', '15%', '1380대', '2.5억원', '3대', '12,500,000원']);

// 대조: 쉼표·억 단위 환산, 자료/회의/없음 구분, 인용은 공백 무시
const r = checkEvidence('물량 1,200대, 15%, 1380대, 예산 2.5억원. 담당자는 "B캠프 지연이 반복된다" 고 했고 "지어낸 문장입니다 정말로" 라고도 한다.',
  [{ name: '실적.xlsx', text: '물량 1200대\n예산 250,000,000원\nB캠프 지연이   반복된다' }], '15% 증가 이야기');
assert.deepEqual(r.numbers.verified, ['1,200대', '2.5억원']);
assert.deepEqual(r.numbers.meetingOnly.map((x) => x.text), ['15%']);
assert.deepEqual(r.numbers.missing.map((x) => x.text), ['1380대']);
assert.deepEqual(r.quotes.verified, ['B캠프 지연이 반복된다']);
assert.deepEqual(r.quotes.missing, ['지어낸 문장입니다 정말로']);
// 부분 일치 방지: 120 은 1200 안에서 찾지 않는다
assert.equal(checkEvidence('120대', [{ name: 'a', text: '물량 1200대' }]).numbers.counts.missing, 1);
assert.equal(checkEvidence('숫자 없는 결론입니다', []).numbers.total, 0);
assert.deepEqual(extractQuotes('아무 말'), []);

const { runCouncil } = require('../lib/council');
const { renderMinutes } = require('../lib/minutes');
const run = async (question) => {
  const got = [];
  await runCouncil({ question, participants: [{ id: 'gpt' }, { id: 'claude' }], attachments: [{ name: '자료', text: '물량 1200대' }], rounds: 1, maxCalls: 50, moderator: 'claude', mode: 'api', emit: (e) => got.push(e), signal: new AbortController().signal });
  return got;
};
(async () => {
  let got = await run('EVIDENCE-TEST 물량');
  const i = got.findIndex((e) => e.type === 'final'), j = got.findIndex((e) => e.type === 'evidence');
  assert(i >= 0 && j === i + 1, '결론 바로 뒤에 근거 대조');
  assert.deepEqual(got[j].numbers.verified, ['1200대']);
  assert.deepEqual(got[j].numbers.missing.map((x) => x.text), ['500대']);
  assert.deepEqual(got[j].quotes.missing, ['근거 없는 인용 문장입니다']);
  assert(got[j].hasSources);
  const md = renderMinutes(got, { question: 'Q', status: '완료' });
  assert(md.includes('## 근거 대조') && md.includes('어디에도 없음: 500대'));
  got = await run('숫자 없는 데모');
  assert(!got.some((e) => e.type === 'evidence'), '숫자·인용이 없으면 대조 결과도 없다');
  console.log('evidence.js: ok');
})().catch((e) => { console.error(e); process.exit(1); });
