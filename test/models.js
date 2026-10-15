// 모델 목록 가져오기/기본 모델 추천/오류 힌트 검증. 실행: npm test
const assert = require('assert');
const { pickDefault, withModelHint, listModels, resolveApiModel, newestFirst } = require('../lib/models');

// --- 최신순 정렬은 문자열이 아니라 숫자 기준 ---
assert.deepEqual(['gpt-5', 'gpt-5.10', 'gpt-5.2', 'gpt-4o'].sort(newestFirst), ['gpt-5.10', 'gpt-5.2', 'gpt-5', 'gpt-4o'], '5.10 > 5.2');

// --- 기본 모델 추천 ---
assert.equal(pickDefault('gemini', ['gemini-3.1-pro-preview', 'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-3-flash-preview', 'gemini-2.5-flash-lite']), 'gemini-2.5-flash', '안정판 flash 우선');
assert.equal(pickDefault('gemini', ['gemini-3-flash-preview', 'gemini-3.1-pro-preview', 'gemini-3.1-flash-lite']), 'gemini-3-flash-preview', '안정판 없으면 preview flash, lite 제외');
assert.equal(pickDefault('gemini', ['gemini-3.1-pro-preview']), 'gemini-3.1-pro-preview', 'flash 가 없으면 첫 번째');
assert.equal(pickDefault('gemini', ['gemini-2.5-flash', 'gemini-3.5-flash', 'gemini-3.1-flash']), 'gemini-3.5-flash', '최신 버전 우선');
assert.equal(pickDefault('gpt', ['gpt-4o-mini', 'gpt-5.5', 'gpt-5.4', 'gpt-4o']), 'gpt-5.5');
assert.equal(pickDefault('claude', ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']), 'claude-sonnet-5-5');
assert.equal(pickDefault('gemini', []), null);

// --- 오류 힌트: 모델 이름 때문일 때만, 직접 지정한 모델일 때만 ---
const codex = new Error("codex 종료 코드 1: The 'gpt-5' model is not supported when using Codex with a ChatGPT account.");
assert(withModelHint(codex, { model: 'gpt-5', via: 'cli' }).message.includes('모델 칸을 비우면 CLI 기본 모델'), 'CLI 힌트');
assert.equal(withModelHint(codex, { model: '', via: 'cli' }), codex, '모델을 지정하지 않았으면 그대로');
const gem = new Error('HTTP 404: This model models/gemini-2.5-pro is no longer available to new users.');
assert(withModelHint(gem, { model: 'gemini-2.5-pro', via: 'api' }).message.includes('목록의 모델을 고르거나'), 'API 힌트');
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
    process.env.GEMINI_MODEL = 'pinned-model';
    assert.equal(await resolveApiModel('gemini', '', 'pinned-model'), 'pinned-model', '환경변수로 고정하면 그대로');
    delete process.env.GEMINI_MODEL;
    console.log('OK: 모델 목록/추천/힌트');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    global.fetch = realFetch;
  }
})();
