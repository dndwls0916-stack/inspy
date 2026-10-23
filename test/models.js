// 모델 목록 가져오기/기본 모델 추천/오류 힌트 검증. 실행: npm test
const assert = require('assert');
const { recommendedModel, pickDefault, rankModels, isModelAccessError, apiCandidates, resetModelMemory, withModelHint, listModels, resolveApiModel, newestFirst } = require('../lib/models');

// --- 최신순 정렬은 문자열이 아니라 숫자 기준 ---
assert.deepEqual(['gpt-5', 'gpt-5.10', 'gpt-5.2', 'gpt-4o'].sort(newestFirst), ['gpt-5.10', 'gpt-5.2', 'gpt-5', 'gpt-4o'], '5.10 > 5.2');

// --- 기본 모델 추천 ---
assert.equal(pickDefault('gemini', ['gemini-3.1-pro-preview', 'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-3-flash-preview', 'gemini-2.5-flash-lite']), 'gemini-2.5-flash-lite', '무료 키로 호출 가능한 flash-lite 를 flash 보다 먼저');
assert.equal(pickDefault('gemini', ['gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.5-pro']), 'gemini-3.5-flash-lite', '무료 키 보고: 3.5 flash-lite 만 호출 가능 → 자동 선택이 lite 를 고른다');
assert.deepEqual(rankModels('gemini', ['gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.5-flash-lite-preview', 'gemini-3.5-pro']).slice(0, 3), ['gemini-3.5-flash-lite', 'gemini-3.5-flash-lite-preview', 'gemini-3.5-flash'], '안정판 lite > preview lite > flash');
assert.equal(pickDefault('gemini', ['gemini-3-flash-preview', 'gemini-3.1-pro-preview', 'gemini-3.1-flash-lite']), 'gemini-3.1-flash-lite', '안정판 flash 가 없으면 안정판 lite 를 preview 보다 우선');
assert.equal(pickDefault('gemini', ['gemini-3-flash-preview', 'gemini-3.1-pro-preview']), 'gemini-3-flash-preview', 'lite 도 없으면 preview flash');
// 실제 보고: 이름만 새로운 코드명 모델(gemini-4-argon)은 무료 한도가 0 이라 자동 선택하면 안 된다
assert.deepEqual(rankModels('gemini', ['gemini-4-argon', 'gemini-3.1-pro-preview', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro']), ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-4-argon', 'gemini-3.1-pro-preview', 'gemini-2.5-pro'], 'lite > flash 우선, 코드명/pro 는 뒤');
assert.notEqual(pickDefault('gemini', ['gemini-4-argon', 'gemini-2.5-flash']), 'gemini-4-argon');

// --- 모델 접근 불가 신호 판별 ---
assert(isModelAccessError(new Error('HTTP 429: ... generate_content_free_tier_requests, limit: 0, model: gemini-4-argon')), '무료 한도 0');
assert(isModelAccessError(new Error('HTTP 404: models/gemini-2.5-pro is no longer available to new users')), '제공 중단');
assert(!isModelAccessError(new Error('HTTP 429: Resource exhausted. Please retry in 12s. limit: 10')), '일시적 속도 제한은 모델 문제가 아님');
assert(!isModelAccessError(new Error('HTTP 401: API key not valid')), '키 오류');

// --- 서비스가 알려 준 대체 모델 추출 (실제 보고된 메시지) ---
const real = new Error('HTTP 404: This model models/gemini-2.5-flash is no longer available to new users. Please update your code to use models/gemini-3.8-flash for the latest features and improvements. We recommend you to use the Interactions API (https://ai.google.dev/gemini-api/docs/get-started).');
assert.equal(recommendedModel(real), 'gemini-3.8-flash', '추천 모델 추출');
assert.equal(recommendedModel(new Error('We recommend you to use the Interactions API (https://x)')), null, 'API 이름은 모델이 아님');
assert.equal(recommendedModel(new Error('HTTP 401: API key not valid')), null);
assert.equal(recommendedModel(new Error('Please use gpt-5.4 instead.')), 'gpt-5.4');
assert.equal(pickDefault('gemini', ['gemini-3.1-pro-preview']), 'gemini-3.1-pro-preview', 'flash 가 없으면 첫 번째');
assert.equal(pickDefault('gemini', ['gemini-2.5-flash', 'gemini-3.5-flash', 'gemini-3.1-flash']), 'gemini-3.5-flash', '최신 버전 우선');
assert.equal(pickDefault('gpt', ['gpt-4o-mini', 'gpt-5.5', 'gpt-5.4', 'gpt-4o']), 'gpt-5.5');
assert.equal(pickDefault('claude', ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']), 'claude-sonnet-5-5');
assert.equal(pickDefault('gemini', []), null);

// --- 오류 힌트: 모델 이름 때문일 때만, 직접 지정한 모델일 때만 ---
const codex = new Error("codex 종료 코드 1: The 'gpt-5' model is not supported when using Codex with a ChatGPT account.");
assert(withModelHint(codex, { model: 'gpt-5', via: 'cli' }).message.includes('"자동"으로 바꾸면 CLI 기본 모델'), 'CLI 힌트');
assert.equal(withModelHint(codex, { model: '', via: 'cli' }), codex, '모델을 지정하지 않았으면 그대로');
const gem = new Error('HTTP 404: This model models/gemini-2.5-pro is no longer available to new users.');
assert(withModelHint(gem, { model: 'gemini-2.5-pro', via: 'api' }).message.includes('"자동"으로 바꾸거나 다른 모델을 고르세요'), 'API 힌트');
const net = new Error('fetch failed');
assert.equal(withModelHint(net, { model: 'x', via: 'api' }), net, '모델과 무관한 오류는 그대로');
const quota = new Error('HTTP 429: You exceeded your current quota for this model');
assert.equal(withModelHint(quota, { model: 'x', via: 'api' }), quota, '한도 초과는 모델 문제가 아님');

// --- 목록 가져오기: fetch 를 가짜로 바꿔 필터링/정렬/추천/캐시를 확인 ---
(async () => {
  let calls = 0;
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    calls++;
    assert(String(url).includes('generativelanguage.googleapis.com'));
    return {
      ok: true,
      json: async () => ({
        models: [
          { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-3.1-pro-preview', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-embedding-001', supportedGenerationMethods: ['embedContent'] },
          { name: 'models/gemini-2.5-flash-image', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemma-3-27b', supportedGenerationMethods: ['generateContent'] },
        ],
      }),
    };
  };
  process.env.GEMINI_API_KEY = 'k';
  try {
    const r = await listModels('gemini');
    assert.deepEqual(r.ids, ['gemini-3.1-pro-preview', 'gemini-2.5-flash', 'gemini-2.5-pro'], '임베딩/이미지/gemma 제외, 최신순');
    assert.equal(r.pick, 'gemini-2.5-flash');
    await listModels('gemini');
    assert.equal(calls, 1, '캐시');
    delete process.env.OPENAI_API_KEY;
    assert.equal(await listModels('gpt'), null, '키 없으면 조회 안 함');
    global.fetch = async () => ({ ok: false, status: 403, json: async () => ({}) });
    delete process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'other-key'; // 키가 바뀌면 캐시 무효
    assert.equal(await listModels('gemini'), null, '실패해도 예외 없이 null');
    // 호출 시점의 모델 결정: 직접 지정 > 환경변수 고정 > 목록에 있으면 기본값 > 추천
    assert.equal(await resolveApiModel('gemini', 'my-model', 'gemini-2.5-flash'), 'my-model', '직접 지정 우선');
    global.fetch = async () => ({ ok: true, json: async () => ({ models: [{ name: 'models/gemini-3.5-flash', supportedGenerationMethods: ['generateContent'] }, { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }] }) });
    process.env.GEMINI_API_KEY = 'k3';
    assert.equal(await resolveApiModel('gemini', '', 'gemini-2.5-flash'), 'gemini-2.5-flash', '기본값이 목록에 있으면 유지');
    process.env.GEMINI_API_KEY = 'k4';
    global.fetch = async () => ({ ok: true, json: async () => ({ models: [{ name: 'models/gemini-3.5-flash', supportedGenerationMethods: ['generateContent'] }] }) });
    assert.equal(await resolveApiModel('gemini', '', 'gemini-2.5-flash'), 'gemini-3.5-flash', '기본값이 목록에 없으면 추천 모델');
    global.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
    process.env.GEMINI_API_KEY = 'k5';
    assert.equal(await resolveApiModel('gemini', '', 'gemini-2.5-flash'), 'gemini-2.5-flash', '목록을 못 가져오면 정적 기본값');
    // 이전 버전 .env 템플릿이 적어 둔 기본값(gemini-2.5-flash)은 고정으로 보지 않는다 → 자동 선택이 동작
    resetModelMemory();
    process.env.GEMINI_API_KEY = 'k8';
    global.fetch = async () => ({ ok: true, json: async () => ({ models: ['gemini-3.8-flash', 'gemini-2.5-flash'].map((n) => ({ name: 'models/' + n, supportedGenerationMethods: ['generateContent'] })) }) });
    process.env.GEMINI_MODEL = 'gemini-2.5-flash';
    assert.equal((await apiCandidates('gemini', '', 'gemini-2.5-flash'))[0], 'gemini-3.8-flash', '템플릿 기본값은 고정이 아님');
    process.env.GEMINI_MODEL = 'pinned-model';
    assert.equal(await resolveApiModel('gemini', '', 'pinned-model'), 'pinned-model', '환경변수로 고정하면 그대로');
    delete process.env.GEMINI_MODEL;
    // --- 호출 시 후보 순회: 첫 모델이 한도 0 이면 다음 모델로 자동 전환하고 기억한다 ---
    const { PROVIDERS, callProvider } = require('../lib/providers');
    resetModelMemory();
    global.fetch = async () => ({ ok: true, json: async () => ({ models: ['gemini-4-argon', 'gemini-3.5-flash', 'gemini-3.1-flash-lite', 'gemini-2.5-flash-lite'].map((n) => ({ name: 'models/' + n, supportedGenerationMethods: ['generateContent'] })) }) });
    process.env.GEMINI_API_KEY = 'k6';
    const tried = [];
    const realCall = PROVIDERS.gemini.call;
    PROVIDERS.gemini.call = async ({ model }) => {
      tried.push(model);
      if (model === 'gemini-3.1-flash-lite') throw new Error('HTTP 429: free_tier_requests, limit: 0, model: gemini-3.1-flash-lite');
      return 'ok:' + model;
    };
    const used = [];
    const out = await callProvider('gemini', { mode: 'api', model: '', system: 's', prompt: 'p', onUse: (m) => used.push(m) });
    assert.equal(out, 'ok:gemini-2.5-flash-lite', '한도 0 인 모델은 건너뛰고 다음 후보 사용(lite 계열이 먼저)');
    assert.deepEqual(tried, ['gemini-3.1-flash-lite', 'gemini-2.5-flash-lite']);
    assert.deepEqual(used, ['gemini-3.1-flash-lite', 'gemini-2.5-flash-lite'], '시도한 모델을 알림');
    tried.length = 0;
    await callProvider('gemini', { mode: 'api', model: '', system: 's', prompt: 'p' });
    assert.deepEqual(tried, ['gemini-2.5-flash-lite'], '성공한 모델을 기억해 바로 사용');
    // 무료 키 보고: 3.5 flash-lite 만 호출 가능 → 자동이면 처음부터 lite 로 호출(실패 없이)
    resetModelMemory();
    global.fetch = async () => ({ ok: true, json: async () => ({ models: ['gemini-3.5-pro', 'gemini-3.5-flash', 'gemini-3.5-flash-lite'].map((n) => ({ name: 'models/' + n, supportedGenerationMethods: ['generateContent'] })) }) });
    process.env.GEMINI_API_KEY = 'free-key';
    tried.length = 0;
    PROVIDERS.gemini.call = async ({ model }) => {
      tried.push(model);
      if (model !== 'gemini-3.5-flash-lite') throw new Error(`HTTP 429: free_tier_requests, limit: 0, model: ${model}`);
      return 'ok:' + model;
    };
    assert.equal(await callProvider('gemini', { mode: 'api', model: '', system: 's', prompt: 'p' }), 'ok:gemini-3.5-flash-lite');
    assert.deepEqual(tried, ['gemini-3.5-flash-lite'], '무료 키: 첫 시도부터 성공(헛호출 없음)');
    assert.equal(PROVIDERS.gemini.defaultModel, 'gemini-3.5-flash-lite', '정적 기본 모델도 flash-lite');
    // 예전 .env 템플릿의 GEMINI_MODEL=gemini-2.5-flash 는 고정으로 보지 않는다(지금은 새 계정에서 못 쓴다)
    process.env.GEMINI_MODEL = 'gemini-2.5-flash';
    assert.equal(require('../lib/providers').pinnedModel('gemini'), null);
    delete process.env.GEMINI_MODEL;
    resetModelMemory();
    global.fetch = async () => ({ ok: true, json: async () => ({ models: ['gemini-4-argon', 'gemini-3.5-flash', 'gemini-3.1-flash-lite', 'gemini-2.5-flash-lite'].map((n) => ({ name: 'models/' + n, supportedGenerationMethods: ['generateContent'] })) }) });
    process.env.GEMINI_API_KEY = 'k6';
    PROVIDERS.gemini.call = async ({ model }) => {
      tried.push(model);
      return 'ok:' + model;
    };
    // 기본 모델(gemini-2.5-flash)이 목록에 있으면 그것을 먼저 쓴다
    resetModelMemory();
    global.fetch = async () => ({ ok: true, json: async () => ({ models: ['gemini-3.5-flash', 'gemini-2.5-flash'].map((n) => ({ name: 'models/' + n, supportedGenerationMethods: ['generateContent'] })) }) });
    process.env.GEMINI_API_KEY = 'k7';
    tried.length = 0;
    await callProvider('gemini', { mode: 'api', model: '', system: 's', prompt: 'p' });
    assert.equal(tried[0], 'gemini-3.5-flash', '정적 기본값(구형)이 아니라 최신 안정판 flash 를 먼저 시도');
    resetModelMemory();
    process.env.GEMINI_API_KEY = 'k6';
    global.fetch = async () => ({ ok: true, json: async () => ({ models: ['gemini-4-argon', 'gemini-3.5-flash', 'gemini-3.1-flash-lite', 'gemini-2.5-flash-lite'].map((n) => ({ name: 'models/' + n, supportedGenerationMethods: ['generateContent'] })) }) });
    // 직접 고른 모델이 "사용 불가 + 대체 모델 안내"이면 안내된 모델로 바꿔 재시도한다 (실제 보고 사례)
    resetModelMemory();
    tried.length = 0;
    PROVIDERS.gemini.call = async ({ model }) => {
      tried.push(model);
      if (model === 'gemini-2.5-flash') throw real;
      return 'ok:' + model;
    };
    const used2 = [];
    const out2 = await callProvider('gemini', { mode: 'api', model: 'gemini-2.5-flash', system: 's', prompt: 'p', onUse: (m) => used2.push(m) });
    assert.equal(out2, 'ok:gemini-3.8-flash', '안내된 대체 모델로 재시도');
    assert.deepEqual(used2, ['gemini-2.5-flash', 'gemini-3.8-flash'], '요청 모델 → 실제 모델');
    // 대체 모델도 실패하면 무한 반복하지 않는다
    tried.length = 0;
    PROVIDERS.gemini.call = async ({ model }) => { tried.push(model); throw real; };
    await assert.rejects(callProvider('gemini', { mode: 'api', model: 'gemini-2.5-flash', system: 's', prompt: 'p' }), /no longer available/);
    assert(tried.length <= 2, '재시도는 한 번뿐: ' + tried.join(','));
    PROVIDERS.gemini.call = async ({ model }) => { tried.push(model); if (model === 'gemini-3.5-flash') throw new Error('HTTP 429: limit: 0, model: x'); return 'ok:' + model; };
    // 직접 고른 모델은 대체하지 않고 오류를 그대로 보여 준다
    tried.length = 0;
    await assert.rejects(callProvider('gemini', { mode: 'api', model: 'gemini-3.5-flash', system: 's', prompt: 'p' }), /limit: 0/);
    assert.deepEqual(tried, ['gemini-3.5-flash'], '직접 고른 모델은 대체 없음');
    // 일시적 속도 제한은 다른 모델로 바꾸지 않는다
    resetModelMemory();
    PROVIDERS.gemini.call = async ({ model }) => { tried.push(model); throw new Error('HTTP 429: Please retry in 5s. limit: 10'); };
    tried.length = 0;
    await assert.rejects(callProvider('gemini', { mode: 'api', model: '', system: 's', prompt: 'p' }), /retry in 5s/);
    assert.equal(tried.length, 1, '속도 제한은 재시도 후보로 넘어가지 않음');
    PROVIDERS.gemini.call = realCall;
    resetModelMemory();
    console.log('OK: 모델 목록/추천/힌트');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    global.fetch = realFetch;
  }
})();
