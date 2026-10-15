// 각 서비스가 "지금" 쓸 수 있다고 알려 주는 모델 목록을 가져온다. (모델 이름은 자주 바뀌므로 하드코딩에 기대지 않는다)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PROVIDERS, pinnedModel } = require('./providers');

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

// 목록을 "회의에 쓸 만하고 무료/기본 한도로 쓸 가능성이 높은 순"으로 정렬한다.
// 가장 새로운 모델이 항상 쓸 수 있는 모델은 아니다(예: 신형·pro 는 무료 한도가 0 인 경우가 많다). 그래서 이름만 새로운 모델은 뒤로 보낸다.
function rankModels(id, ids) {
  if (id === 'gemini') {
    const stable = (m) => !/preview|exp|latest/.test(m);
    const tiers = [
      (m) => /flash/.test(m) && !/lite/.test(m) && stable(m), // 안정판 flash
      (m) => /flash-lite/.test(m) && stable(m), // 안정판 flash-lite
      (m) => /flash/.test(m) && !/lite/.test(m), // preview flash
      (m) => /flash-lite/.test(m), // preview flash-lite
    ];
    const out = [];
    for (const t of tiers) out.push(...ids.filter((m) => t(m) && !out.includes(m)).sort(newestFirst));
    out.push(...ids.filter((m) => !out.includes(m))); // 나머지(pro, 코드명 모델 등)는 마지막
    return out;
  }
  const first = id === 'gpt' ? ids.filter((m) => /^gpt-[\d.]+$/.test(m)).sort(newestFirst)[0] : id === 'claude' ? ids.find((m) => /sonnet/.test(m)) : null;
  return [first, ...ids.filter((m) => m !== first)].filter(Boolean);
}

// 추천 기본 모델 (순위의 1등)
function pickDefault(id, ids) {
  return rankModels(id, ids)[0] || null;
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

// 이 모델은 지금 계정에서 못 쓴다는 신호인가? (무료 한도 0, 신규 사용자 제공 중단, 없는 모델 등) — 일시적 속도 제한(429 + 재시도 안내)과 구분한다.
function isModelAccessError(err) {
  const msg = String(err?.message || err);
  return /limit:\s*0\b/.test(msg) || /no longer available|not found|does not exist|not supported|unsupported model|is not available/i.test(msg);
}

// 오류 메시지가 대체 모델을 알려 주면 그 이름을 꺼낸다. 예: "... no longer available to new users. Please update your code to use models/gemini-3.8-flash ..."
function recommendedModel(err) {
  const m = String(err?.message || err).match(/\buse\s+(?:models\/)?([A-Za-z0-9][A-Za-z0-9._-]{2,60})(?=[\s.,;:)]|$)/i);
  const name = m?.[1];
  return name && /^(gemini|gpt|claude|o\d)/i.test(name) ? name : null;
}

// 성공/실패한 모델을 기억해 다음 호출에서 바로 쓰거나 건너뛴다.
const goodModel = new Map();
const badModels = new Map(); // id -> Map(model -> 실패 시각)
const BAD_TTL = 30 * 60 * 1000;
function markGood(id, model) { goodModel.set(id, model); }
function markBad(id, model) {
  if (!badModels.has(id)) badModels.set(id, new Map());
  badModels.get(id).set(model, Date.now());
  if (goodModel.get(id) === model) goodModel.delete(id);
}
const isBad = (id, m) => Date.now() - (badModels.get(id)?.get(m) ?? -Infinity) < BAD_TTL;
function resetModelMemory() { goodModel.clear(); badModels.clear(); }

// API 호출에 시도할 모델 후보(순서대로). 사용자가 직접 정한 모델/환경변수로 고정한 모델은 후보 하나뿐이다.
async function apiCandidates(id, typed, staticDefault) {
  if (typed) return [typed];
  if (pinnedModel(id)) return [pinnedModel(id)];
  const live = await listModels(id);
  if (!live) return [staticDefault];
  const ranked = rankModels(id, live.ids);
  // 서비스 목록에는 새 계정에서는 이미 못 쓰는 모델(예: 구형 flash)도 남아 있다. 그래서 정적 기본값을 앞세우지 않고
  // 최근에 성공한 모델 > 순위(최신 안정판 flash 부터) 순으로 시도하며, 실패하면 다음으로 넘어간다. 정적 기본값은 맨 뒤 예비.
  const order = [goodModel.get(id), ...ranked, staticDefault].filter(Boolean);
  const uniq = [...new Set(order)].filter((m) => !isBad(id, m));
  return (uniq.length ? uniq : ranked).slice(0, 5);
}

// API 호출에 쓸 모델을 정한다: 직접 지정 > 환경변수 > (서비스 목록에 있으면) 기본값 > 목록의 추천 모델 > 정적 기본값
async function resolveApiModel(id, typed, staticDefault) {
  if (typed) return typed;
  if (pinnedModel(id)) return pinnedModel(id);
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
      ? '→ 모델 이름 문제로 보입니다. 왼쪽 참가자 카드의 모델 드롭다운을 "자동"으로 바꾸면 CLI 기본 모델로 실행됩니다.'
      : '→ 모델 이름 문제로 보입니다. 왼쪽 참가자 카드의 모델 드롭다운을 "자동"으로 바꾸거나 다른 모델을 고르세요.';
  const e = new Error(`${msg}\n${hint}`);
  e.cause = err;
  return e;
}

module.exports = { recommendedModel, rankModels, isModelAccessError, apiCandidates, markGood, markBad, resetModelMemory, cliModelChoices, codexCachedModels, resolveApiModel, listModels, listAllModels, pickDefault, withModelHint, newestFirst };
