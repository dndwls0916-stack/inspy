const http = require('http');
const fs = require('fs');
const path = require('path');
const { loadEnv } = require('./lib/env');
loadEnv();
const { PROVIDERS, isConfigured, hasApiKey, cliAvailable, defaultModel, isMock } = require('./lib/providers');
const { runCouncil } = require('./lib/council');

const PORT = Number(process.env.PORT) || 3000;
// 시작 시 기본 실행 방식: --mode=cli | --mode=api (또는 MODE 환경변수). 화면에서 바꿀 수 있다.
const argMode = (process.argv.find((a) => a.startsWith('--mode=')) || '').slice(7);
const DEFAULT_MODE = [argMode, process.env.MODE].find((m) => m === 'api' || m === 'cli') || 'api';
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

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
    defaultMode: DEFAULT_MODE,
    providers: Object.entries(PROVIDERS).map(([id, p]) => ({
      id,
      label: p.label,
      vendor: p.vendor,
      keyEnv: p.keyEnv,
      apiConfigured: hasApiKey(id),
      cliAvailable: cliAvailable(id),
      cliBin: p.cli.bin,
      model: defaultModel(id),
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

  const mode = body.mode === 'cli' ? 'cli' : 'api';
  const participants = (Array.isArray(body.participants) ? body.participants : [])
    .filter((p, i, a) => PROVIDERS[p?.id] && a.findIndex((q) => q.id === p.id) === i)
    .map((p) => {
      const typed = String(p.model || '').trim().slice(0, 100);
      // CLI 모드에서 모델을 비우면 CLI 자체 기본 모델을 쓴다.
      return { id: p.id, model: mode === 'cli' ? typed : typed || defaultModel(p.id) };
    });
  if (!participants.length) return sendJson(res, 400, { error: '참가할 AI를 한 명 이상 선택하세요' });
  const missing = participants.filter((p) => !isConfigured(p.id, mode));
  if (missing.length) {
    const what = mode === 'cli' ? missing.map((p) => `${PROVIDERS[p.id].cli.bin} CLI`) : missing.map((p) => PROVIDERS[p.id].keyEnv);
    return sendJson(res, 400, { error: mode === 'cli' ? `CLI가 설치되어 있지 않습니다: ${what.join(', ')}` : `.env 에 키가 없습니다: ${what.join(', ')}` });
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
    await runCouncil({ question, participants, rounds, moderator, history, mode, emit, signal: ac.signal });
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
    if (req.method === 'POST' && url.pathname === '/api/council') return await handleCouncil(req, res);

    if (url.pathname === '/favicon.ico') return res.writeHead(204).end();

    if (req.method === 'GET') {
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const file = path.join(PUBLIC, rel);
      if (file.startsWith(PUBLIC + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
        return fs.createReadStream(file).pipe(res);
      }
    }
    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    if (!res.headersSent) sendJson(res, 500, { error: String(err.message || err) });
    else res.end();
  }
});

if (require.main === module) {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`AI 회의실: http://localhost:${PORT}${isMock() ? '  (데모 모드: 실제 AI 호출 없음)' : ''}`);
    const ps = config().providers;
    const list = (k) => ps.filter((p) => p[k]).map((p) => p.label).join(', ') || '없음';
    console.log(`기본 실행 방식: ${DEFAULT_MODE.toUpperCase()}  (화면에서 변경 가능)`);
    console.log(`  API 사용 가능: ${list('apiConfigured')}`);
    console.log(`  CLI 사용 가능: ${list('cliAvailable')}`);
  });
}

module.exports = { server };
