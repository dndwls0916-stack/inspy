// GPT / Gemini / Claude 를 같은 형태로 호출하는 어댑터.
// call({ model, system, prompt, signal }) -> Promise<string>

const { spawn, spawnSync } = require('child_process');
const os = require('os');

const TIMEOUT_MS = 180000;
const MAX_OUTPUT_TOKENS = 2048;

async function postJson(url, headers, body, signal) {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  if (!res.ok) {
    const msg = json?.error?.message || json?.error || text.slice(0, 300);
    throw new Error(`HTTP ${res.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
  }
  return json;
}

// CLI 모드: 로그인된 각 AI의 CLI를 호출한다. (API 키 불필요, 구독 로그인 사용)
// 프롬프트는 stdin 으로 전달한다. 작업 폴더는 임시 폴더(프로젝트 파일 접근 방지).

// Windows 에서 npm 으로 설치한 CLI 는 .cmd 파일이라 셸 없이는 실행할 수 없다.
// 셸을 거치는 경우에도 인자는 허용 문자만 통과시킨다. (인자는 모델명과 고정 문구뿐이고, 사용자 입력은 stdin 으로만 간다)
const SAFE_ARG = /^[A-Za-z0-9._:\/ =-]+$/;
const winQuote = (a) => {
  if (!SAFE_ARG.test(a)) throw new Error(`CLI 인자에 사용할 수 없는 문자가 있습니다: ${a.slice(0, 40)} (모델 이름은 영문/숫자/. _ : / - 만 가능)`);
  return /\s/.test(a) ? `"${a}"` : a;
};

// 실행 방법을 결정한다. (순수 함수 — 플랫폼별 동작을 어디서든 테스트할 수 있다)
function buildSpawn(bin, args, platform = process.platform) {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(bin)) {
    const q = /\s/.test(bin) ? `"${bin}"` : bin;
    // 인자 배열 + shell:true 는 Node 가 경고하므로 검증된 인자로 명령 문자열을 직접 만든다.
    return { cmd: [q, ...args.map(winQuote)].join(' '), args: [], shell: true };
  }
  return { cmd: bin, args, shell: false };
}

// `where` 출력에서 실행 가능한 파일을 고른다. npm 은 확장자 없는 sh 스크립트와 .cmd 를 함께 설치하므로 .exe > .cmd > .bat 순으로 고른다.
function pickWinBin(lines) {
  const ext = (e) => lines.find((l) => l.toLowerCase().endsWith(e));
  return ext('.exe') || ext('.cmd') || ext('.bat') || null;
}

const winBinCache = new Map();
function resolveBin(bin, platform = process.platform) {
  if (platform !== 'win32' || /[\\/]/.test(bin) || /\.(exe|cmd|bat)$/i.test(bin)) return bin;
  if (!winBinCache.has(bin)) {
    const r = spawnSync('where', [bin], { encoding: 'utf8' });
    const lines = r.status === 0 ? r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : [];
    winBinCache.set(bin, pickWinBin(lines));
  }
  return winBinCache.get(bin) || bin;
}

function runCli(bin, args, input, signal) {
  return new Promise((resolve, reject) => {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    let plan;
    try {
      plan = buildSpawn(resolveBin(bin), args);
    } catch (e) {
      return reject(e);
    }
    const child = spawn(plan.cmd, plan.args, {
      cwd: os.tmpdir(),
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: plan.shell,
      windowsHide: true,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => reject(e.code === 'ENOENT' ? new Error(`'${bin}' 명령을 찾을 수 없습니다. 설치 후 로그인하세요.`) : e));
    child.on('close', (code) => {
      if (code === 0 && out.trim()) return resolve(out);
      reject(new Error(`${bin} 종료 코드 ${code}: ${(err || out).trim().slice(-300) || '출력 없음'}`));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

// 노력(생각 깊이): 화면의 낮음/보통/높음을 각 서비스의 설정으로 바꾼다. 지원하지 않는 모델이면 설정 없이 다시 시도한다(아래 withEffort).
const EFFORTS = ['low', 'medium', 'high'];
const GEMINI_BUDGET = { low: 1024, medium: 4096, high: 16384 };
const CLAUDE_MAX_TOKENS = { low: 4096, medium: 8192, high: 16000 }; // 생각하는 토큰도 max_tokens 에 포함되므로 높을수록 넉넉히

// 노력 설정이 원인으로 보이는 오류인가? (그렇다면 설정을 빼고 다시 시도)
function isEffortError(err) {
  return /^(HTTP 4\d\d|\S+ 종료 코드)/.test(String(err?.message)) && /effort|thinking|reasoning|output_config|budget/i.test(String(err.message));
}
async function withEffort(effort, meta, run) {
  if (!effort) return run(null);
  try {
    const out = await run(effort);
    if (meta) meta.effort = effort;
    return out;
  } catch (err) {
    if (!isEffortError(err)) throw err;
    if (meta) meta.effort = null; // 이 모델은 노력 설정을 받지 않아 기본값으로 실행됨
    return run(null);
  }
}

const PROVIDERS = {
  gpt: {
    label: 'GPT',
    vendor: 'OpenAI',
    keyEnv: 'OPENAI_API_KEY',
    modelEnv: 'OPENAI_MODEL',
    defaultModel: 'gpt-4o',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1'], // 키가 있으면 서비스에서 가져온 최신 목록으로 대체된다
    cli: { bin: 'codex', binEnv: 'CODEX_BIN', args: (m, effort) => ['exec', '--skip-git-repo-check', '-s', 'read-only', ...(m ? ['-m', m] : []), ...(effort ? ['-c', `model_reasoning_effort=${effort}`] : []), '-'] },
    async call({ model, system, prompt, signal, effort }) {
      const json = await postJson(
        'https://api.openai.com/v1/chat/completions',
        { authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        {
          model,
          ...(effort ? { reasoning_effort: effort } : {}),
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: prompt },
          ],
        },
        signal,
      );
      const out = json?.choices?.[0]?.message?.content;
      if (!out) throw new Error('빈 응답');
      return out;
    },
  },

  gemini: {
    label: 'Gemini',
    vendor: 'Google',
    keyEnv: 'GEMINI_API_KEY',
    modelEnv: 'GEMINI_MODEL',
    defaultModel: 'gemini-3.5-flash-lite', // 무료 키로 호출 가능한 모델(사용자 확인). 목록을 가져올 수 있으면 목록의 lite 계열이 먼저 쓰인다
    models: ['gemini-3.5-flash-lite', 'gemini-2.5-flash-lite', 'gemini-2.5-flash'],
    legacyDefaults: ['gemini-2.5-flash', 'gemini-2.0-flash'], // 예전 .env 템플릿이 적어 둔 값: 고정으로 보지 않는다(지금은 새 계정에서 못 쓴다)
    hint: '무료 키는 flash-lite 모델만 호출되는 경우가 많습니다. "자동"이면 lite 모델을 먼저 씁니다.',
    cli: { bin: 'gemini', binEnv: 'GEMINI_BIN', args: (m) => [...(m ? ['-m', m] : []), '-p', 'Answer the request given in the input. Use Korean.'] },
    async call({ model, system, prompt, signal, effort }) {
      const json = await postJson(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        { 'x-goog-api-key': process.env.GEMINI_API_KEY },
        {
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS * 4, ...(effort ? { thinkingConfig: /gemini-3/i.test(model) ? { thinkingLevel: effort } : { thinkingBudget: GEMINI_BUDGET[effort] } } : {}) },
        },
        signal,
      );
      const parts = json?.candidates?.[0]?.content?.parts;
      const out = parts?.map((p) => p.text || '').join('');
      if (!out) throw new Error(json?.promptFeedback?.blockReason ? `차단됨: ${json.promptFeedback.blockReason}` : '빈 응답');
      return out;
    },
  },

  claude: {
    label: 'Claude',
    vendor: 'Anthropic',
    keyEnv: 'ANTHROPIC_API_KEY',
    modelEnv: 'ANTHROPIC_MODEL',
    defaultModel: 'claude-sonnet-5-5',
    models: ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
    cli: { bin: 'claude', binEnv: 'CLAUDE_BIN', args: (m, effort) => ['-p', ...(m ? ['--model', m] : []), ...(effort ? ['--effort', effort] : [])] },
    async call({ model, system, prompt, signal, effort }) {
      const json = await postJson(
        'https://api.anthropic.com/v1/messages',
        { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        {
          model,
          max_tokens: effort ? CLAUDE_MAX_TOKENS[effort] : MAX_OUTPUT_TOKENS,
          ...(effort ? { output_config: { effort } } : {}),
          system,
          messages: [{ role: 'user', content: prompt }],
        },
        signal,
      );
      const out = json?.content?.filter((b) => b.type === 'text').map((b) => b.text).join('');
      if (!out) throw new Error('빈 응답');
      return out;
    },
  },
};

// --- OpenAI 호환 API 로 붙는 다른 AI 들 ---
// 같은 형식(POST {base}/chat/completions)을 쓰는 서비스는 주소와 키 이름만 다르다. 새 AI 를 더하려면 이 표에 한 줄 추가하면 된다.
// color: 화면 표시 색. envHint: 설정 안내. keyless: 키 없이 쓰는 로컬 서버. effort:false 이면 생각 깊이 설정을 보내지 않는다.
const compat = ({ label, vendor, keyEnv, modelEnv, baseUrl, defaultModel, models, color, envHint, keyless = false, effort = false, available, alwaysPin = true }) => ({
  label, vendor, keyEnv, modelEnv, defaultModel, models, color, envHint, keyless, compat: true, cli: null, effort, alwaysPin,
  baseUrl: typeof baseUrl === 'function' ? baseUrl : () => baseUrl,
  key: () => process.env[keyEnv] || '',
  available: available || (keyless ? null : () => Boolean(process.env[keyEnv])),
  async call({ model, system, prompt, signal, effort: eff }) {
    const key = this.key();
    const json = await postJson(
      `${this.baseUrl().replace(/\/+$/, '')}/chat/completions`,
      key ? { authorization: `Bearer ${key}` } : {},
      { model, ...(eff && this.effort ? { reasoning_effort: eff } : {}), messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] },
      signal,
    );
    const out = json?.choices?.[0]?.message?.content;
    if (!out) throw new Error('빈 응답');
    return out;
  },
});

Object.assign(PROVIDERS, {
  grok: compat({ label: 'Grok', vendor: 'xAI', keyEnv: 'XAI_API_KEY', modelEnv: 'XAI_MODEL', baseUrl: 'https://api.x.ai/v1', defaultModel: 'grok-4', models: ['grok-4', 'grok-3', 'grok-3-mini'], color: '#111827', envHint: 'XAI_API_KEY', effort: true }),
  deepseek: compat({ label: 'DeepSeek', vendor: 'DeepSeek', keyEnv: 'DEEPSEEK_API_KEY', modelEnv: 'DEEPSEEK_MODEL', baseUrl: 'https://api.deepseek.com/v1', defaultModel: 'deepseek-chat', models: ['deepseek-chat', 'deepseek-reasoner'], color: '#2563eb', envHint: 'DEEPSEEK_API_KEY' }),
  mistral: compat({ label: 'Mistral', vendor: 'Mistral AI', keyEnv: 'MISTRAL_API_KEY', modelEnv: 'MISTRAL_MODEL', baseUrl: 'https://api.mistral.ai/v1', defaultModel: 'mistral-large-latest', models: ['mistral-large-latest', 'mistral-medium-latest', 'mistral-small-latest'], color: '#f97316', envHint: 'MISTRAL_API_KEY' }),
  perplexity: compat({ label: 'Perplexity', vendor: 'Perplexity (웹 검색 내장)', keyEnv: 'PERPLEXITY_API_KEY', modelEnv: 'PERPLEXITY_MODEL', baseUrl: 'https://api.perplexity.ai', defaultModel: 'sonar', models: ['sonar', 'sonar-pro', 'sonar-reasoning-pro', 'sonar-deep-research'], color: '#0d9488', envHint: 'PERPLEXITY_API_KEY' }),
  groq: compat({ label: 'Groq', vendor: 'Groq (Llama·Qwen 등 오픈 모델)', keyEnv: 'GROQ_API_KEY', modelEnv: 'GROQ_MODEL', baseUrl: 'https://api.groq.com/openai/v1', defaultModel: 'llama-3.3-70b-versatile', models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'], color: '#ea580c', envHint: 'GROQ_API_KEY' }),
  openrouter: compat({ label: 'OpenRouter', vendor: 'OpenRouter (수백 개 모델)', keyEnv: 'OPENROUTER_API_KEY', modelEnv: 'OPENROUTER_MODEL', baseUrl: 'https://openrouter.ai/api/v1', defaultModel: 'meta-llama/llama-3.3-70b-instruct', models: ['meta-llama/llama-3.3-70b-instruct', 'qwen/qwen-2.5-72b-instruct', 'mistralai/mistral-large'], color: '#7c3aed', envHint: 'OPENROUTER_API_KEY' }),
  ollama: compat({ label: 'Ollama', vendor: '내 PC에서 실행(무료)', keyEnv: 'OLLAMA_API_KEY', modelEnv: 'OLLAMA_MODEL', baseUrl: () => process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1', defaultModel: 'llama3.1', models: ['llama3.1', 'qwen2.5', 'gemma2'], color: '#64748b', envHint: 'OLLAMA_MODEL (또는 OLLAMA_BASE_URL)', keyless: true, alwaysPin: true, available: () => Boolean(process.env.OLLAMA_MODEL || process.env.OLLAMA_BASE_URL) }),
  custom: compat({ label: process.env.CUSTOM_LABEL || '사용자 지정', vendor: 'OpenAI 호환 서버', keyEnv: 'CUSTOM_API_KEY', modelEnv: 'CUSTOM_MODEL', baseUrl: () => process.env.CUSTOM_BASE_URL || '', defaultModel: process.env.CUSTOM_MODEL || 'model', models: process.env.CUSTOM_MODEL ? [process.env.CUSTOM_MODEL] : [], color: '#be185d', envHint: 'CUSTOM_BASE_URL, CUSTOM_MODEL', keyless: true, alwaysPin: true, available: () => Boolean(process.env.CUSTOM_BASE_URL && process.env.CUSTOM_MODEL) }),
});

const isMock = () => process.env.MOCK === '1';

const cliBin = (id) => (PROVIDERS[id].cli ? process.env[PROVIDERS[id].cli.binEnv] || PROVIDERS[id].cli.bin : null);

function cliAvailable(id) {
  if (!PROVIDERS[id].cli) return false; // CLI 방식이 없는 AI(API 전용)
  if (isMock()) return true;
  const bin = cliBin(id);
  if (process.platform === 'win32') {
    const r = spawnSync('where', [bin], { stdio: 'ignore' });
    return r.status === 0 && resolveBin(bin) !== null;
  }
  return spawnSync('which', [bin], { stdio: 'ignore' }).status === 0;
}

function hasApiKey(id) {
  if (isMock()) return true;
  const p = PROVIDERS[id];
  return p.available ? p.available() : Boolean(process.env[p.keyEnv]);
}

// 혼합 방식: API 키가 있는 AI 는 API 로, 없는 AI 는 CLI 로 호출한다.
function resolveMode(id, mode) {
  if (!PROVIDERS[id].cli) return 'api'; // API 전용 AI
  return mode === 'mixed' ? (hasApiKey(id) ? 'api' : 'cli') : mode;
}

function isConfigured(id, mode = 'api') {
  if (!PROVIDERS[id].cli) return hasApiKey(id); // API 전용 AI 는 실행 방식과 무관하게 키(또는 로컬 설정)만 있으면 된다
  if (mode === 'mixed') return hasApiKey(id) || cliAvailable(id);
  return mode === 'cli' ? cliAvailable(id) : hasApiKey(id);
}

// .env 로 모델을 "고정"했는가? 이전 버전의 .env 템플릿이 기본 모델명을 그대로 적어 두었으므로, 기본값과 같은 값은 고정으로 보지 않는다.
function pinnedModel(id) {
  const v = process.env[PROVIDERS[id].modelEnv];
  const p = PROVIDERS[id];
  if (!v || p.legacyDefaults?.includes(v)) return null;
  return v !== p.defaultModel || p.alwaysPin ? v : null; // 로컬/사용자 지정 서버는 적어 둔 모델을 그대로 쓴다
}

function defaultModel(id) {
  return process.env[PROVIDERS[id].modelEnv] || PROVIDERS[id].defaultModel;
}

// 키 없이 화면/흐름을 확인하기 위한 가짜 응답 (MOCK=1)
async function mockCall(id, { prompt, system = '', effort }) {
  await new Promise((r) => setTimeout(r, (300 + Math.random() * 700) * (Number(process.env.MOCK_SLOW) || 1)));
  const label = PROVIDERS[id].label;
  // 테스트용 시나리오: 질문에 들어 있는 표시로 동작을 바꾼다
  if (prompt.includes('FAIL-ROUND2') && id === 'gemini' && prompt.includes('이제 2라운드입니다')) throw new Error('(데모) 호출 실패');
  if (prompt.includes('FAIL-FINAL-CLAUDE') && id === 'claude' && prompt.includes('[최종 결론 작성]')) throw new Error('(데모) 결론 호출 실패');
  if (prompt.includes('FAIL-JUDGE-CLAUDE') && id === 'claude' && prompt.includes('[합의 판정]')) throw new Error('(데모) 판정 호출 실패');
  if (prompt.includes('[최종안 확인]')) {
    if (prompt.includes('RATIFY-FAIL') && id === 'gemini') throw new Error('(데모) 확인 호출 실패');
    if (prompt.includes('RATIFY-DISSENT') && id === 'gemini') return JSON.stringify({ vote: 'conditional', condition: '(데모) 비용 상한을 명시할 것', reason: '' });
    if (prompt.includes('RATIFY-BAD') && id === 'gemini') return '동의합니다!';
    return JSON.stringify({ vote: 'agree', condition: '', reason: '(데모) 결론안에 동의' });
  }
  if (prompt.includes('[합의 판정]')) {
    // 데모: 3라운드째에 합의. 질문에 NEVER-AGREE 가 있으면 끝까지 불합의, STALL 이 있으면 진전 없음.
    const n = Number((prompt.match(/검토 라운드: (\d+)/) || [])[1] || 0);
    const never = prompt.includes('NEVER-AGREE') || prompt.includes('STALL');
    const reached = !never && n >= 3;
    return JSON.stringify({ consensus: reached, summary: (reached ? '(데모) 작게 시작해 검증하자는 데 모두 동의' : '(데모) 속도와 안정성 사이에서 입장이 갈림') + (prompt.includes('[첨부 자료]') ? ' (판정에 첨부 포함됨)' : ''), disagreements: reached ? [] : ['(데모) 속도 우선 vs 안정성 우선'], positions: { [label]: '(데모) 단계적 접근' }, stalled: prompt.includes('STALL') });
  }
  if (prompt.includes('[최종 결론 작성]')) {
    // 테스트용: 최종 프롬프트에 어떤 안내가 들어갔는지 결과에 표시한다
    const wired = [
      prompt.includes('## 소수 의견·남은 조건') && '소수의견칸',
      prompt.includes('[회의 중 제기된 조건·반대]') && '제기된조건전달',
      prompt.includes('호출 실패로 참여하지 못해') && '불참자안내',
      prompt.includes('[응답하지 못한 참가자]') && '실패자표시',
      prompt.includes('최종안 확인(참가자별 비공개 투표)') && '투표결과',
      prompt.includes('[진행자(사람)가 회의 중에 한 말]') && '진행자말전달',
      prompt.includes('[진행자 요청]') && '결론요청',
    ].filter(Boolean).join(',');
    return `(데모 프롬프트: ${wired}) ## 결론\n(데모) 세 AI의 의견을 종합한 결론입니다.\n\n## 합의된 점\n- 목표를 먼저 명확히 한다\n- 작게 시작해서 검증한다\n\n## 의견이 갈린 점\n- ${label}: 속도 우선 vs 다른 AI: 안정성 우선\n\n## 추천 다음 단계\n1. 가장 작은 실험을 정한다\n2. 결과를 보고 방향을 조정한다`;
  }
  if (prompt.includes('[군사의 한마디]')) return '**한 줄 요약:** (데모) 작게 시작해 검증하라.\n**군사의 책략:** (데모) 천하를 얻으려면 먼저 한 고을을 지키시오.\n**오늘의 첫 수:** (데모) 가장 작은 실험 하나를 정한다.';
  const roleName = (system.match(/\[역할\] 이 회의에서 당신은 "([^"]+)"/) || [])[1];
  const tone = (roleName ? `(역할: ${roleName}) ` : '') + (effort ? `(노력: ${effort}) ` : '') + (system.includes('[연기 지침]') ? '(사극 말투) ' : '') + (prompt.includes('[첨부 자료]') ? `(첨부 ${(prompt.match(/<<<파일: /g) || []).length}개 인식) ` : '') + (prompt.includes('[진행자(사람)가 회의 중에 한 말]') ? '(진행자 말 반영) ' : '');
  return `**${label}의 의견 (데모)**\n${tone}\n- 핵심 포인트 1\n- 핵심 포인트 2\n\n다른 참가자와 달리 저는 단계적 접근을 권합니다.`;
}

async function callProvider(id, { mode = 'api', model, system, prompt, signal, onUse, onRequest, effort = '', meta }) {
  if (!EFFORTS.includes(effort) || PROVIDERS[id].effort === false) effort = ''; // 이 AI 는 생각 깊이 설정을 받지 않는다
  if (isMock()) {
    onUse?.(model || '');
    onRequest?.();
    if (meta) meta.effort = effort || null;
    return mockCall(id, { prompt, system, effort });
  }
  const via = resolveMode(id, mode);
  const models = require('./models');
  // CLI 는 모델이 하나(비우면 CLI 기본). API 는 자동이면 후보를 순서대로 시도한다.
  const candidates = via === 'cli' ? [model || ''] : await models.apiCandidates(id, model, defaultModel(id));
  let lastErr;
  for (let i = 0; i < candidates.length && i < 6; i++) {
    const m = candidates[i];
    onUse?.(m);
    try {
      // Gemini CLI 는 노력 설정이 없어 무시된다(meta.effort = null).
      const out = via === 'cli'
        ? await withEffort(id === 'gemini' ? '' : effort, meta, (e) => { onRequest?.(); return runCli(cliBin(id), PROVIDERS[id].cli.args(m, e), `${system}\n\n${prompt}`, signal); })
        : await withEffort(effort, meta, (e) => { onRequest?.(); return PROVIDERS[id].call({ model: m, system, prompt, signal, effort: e }); });
      if (effort && id === 'gemini' && via === 'cli' && meta) meta.effort = null;
      if (via === 'api') models.markGood(id, m);
      return out;
    } catch (err) {
      if (err?.budget) throw err; // 호출 상한: 대체 모델 재시도도 멈춘다
      lastErr = models.withModelHint(err, { model: m, via });
      if (via !== 'api') throw lastErr;
      // 서비스가 "이 모델 대신 X 를 쓰라"고 알려 주면(직접 고른 모델이어도) X 로 바로 바꿔 다시 시도한다.
      const rec = models.recommendedModel(err);
      if (rec && !candidates.includes(rec)) {
        models.markBad(id, m);
        candidates.splice(i + 1, 0, rec);
        continue;
      }
      // 자동(후보가 여럿)일 때, 이 모델이 계정에서 안 되는 것이면 다음 후보로.
      if (i < candidates.length - 1 && models.isModelAccessError(err)) {
        models.markBad(id, m);
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr;
}

module.exports = { PROVIDERS, isConfigured, hasApiKey, cliAvailable, defaultModel, callProvider, isMock, buildSpawn, pickWinBin, resolveMode, pinnedModel, EFFORTS, isEffortError };
