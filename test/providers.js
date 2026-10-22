// 다른 AI(Grok, DeepSeek, Mistral, Perplexity, Groq, OpenRouter, Ollama, 사용자 지정) 연결 검증. 실행: npm test
const assert = require('assert');
delete process.env.MOCK;
for (const k of ['XAI_API_KEY', 'DEEPSEEK_API_KEY', 'MISTRAL_API_KEY', 'PERPLEXITY_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'OLLAMA_MODEL', 'OLLAMA_BASE_URL', 'OLLAMA_API_KEY', 'CUSTOM_BASE_URL', 'CUSTOM_MODEL', 'CUSTOM_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY']) delete process.env[k];
process.env.CUSTOM_LABEL = '사내 모델';
process.env.CUSTOM_MODEL = 'corp-llm';
const prov = require('../lib/providers');
const models = require('../lib/models');
const { PROVIDERS, hasApiKey, cliAvailable, isConfigured, resolveMode, callProvider, pinnedModel } = prov;

const EXTRA = ['grok', 'deepseek', 'mistral', 'perplexity', 'groq', 'openrouter', 'ollama', 'custom'];
for (const id of EXTRA) {
  const p = PROVIDERS[id];
  assert(p && p.compat && p.label && p.vendor && p.color && p.envHint && typeof p.call === 'function', `${id}: 정의`);
  assert(/^[a-z]+$/.test(id), `${id}: 참가자 id 형식(영문 소문자)`);
  assert.equal(p.cli, null, `${id}: API 전용`);
  assert.equal(cliAvailable(id), false);
  assert.equal(resolveMode(id, 'cli'), 'api', `${id}: CLI/혼합 모드에서도 API 로`); assert.equal(resolveMode(id, 'mixed'), 'api');
}
assert.equal(PROVIDERS.custom.label, '사내 모델', 'CUSTOM_LABEL');

// --- 사용 가능 여부: 키(또는 로컬 설정)가 있어야 한다 ---
for (const id of ['grok', 'deepseek', 'mistral', 'perplexity', 'groq', 'openrouter']) assert.equal(hasApiKey(id), false, `${id}: 키 없으면 사용 불가`);
assert.equal(hasApiKey('ollama'), false, 'Ollama 는 명시적으로 설정해야 사용(실행 중인지 몰라서)');
assert.equal(hasApiKey('custom'), false, '사용자 지정은 주소와 모델이 모두 있어야 사용');
process.env.DEEPSEEK_API_KEY = 'dk'; process.env.XAI_API_KEY = 'xk'; process.env.OLLAMA_MODEL = 'llama3.1'; process.env.CUSTOM_BASE_URL = 'http://corp.local:8000/v1/';
assert(hasApiKey('deepseek') && hasApiKey('grok') && hasApiKey('ollama') && hasApiKey('custom'));
for (const mode of ['api', 'cli', 'mixed']) assert(isConfigured('deepseek', mode), `deepseek ${mode}: API 전용이라 키만 있으면 OK`);
assert.equal(isConfigured('mistral', 'api'), false);
assert.equal(pinnedModel('custom'), 'corp-llm', '사용자 지정 모델은 그대로 고정');
assert.equal(pinnedModel('ollama'), 'llama3.1', 'Ollama 모델은 그대로 고정');
assert.equal(pinnedModel('deepseek'), null, '기본값과 같은 환경변수가 아니면 고정 아님');

// --- 요청 형태 ---
const realFetch = global.fetch;
const calls = [];
let listBody = { data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }, { id: 'text-embedding-3' }, { id: 'whisper-1' }] };
global.fetch = async (url, init) => {
  const u = String(url);
  if (init?.method === 'POST') {
    calls.push({ url: u, headers: init.headers, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ choices: [{ message: { content: `답:${u}` } }] }), { status: 200 });
  }
  return new Response(JSON.stringify(listBody), { status: 200 });
};
const base = { mode: 'api', system: 'sys', prompt: 'hello' };
(async () => {
  let out = await callProvider('deepseek', { ...base, model: 'deepseek-chat' });
  let c = calls.at(-1);
  assert.equal(c.url, 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(c.headers.authorization, 'Bearer dk');
  assert.deepEqual(c.body.messages, [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hello' }]);
  assert.equal(c.body.model, 'deepseek-chat'); assert(out.includes('chat/completions'));
  // 키 없는 로컬 서버: Authorization 헤더가 없다. 기본 주소 / 환경변수 주소(끝의 / 정리)
  delete process.env.OLLAMA_BASE_URL;
  await callProvider('ollama', { ...base, model: 'llama3.1' });
  c = calls.at(-1);
  assert.equal(c.url, 'http://localhost:11434/v1/chat/completions'); assert.equal(c.headers.authorization, undefined);
  await callProvider('custom', { ...base, model: 'corp-llm' });
  c = calls.at(-1);
  assert.equal(c.url, 'http://corp.local:8000/v1/chat/completions', '끝의 / 정리'); assert.equal(c.headers.authorization, undefined);
  process.env.CUSTOM_API_KEY = 'ck';
  await callProvider('custom', { ...base, model: 'corp-llm' });
  assert.equal(calls.at(-1).headers.authorization, 'Bearer ck', '키가 있으면 보낸다');
  // 주소가 정해진 AI 들
  process.env.MISTRAL_API_KEY = 'm'; process.env.PERPLEXITY_API_KEY = 'p'; process.env.GROQ_API_KEY = 'g'; process.env.OPENROUTER_API_KEY = 'o';
  for (const [id, url] of [['mistral', 'https://api.mistral.ai/v1/chat/completions'], ['perplexity', 'https://api.perplexity.ai/chat/completions'], ['groq', 'https://api.groq.com/openai/v1/chat/completions'], ['openrouter', 'https://openrouter.ai/api/v1/chat/completions'], ['grok', 'https://api.x.ai/v1/chat/completions']]) {
    await callProvider(id, { ...base, model: 'm/x' });
    assert.equal(calls.at(-1).url, url, id);
  }
  // 생각 깊이: Grok 만 보내고, 나머지는 보내지 않으며 적용 안 됨으로 표시
  let meta = {};
  await callProvider('grok', { ...base, model: 'grok-3-mini', effort: 'high', meta });
  assert.equal(calls.at(-1).body.reasoning_effort, 'high'); assert.equal(meta.effort, 'high');
  meta = {};
  await callProvider('deepseek', { ...base, model: 'deepseek-chat', effort: 'high', meta });
  assert(!('reasoning_effort' in calls.at(-1).body), '지원 안 하는 AI 에는 보내지 않는다'); assert.equal(meta.effort || null, null, '적용 안 됨으로 표시');
  // 오류 메시지는 그대로 전달
  global.fetch = async () => new Response(JSON.stringify({ error: { message: 'Insufficient Balance' } }), { status: 402 });
  await assert.rejects(callProvider('deepseek', { ...base, model: 'deepseek-chat' }), /402.*Insufficient Balance/);

  // --- 모델 목록: /models 에서 가져와 임베딩/음성 모델은 뺀다. 기본 모델이 있으면 먼저 ---
  global.fetch = async (url, init) => new Response(JSON.stringify(listBody), { status: 200 });
  const live = await models.listModels('deepseek');
  assert.deepEqual(live.ids, ['deepseek-chat', 'deepseek-reasoner'], '임베딩/음성 모델 제외');
  assert.equal(live.pick, 'deepseek-chat');
  listBody = { data: [{ id: 'zzz' }, { id: 'deepseek-chat' }] };
  assert.equal((await models.rankModels('deepseek', ['zzz', 'deepseek-chat']))[0], 'deepseek-chat');
  assert.equal((await models.listModels('mistral')).ids.length, 2, '다른 호환 서버도 같은 방식으로 목록을 가져온다');
  global.fetch = async () => { throw new Error('network'); };
  assert.equal(await models.listModels('grok'), null, '목록을 못 가져와도 동작');
  assert.deepEqual(await models.apiCandidates('grok', '', 'grok-4'), ['grok-4'], '목록 없으면 정적 기본 모델');
  assert.deepEqual(await models.apiCandidates('custom', '', 'corp-llm'), ['corp-llm']);
  assert.equal(await models.listModels('perplexity'), null);

  // --- 코드 리뷰(GPT) 지적: 긴 목록에서 기본/지정 모델 보존, 지정 모델 고정, 주소가 바뀌면 캐시 무효 ---
  process.env.OPENROUTER_MODEL = 'vendor/pinned-model';
  const long = Array.from({ length: 500 }, (_, i) => ({ id: `vendor/m-${i}` }));
  global.fetch = async () => new Response(JSON.stringify({ data: [...long, { id: 'meta-llama/llama-3.3-70b-instruct' }, { id: 'vendor/pinned-model' }] }), { status: 200 });
  const orList = await models.listModels('openrouter');
  assert(orList.ids.length === 400 && orList.ids[0] === 'meta-llama/llama-3.3-70b-instruct' && orList.ids.includes('vendor/pinned-model'), '401번째 이후의 기본·지정 모델도 목록에 남는다');
  assert.equal(pinnedModel('openrouter'), 'vendor/pinned-model');
  process.env.XAI_MODEL = 'grok-4';
  assert.equal(pinnedModel('grok'), 'grok-4', '기본값과 같아도 .env 로 지정한 모델은 고정(새 AI 는 예전 .env 호환 예외 없음)');
  assert.deepEqual(await models.apiCandidates('grok', '', 'grok-4'), ['grok-4'], '지정 모델만 후보');
  let n = 0;
  global.fetch = async () => new Response(JSON.stringify({ data: [{ id: `a-${++n}` }] }), { status: 200 });
  process.env.OLLAMA_BASE_URL = 'http://one:11434/v1';
  const l1 = await models.listModels('ollama');
  process.env.OLLAMA_BASE_URL = 'http://two:11434/v1';
  const l2 = await models.listModels('ollama');
  assert.notDeepEqual(l1.ids, l2.ids, '주소가 바뀌면 이전 주소의 목록을 쓰지 않는다');
  delete process.env.OLLAMA_BASE_URL;

  // --- 서버: 설정 노출, 데모 모드에서 다른 AI 를 자리에 앉힐 수 있다 ---
  global.fetch = realFetch;
  process.env.MOCK = '1';
  delete require.cache[require.resolve('../server')];
  const { server } = require('../server');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const cfg = await (await fetch(`${url}/api/config`)).json();
    const byId = Object.fromEntries(cfg.providers.map((p) => [p.id, p]));
    for (const id of EXTRA) assert(byId[id] && byId[id].extra && byId[id].cliSupported === false && byId[id].color && byId[id].envHint, `${id}: 설정에 노출`);
    for (const id of ['gpt', 'gemini', 'claude']) assert(!byId[id].extra && byId[id].cliSupported);
    const run = async (body) => {
      const res = await fetch(`${url}/api/council`, { method: 'POST', body: JSON.stringify(body) });
      const text = await res.text();
      return text.split('\n\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
    };
    const ev = await run({ question: 'Q', rounds: 1, moderator: 'deepseek', mode: 'cli', participants: [{ id: 'gpt' }, { id: 'deepseek' }, { id: 'grok' }, { id: 'grok-2', role: 'critic' }, { id: 'ollama' }, { id: 'custom' }, { id: 'nope' }] });
    const start = ev.find((e) => e.type === 'start');
    assert.deepEqual(start.participants.map((p) => [p.id, p.provider, p.label, p.via]), [['gpt', 'gpt', 'GPT', 'cli'], ['deepseek', 'deepseek', 'DeepSeek', 'api'], ['grok', 'grok', 'Grok 1', 'api'], ['grok-2', 'grok', 'Grok 2', 'api'], ['ollama', 'ollama', 'Ollama', 'api'], ['custom', 'custom', '사내 모델', 'api']], 'CLI 모드여도 API 전용 AI 는 api 로 호출');
    assert.equal(ev.filter((e) => e.type === 'turn').length, 6);
    const fin = ev.find((e) => e.type === 'final');
    assert.equal(fin.who, 'deepseek', '다른 AI 가 사회자를 맡을 수 있다');
    assert(ev.some((e) => e.type === 'turn' && e.who === 'grok-2' && e.text.includes('비판자')), '다른 AI 에도 직업 역할이 적용');
    console.log('providers.js: ok');
  } finally { server.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
