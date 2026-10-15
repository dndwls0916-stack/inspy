const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { loadEnv, appDir } = require('./lib/env');
loadEnv();
const { PROVIDERS, isConfigured, hasApiKey, cliAvailable, defaultModel, isMock } = require('./lib/providers');

// 단일 실행파일(SEA)로 실행 중이면 화면 파일을 실행파일 안에서 읽는다.
let sea = null;
try {
  const m = require('node:sea');
  if (m.isSea()) sea = m;
} catch {}
const { runCouncil } = require('./lib/council');
const { listAllModels, cliModelChoices } = require('./lib/models');
const { PERSONAS, SAGE } = require('./lib/personas');

const PORT = Number(process.env.PORT) || 3000;
// 시작 시 기본 실행 방식: --mode=cli | --mode=api (또는 MODE 환경변수). 화면에서 바꿀 수 있다.
const argMode = (process.argv.find((a) => a.startsWith('--mode=')) || '').slice(7);
const MODES = ['api', 'cli', 'mixed'];
const explicitMode = [argMode, process.env.MODE].find((m) => MODES.includes(m));
// 지정이 없으면: 키와 CLI 가 모두 있으면 mixed, 키만 있으면 api, CLI 만 있으면 cli
const autoMode = () => {
  const ids = Object.keys(PROVIDERS);
  const anyKey = ids.some(hasApiKey);
  const anyCli = ids.some(cliAvailable);
  return anyKey && anyCli ? 'mixed' : anyKey ? 'api' : anyCli ? 'cli' : 'api';
};
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function readStatic(rel) {
  if (sea) {
    try {
      return Buffer.from(sea.getAsset(`public/${rel}`));
    } catch {
      return null;
    }
  }
  const file = path.join(PUBLIC, rel);
  if (file.startsWith(PUBLIC + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) return fs.readFileSync(file);
  return null;
}

function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {}
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('요청이 너무 큽니다'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function config() {
  return {
    mock: isMock(),
    defaultMode: explicitMode || autoMode(),
    sage: SAGE,
    providers: Object.entries(PROVIDERS).map(([id, p]) => ({
      id,
      label: p.label,
      vendor: p.vendor,
      keyEnv: p.keyEnv,
      apiConfigured: hasApiKey(id),
      cliAvailable: cliAvailable(id),
      cliBin: p.cli.bin,
      persona: PERSONAS[id],
      model: defaultModel(id),
      modelPinned: Boolean(process.env[p.modelEnv]),
      cliModels: cliModelChoices(id),
      models: p.models,
    })),
  };
}

async function handleCouncil(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: '잘못된 요청입니다' });
  }

  const question = String(body.question || '').trim();
  if (!question) return sendJson(res, 400, { error: '질문을 입력하세요' });
  if (question.length > 8000) return sendJson(res, 400, { error: '질문이 너무 깁니다 (8000자 이하)' });

  const mode = MODES.includes(body.mode) ? body.mode : 'api';
  const participants = (Array.isArray(body.participants) ? body.participants : [])
    .filter((p, i, a) => PROVIDERS[p?.id] && a.findIndex((q) => q.id === p.id) === i)
    .map((p) => {
      const typed = String(p.model || '').trim().slice(0, 100);
      // CLI 모드에서 모델을 비우면 CLI 자체 기본 모델을 쓴다.
      return { id: p.id, model: typed }; // 비우면 호출 시점에 자동 결정(API: 서비스 목록의 추천, CLI: CLI 기본)
    });
  if (!participants.length) return sendJson(res, 400, { error: '참가할 AI를 한 명 이상 선택하세요' });
  const missing = participants.filter((p) => !isConfigured(p.id, mode));
  if (missing.length) {
    const names = missing.map((p) => PROVIDERS[p.id]);
    const error =
      mode === 'cli' ? `CLI가 설치되어 있지 않습니다: ${names.map((n) => `${n.cli.bin} CLI`).join(', ')}`
      : mode === 'mixed' ? `API 키도 CLI도 없습니다: ${names.map((n) => `${n.label}(${n.keyEnv} 또는 ${n.cli.bin} CLI)`).join(', ')}`
      : `.env 에 키가 없습니다: ${names.map((n) => n.keyEnv).join(', ')}`;
    return sendJson(res, 400, { error });
  }

  const rounds = Math.min(3, Math.max(1, Number(body.rounds) || 2));
  const moderator = participants.some((p) => p.id === body.moderator) ? body.moderator : participants[0].id;
  const history = (Array.isArray(body.history) ? body.history : [])
    .slice(-3)
    .map((h) => ({ question: String(h.question || '').slice(0, 500), conclusion: String(h.conclusion || '').slice(0, 1500) }));

  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  const emit = (ev) => !res.writableEnded && res.write(`data: ${JSON.stringify(ev)}\n\n`);

  try {
    await runCouncil({ question, participants, rounds, moderator, history, mode, persona: body.persona === true, emit, signal: ac.signal });
  } catch (err) {
    emit({ type: 'error', error: String(err.message || err) });
  }
  emit({ type: 'done' });
  res.end();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/api/config') return sendJson(res, 200, config());
    if (req.method === 'GET' && url.pathname === '/api/models') return sendJson(res, 200, isMock() ? {} : await listAllModels());
    if (req.method === 'POST' && url.pathname === '/api/council') return await handleCouncil(req, res);

    if (url.pathname === '/favicon.ico') return res.writeHead(204).end();

    if (req.method === 'GET') {
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const body = readStatic(rel);
      if (body) {
        res.writeHead(200, { 'content-type': MIME[path.extname(rel)] || 'application/octet-stream' });
        return res.end(body);
      }
    }
    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    if (!res.headersSent) sendJson(res, 500, { error: String(err.message || err) });
    else res.end();
  }
});

// 실행파일에서 더블클릭으로 실행하면 콘솔 창이 바로 닫히므로, 오류 시 키 입력을 기다린다.
function fail(msg) {
  console.error(msg);
  if (sea) {
    console.error('\n아무 키나 누르면 종료합니다...');
    process.stdin.resume();
    process.stdin.once('data', () => process.exit(1));
  } else process.exit(1);
}

if (require.main === module || sea) {
  if (sea) {
    // 처음 실행이면 .env 템플릿을 실행파일 옆에 만들어 준다.
    const envFile = path.join(appDir(), '.env');
    if (!fs.existsSync(envFile)) {
      try {
        fs.writeFileSync(envFile, Buffer.from(sea.getAsset('.env.example')));
        console.log(`설정 파일을 만들었습니다: ${envFile}\n(API 키 방식을 쓰려면 이 파일에 키를 넣고 다시 실행하세요. CLI 로그인 방식은 키가 필요 없습니다.)\n`);
      } catch {}
    }
  }
  server.on('error', (err) => fail(err.code === 'EADDRINUSE' ? `포트 ${PORT} 가 이미 사용 중입니다. 이미 실행 중이거나 .env 의 PORT 를 바꿔 주세요.` : String(err.message || err)));
  server.listen(PORT, '127.0.0.1', () => {
    const url = `http://localhost:${PORT}`;
    console.log(`AI 회의실: ${url}${isMock() ? '  (데모 모드: 실제 AI 호출 없음)' : ''}`);
    const ps = config().providers;
    const list = (k) => ps.filter((p) => p[k]).map((p) => p.label).join(', ') || '없음';
    console.log(`기본 실행 방식: ${config().defaultMode.toUpperCase()}  (화면에서 변경 가능)`);
    console.log(`  API 사용 가능: ${list('apiConfigured')}`);
    console.log(`  CLI 사용 가능: ${list('cliAvailable')}`);
    if (sea && process.env.NO_OPEN !== '1') openBrowser(url);
    if (sea) console.log('\n이 창을 닫으면 프로그램이 종료됩니다.');
  });
}

module.exports = { server };
