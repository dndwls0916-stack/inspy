// 각 서비스가 "지금" 쓸 수 있다고 알려 주는 모델 목록을 가져온다. (모델 이름은 자주 바뀌므로 하드코딩에 기대지 않는다)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PROVIDERS } = require('./providers');

const TTL_MS = 10 * 60 * 1000;
const cache = new Map();

async function getJson(url, headers) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// "5", "5.10", "3.1-pro" 같은 이름의 숫자 부분을 비교해 최신순으로 정렬
const versionOf = (id) => (id.match(/\d+(?:\.\d+)*/) || ['0'])[0].split('.').map(Number);
function newestFirst(a, b) {
  const [x, y] = [versionOf(a), versionOf(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (y[i] || 0) - (x[i] || 0);
    if (d) return d;
  }
  return a.localeCompare(b);
}

const FETCH = {
  async gemini(key) {
    const json = await getJson('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { 'x-goog-api-key': key });
    return (json.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => m.name.replace(/^models\//, ''))
      .filter((id) => /^gemini-/.test(id) && !/embedding|aqa|imagen|veo|tts|image|live|audio|robotics|computer-use|learnlm|gemma/.test(id))
      .sort(newestFirst);
  },
  async gpt(key) {
    const json = await getJson('https://api.openai.com/v1/models', { authorization: `Bearer ${key}` });
    return (json.data || [])
      .map((m) => m.id)
      .filter((id) => /^(gpt-|o\d)/.test(id) && !/audio|realtime|transcribe|tts|image|embedding|moderation|search|instruct|codex|vision|diarize|dall/.test(id))
      .sort(newestFirst);
  },
  async claude(key) {
    const json = await getJson('https://api.anthropic.com/v1/models?limit=100', { 'x-api-key': key, 'anthropic-version': '2023-06-01' });
    return (json.data || []).map((m) => m.id); // 최신순으로 내려온다
  },
};

// 목록에서 회의에 쓸 만한 기본 모델을 고른다. (최신 주력 모델. 고르지 못하면 null)
function pickDefault(id, ids) {
  const best = (re) => ids.filter((m) => re.test(m)).sort(newestFirst)[0];
  if (id === 'gemini') return best(/^gemini-[\d.]+-flash$/) || best(/^gemini-[\d.]+-flash(?!.*(lite|preview|exp))/) || best(/flash(?!.*lite)/) || ids[0] || null;
  if (id === 'gpt') return best(/^gpt-[\d.]+$/) || ids[0] || null;
  if (id === 'claude') return ids.find((m) => /sonnet/.test(m)) || ids[0] || null;
  return null;
}

async function listModels(id) {
  const key = process.env[PROVIDERS[id].keyEnv];
  if (!key || !FETCH[id]) return null;
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL_MS && hit.key === key) return hit.value;
  try {
    const ids = await FETCH[id](key);
    const value = ids.length ? { ids, pick: pickDefault(id, ids) } : null;
    cache.set(id, { at: Date.now(), key, value });
    return value;
  } catch {
    return null; // 목록을 못 가져와도 정적 목록으로 계속 동작한다
  }
}

async function listAllModels() {
  const entries = await Promise.all(Object.keys(PROVIDERS).map(async (id) => [id, await listModels(id)]));
  return Object.fromEntries(entries.filter(([, v]) => v));
}

// API 호출에 쓸 모델을 정한다: 직접 지정 > 환경변수 > (서비스 목록에 있으면) 기본값 > 목록의 추천 모델 > 정적 기본값
async function resolveApiModel(id, typed, staticDefault) {
  if (typed) return typed;
  if (process.env[PROVIDERS[id].modelEnv]) return staticDefault;
  const live = await listModels(id);
  if (!live) return staticDefault;
  return live.ids.includes(staticDefault) ? staticDefault : live.pick || staticDefault;
}

// Codex CLI 가 계정별로 받아 둔 모델 목록(있으면)을 읽는다. 형식이 달라도 조용히 무시한다.
function codexCachedModels() {
  try {
    const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    const json = JSON.parse(fs.readFileSync(path.join(home, 'models_cache.json'), 'utf8'));
    const arr = Array.isArray(json) ? json : json.models || [];
    const ids = arr.map((m) => (typeof m === 'string' ? m : m?.slug || m?.id || m?.model)).filter((x) => typeof x === 'string' && /^[A-Za-z0-9._:/-]+$/.test(x));
    return [...new Set(ids)];
  } catch {
    return [];
  }
}

// CLI 방식에서 고를 수 있는 모델 예시. CLI 마다 계정/플랜에 따라 허용 모델이 달라서 "예시"이며, 안 되면 자동(비움)을 쓰면 된다.
function cliModelChoices(id) {
  if (id === 'claude') return ['sonnet', 'opus', 'haiku', ...PROVIDERS.claude.models];
  if (id === 'gpt') {
    const cached = codexCachedModels();
    return cached.length ? cached : ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex'];
  }
  return PROVIDERS[id]?.models || [];
}

// 모델 이름 때문에 실패한 것 같으면 해결 방법을 덧붙인다.
function withModelHint(err, { model, via }) {
  const msg = String(err?.message || err);
  if (!model || !/model/i.test(msg) || !/not supported|not found|no longer|unavailable|does not exist|invalid|unsupported|404|400/i.test(msg)) return err;
  const hint =
    via === 'cli'
      ? '→ 모델 이름 문제로 보입니다. 왼쪽 참가자 카드의 모델 칸을 비우면 CLI 기본 모델로 실행됩니다.'
      : '→ 모델 이름 문제로 보입니다. 왼쪽 참가자 카드의 모델 칸에서 목록의 모델을 고르거나 비워 보세요.';
  const e = new Error(`${msg}\n${hint}`);
  e.cause = err;
  return e;
}

module.exports = { cliModelChoices, codexCachedModels, resolveApiModel, listModels, listAllModels, pickDefault, withModelHint, newestFirst };
