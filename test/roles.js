// 직업 역할과 노력(생각 깊이) 검증. 실행: npm test
const assert = require('assert');
const { ROLES, TEAMS, roleBlock, publicRoles } = require('../lib/roles');

// --- 역할 정의 ---
assert(Object.keys(ROLES).length >= 50, '회의 참여자 역할을 폭넓게 제공');
for (const [id, r] of Object.entries(ROLES)) {
  assert(r.name && r.view && r.checks.length >= 3 && r.caution, `${id}: 필드가 빠짐`);
  assert(roleBlock(id).includes(r.name) && roleBlock(id).includes(r.checks[0]));
}
for (const t of TEAMS) assert(t.roles.length >= 3 && t.roles.length <= 8 && t.roles.every((r) => ROLES[r]) && new Set(t.roles).size === t.roles.length && t.group, `${t.id}: 팀 구성이 잘못됨`);
assert.equal(new Set(TEAMS.map((t) => t.id)).size, TEAMS.length, '팀 id 는 유일');
// 주식투자팀
const stock = TEAMS.find((t) => t.id === 'stock_team');
assert(stock && ['fund_manager', 'equity_analyst', 'risk_manager', 'quant', 'macro', 'short_seller'].every((r) => stock.roles.includes(r)), '주식투자팀: 펀드매니저·애널리스트·리스크·퀀트·매크로·공매도');
for (const id of ['fund_manager', 'equity_analyst', 'quant', 'trader', 'risk_manager', 'macro', 'value_investor', 'technical', 'short_seller', 'credit', 'esg', 'ic_chair']) {
  assert.equal(ROLES[id].group, '주식투자팀', id);
  assert(ROLES[id].caution.includes('실시간 시세') && ROLES[id].caution.includes('투자 권유가 아닌'), `${id}: 투자 역할은 실시간 데이터 부재와 투자 권유 아님을 밝힌다`);
}
assert(roleBlock('fund_manager').includes('펀드매니저') && roleBlock('fund_manager').includes('포트폴리오'));
// 일반 회의 참석자 유형
for (const id of ['ceo', 'cfo', 'cto', 'coo', 'manager', 'staff', 'board', 'compliance', 'risk', 'auditor', 'privacy', 'designer', 'qa', 'devops', 'sales', 'cs', 'pr', 'ops', 'union', 'facilitator', 'consultant', 'end_user']) assert(ROLES[id], `${id} 역할`);
const groups = new Set(publicRoles().map((r) => r.group));
assert(['경영·의사결정', '주식투자팀', '법무·리스크·감사', '기술·제품', '사업·고객', '운영·인사', '관점·진행'].every((g) => groups.has(g)));
const pr = publicRoles();
assert.deepEqual(pr.map((r) => r.group).filter((g, i, a) => a.indexOf(g) === i && a.lastIndexOf(g) === a.map((x, j) => (x === g ? j : -1)).filter((j) => j >= 0).pop()), [...new Set(pr.map((r) => r.group))], '그룹은 한 덩어리로 묶여 있다');
// 물류운송 회사 역할·팀(직무기술서 기반)
for (const id of ['dispatcher', 'emergency_dispatch', 'camp_ops', 'delivery_quality', 'driver_manager', 'logi_cs', 'settlement', 'kam', 'vehicle_admin', 'logi_biz_dev', 'logi_safety', 'labor_risk', 'ops_analyst', 'driver_voice']) {
  assert.equal(ROLES[id]?.group, '물류운송', id);
  assert(ROLES[id].caution.includes('확인 필요'), `${id}: 문서에 없는 수치·법규를 지어내지 않게 지시`);
}
assert(TEAMS.filter((t) => t.group === '물류운송').length >= 8, '물류운송 팀 프리셋');
assert(roleBlock('dispatcher').includes('완편율') && roleBlock('settlement').includes('정산'), '직무기술서의 KPI 용어 반영');
assert.equal(TEAMS[0].group, '물류운송', '물류운송 팀이 목록 맨 앞');
assert.equal(roleBlock(''), '');
assert.equal(roleBlock('nope'), '');
assert(publicRoles().every((r) => !('checks' in r) && !('caution' in r)), '화면에는 관점 요약만');
assert(roleBlock('lawyer').includes('지어내지 말고'), '법률 역할은 조문/판례를 지어내지 않게 지시');
assert(roleBlock('doctor').includes('진단이나 처방을 하지 마세요'));

// --- 노력: 서비스별 요청 본문 ---
process.env.OPENAI_API_KEY = 'k'; process.env.GEMINI_API_KEY = 'k'; process.env.ANTHROPIC_API_KEY = 'k';
delete process.env.MOCK;
const prov = require('../lib/providers');
const { PROVIDERS, callProvider, EFFORTS, isEffortError } = prov;
assert.deepEqual(EFFORTS, ['low', 'medium', 'high']);

const realFetch = global.fetch;
const calls = [];
let rejectEffort = false;
global.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  calls.push({ url: String(url), body });
  const hasEffort = JSON.stringify(body).match(/reasoning_effort|output_config|thinkingConfig/);
  if (rejectEffort && hasEffort) {
    return new Response(JSON.stringify({ error: { message: `Unsupported parameter: '${hasEffort[0]}' is not supported with this model.` } }), { status: 400 });
  }
  const ok = String(url).includes('openai') ? { choices: [{ message: { content: 'ok' } }] }
    : String(url).includes('google') ? { candidates: [{ content: { parts: [{ text: 'ok' }] } }] }
    : { content: [{ type: 'text', text: 'ok' }] };
  return new Response(JSON.stringify(ok), { status: 200 });
};

(async () => {
  const base = { mode: 'api', system: 's', prompt: 'p' };
  // OpenAI
  await callProvider('gpt', { ...base, model: 'gpt-5', effort: 'high' });
  assert.equal(calls.at(-1).body.reasoning_effort, 'high');
  await callProvider('gpt', { ...base, model: 'gpt-5', effort: '' });
  assert(!('reasoning_effort' in calls.at(-1).body), '자동이면 보내지 않는다');
  // Gemini: 2.5 는 thinkingBudget, 3 은 thinkingLevel
  await callProvider('gemini', { ...base, model: 'gemini-2.5-flash', effort: 'low' });
  assert.deepEqual(calls.at(-1).body.generationConfig.thinkingConfig, { thinkingBudget: 1024 });
  await callProvider('gemini', { ...base, model: 'gemini-3.1-pro-preview', effort: 'high' });
  assert.deepEqual(calls.at(-1).body.generationConfig.thinkingConfig, { thinkingLevel: 'high' });
  // Claude: output_config.effort, thinking/budget_tokens 는 보내지 않는다, max_tokens 는 노력에 맞춰 넉넉히
  await callProvider('claude', { ...base, model: 'claude-opus-5-5', effort: 'medium' });
  let b = calls.at(-1).body;
  assert.deepEqual(b.output_config, { effort: 'medium' });
  assert(!('thinking' in b) && !('temperature' in b));
  assert.equal(b.max_tokens, 8192);
  await callProvider('claude', { ...base, model: 'claude-opus-5-5' });
  assert(!('output_config' in calls.at(-1).body) && calls.at(-1).body.max_tokens === 2048, '자동이면 기존과 동일');
  // 잘못된 값은 무시
  await callProvider('claude', { ...base, model: 'claude-opus-5-5', effort: 'extreme' });
  assert(!('output_config' in calls.at(-1).body));

  // --- 노력을 지원하지 않는 모델: 설정을 빼고 자동 재시도, 사용 여부를 알려 준다 ---
  rejectEffort = true;
  for (const [id, model] of [['gpt', 'gpt-4o'], ['gemini', 'gemini-2.0-flash'], ['claude', 'claude-haiku-4-5']]) {
    const n = calls.length;
    const meta = {};
    const out = await callProvider(id, { ...base, model, effort: 'high', meta });
    assert.equal(out, 'ok');
    assert.equal(calls.length - n, 2, `${id}: 1차 거절 후 설정 없이 재시도`);
    assert(!JSON.stringify(calls.at(-1).body).match(/reasoning_effort|output_config|thinkingConfig/));
    assert.equal(meta.effort, null, `${id}: 적용 안 됨을 알림`);
  }
  rejectEffort = false;
  const meta = {};
  await callProvider('gpt', { ...base, model: 'gpt-5', effort: 'low', meta });
  assert.equal(meta.effort, 'low', '적용되면 알림');

  // 노력과 무관한 오류는 그대로 던진다(재시도하지 않음)
  global.fetch = async () => new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), { status: 401 });
  await assert.rejects(callProvider('gpt', { ...base, model: 'gpt-5', effort: 'high' }), /401/);
  assert(isEffortError(new Error("HTTP 400: Unsupported parameter: 'reasoning_effort'")));
  assert(isEffortError(new Error('codex 종료 코드 1: invalid value for model_reasoning_effort')));
  assert(!isEffortError(new Error('HTTP 429: quota')));
  assert(!isEffortError(new Error("HTTP 500: thinking server error")) );

  // --- CLI 인자 ---
  assert.deepEqual(PROVIDERS.claude.cli.args('sonnet', 'high'), ['-p', '--model', 'sonnet', '--effort', 'high']);
  assert.deepEqual(PROVIDERS.claude.cli.args('', ''), ['-p']);
  assert(PROVIDERS.gpt.cli.args('', 'low').join(' ').includes('-c model_reasoning_effort=low'));
  assert.deepEqual(PROVIDERS.gemini.cli.args('', 'high'), PROVIDERS.gemini.cli.args('', ''), 'Gemini CLI 는 노력 설정이 없다');
  // Windows .cmd 에서도 = 가 있는 인자가 통과, 셸 메타문자는 여전히 거부
  const plan = prov.buildSpawn('C:\\x\\codex.cmd', PROVIDERS.gpt.cli.args('', 'low'), 'win32');
  assert(plan.shell && plan.cmd.includes('model_reasoning_effort=low'));
  assert.throws(() => prov.buildSpawn('c.cmd', ['-c', 'a=b&calc'], 'win32'), /사용할 수 없는 문자/);

  global.fetch = realFetch;
  await serverTests();
})().catch((e) => { console.error(e); process.exit(1); });

async function serverTests() {
  process.env.MOCK = '1';
  delete require.cache[require.resolve('../server')];
  const { server } = require('../server');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const run = async (body) => {
    const res = await fetch(`${base}/api/council`, { method: 'POST', body: JSON.stringify(body) });
    const events = [];
    let buf = '';
    for await (const c of res.body) {
      buf += Buffer.from(c).toString();
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 2); if (l.startsWith('data: ')) events.push(JSON.parse(l.slice(6))); }
    }
    return events;
  };
  try {
    const cfg = await (await fetch(`${base}/api/config`)).json();
    assert(cfg.roles.length >= 50 && cfg.teams.length >= 20 && cfg.teams.every((t) => t.group));
    const ev = await run({
      question: '이 계약을 해도 될까?', rounds: 1, moderator: 'claude', mode: 'api',
      participants: [{ id: 'gpt', role: 'lawyer', effort: 'high' }, { id: 'gemini', role: 'investor', effort: 'low' }, { id: 'claude', role: 'bogus', effort: 'turbo' }],
    });
    const start = ev.find((e) => e.type === 'start');
    const by = Object.fromEntries(start.participants.map((p) => [p.id, p]));
    assert.equal(by.gpt.roleName, '변호사'); assert.equal(by.gpt.effort, 'high');
    assert.equal(by.gemini.roleName, '투자자');
    assert.equal(by.claude.role, '', '모르는 역할은 무시'); assert.equal(by.claude.effort, '', '모르는 노력은 자동');
    const turns = Object.fromEntries(ev.filter((e) => e.type === 'turn').map((t) => [t.who, t]));
    assert(turns.gpt.text.includes('(역할: 변호사)') && turns.gpt.text.includes('(노력: high)'), '역할/노력이 호출까지 전달');
    assert(turns.gemini.text.includes('(역할: 투자자)') && turns.gemini.text.includes('(노력: low)'));
    assert(!turns.claude.text.includes('(역할:') && !turns.claude.text.includes('(노력:'));
    assert.equal(turns.gpt.roleName, '변호사'); assert.equal(turns.gpt.effortApplied, 'high'); assert.equal(turns.claude.effortApplied, null);
    // 역할 없이 호출해도 기존처럼 동작
    const plain = await run({ question: 'Q', rounds: 1, moderator: 'gpt', mode: 'api', participants: [{ id: 'gpt' }, { id: 'claude' }] });
    assert(plain.some((e) => e.type === 'final'));
    console.log('roles.js: ok');
  } catch (e) { console.error(e); process.exitCode = 1; } finally { server.close(); }
}
