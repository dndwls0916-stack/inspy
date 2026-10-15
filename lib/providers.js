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
const SAFE_ARG = /^[A-Za-z0-9._:\/ -]+$/;
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

const PROVIDERS = {
  gpt: {
    label: 'GPT',
    vendor: 'OpenAI',
    keyEnv: 'OPENAI_API_KEY',
    modelEnv: 'OPENAI_MODEL',
    defaultModel: 'gpt-4o',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-5'],
    cli: { bin: 'codex', binEnv: 'CODEX_BIN', args: (m) => ['exec', '--skip-git-repo-check', '-s', 'read-only', ...(m ? ['-m', m] : []), '-'] },
    async call({ model, system, prompt, signal }) {
      const json = await postJson(
        'https://api.openai.com/v1/chat/completions',
        { authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        {
          model,
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
    defaultModel: 'gemini-2.5-flash',
    models: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'],
    cli: { bin: 'gemini', binEnv: 'GEMINI_BIN', args: (m) => [...(m ? ['-m', m] : []), '-p', 'Answer the request given in the input. Use Korean.'] },
    async call({ model, system, prompt, signal }) {
      const json = await postJson(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        { 'x-goog-api-key': process.env.GEMINI_API_KEY },
        {
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS * 4 },
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
    cli: { bin: 'claude', binEnv: 'CLAUDE_BIN', args: (m) => ['-p', ...(m ? ['--model', m] : [])] },
    async call({ model, system, prompt, signal }) {
      const json = await postJson(
        'https://api.anthropic.com/v1/messages',
        { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        {
          model,
          max_tokens: MAX_OUTPUT_TOKENS,
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

const isMock = () => process.env.MOCK === '1';

const cliBin = (id) => process.env[PROVIDERS[id].cli.binEnv] || PROVIDERS[id].cli.bin;

function cliAvailable(id) {
  if (isMock()) return true;
  const bin = cliBin(id);
  if (process.platform === 'win32') {
    const r = spawnSync('where', [bin], { stdio: 'ignore' });
    return r.status === 0 && resolveBin(bin) !== null;
  }
  return spawnSync('which', [bin], { stdio: 'ignore' }).status === 0;
}

function hasApiKey(id) {
  return isMock() || Boolean(process.env[PROVIDERS[id].keyEnv]);
}

// 혼합 방식: API 키가 있는 AI 는 API 로, 없는 AI 는 CLI 로 호출한다.
function resolveMode(id, mode) {
  return mode === 'mixed' ? (hasApiKey(id) ? 'api' : 'cli') : mode;
}

function isConfigured(id, mode = 'api') {
  if (mode === 'mixed') return hasApiKey(id) || cliAvailable(id);
  return mode === 'cli' ? cliAvailable(id) : hasApiKey(id);
}

function defaultModel(id) {
  return process.env[PROVIDERS[id].modelEnv] || PROVIDERS[id].defaultModel;
}

// 키 없이 화면/흐름을 확인하기 위한 가짜 응답 (MOCK=1)
async function mockCall(id, { prompt, system = '' }) {
  await new Promise((r) => setTimeout(r, 300 + Math.random() * 700));
  const label = PROVIDERS[id].label;
  if (prompt.includes('[최종 결론 작성]')) {
    return `## 결론\n(데모) 세 AI의 의견을 종합한 결론입니다.\n\n## 합의된 점\n- 목표를 먼저 명확히 한다\n- 작게 시작해서 검증한다\n\n## 의견이 갈린 점\n- ${label}: 속도 우선 vs 다른 AI: 안정성 우선\n\n## 추천 다음 단계\n1. 가장 작은 실험을 정한다\n2. 결과를 보고 방향을 조정한다`;
  }
  if (prompt.includes('[군사의 한마디]')) return '**한 줄 요약:** (데모) 작게 시작해 검증하라.\n**군사의 책략:** (데모) 천하를 얻으려면 먼저 한 고을을 지키시오.\n**오늘의 첫 수:** (데모) 가장 작은 실험 하나를 정한다.';
  const tone = system.includes('[연기 지침]') ? '(사극 말투) ' : '';
  return `**${label}의 의견 (데모)**\n${tone}\n- 핵심 포인트 1\n- 핵심 포인트 2\n\n다른 참가자와 달리 저는 단계적 접근을 권합니다.`;
}

async function callProvider(id, { mode = 'api', model, system, prompt, signal }) {
  if (isMock()) return mockCall(id, { prompt, system });
  if (resolveMode(id, mode) === 'cli') {
    return runCli(cliBin(id), PROVIDERS[id].cli.args(model), `${system}\n\n${prompt}`, signal);
  }
  return PROVIDERS[id].call({ model: model || defaultModel(id), system, prompt, signal });
}

module.exports = { PROVIDERS, isConfigured, hasApiKey, cliAvailable, defaultModel, callProvider, isMock, buildSpawn, pickWinBin, resolveMode };
