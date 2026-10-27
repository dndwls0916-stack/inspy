const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { loadEnv, appDir } = require('./lib/env');
loadEnv();
const { PROVIDERS, isConfigured, hasApiKey, cliAvailable, defaultModel, callProvider, pinnedModel, isMock, EFFORTS } = require('./lib/providers');

// 단일 실행파일(SEA)로 실행 중이면 화면 파일을 실행파일 안에서 읽는다.
let sea = null;
try {
  const m = require('node:sea');
  if (m.isSea()) sea = m;
} catch {}
const { runCouncil } = require('./lib/council');
const { listAllModels, cliModelChoices } = require('./lib/models');
const { PERSONAS, SAGE } = require('./lib/personas');
const backup = require('./lib/backup');
const setup = require('./lib/setup');
const actions = require('./lib/actions');
const decisions = require('./lib/decisions');
const drafts = require('./lib/drafts');
const usageStats = require('./lib/usage');
const { scanFolder, saveOutput, readFolderXlsx } = require('./lib/folder');
const { ROLES, TEAMS, publicRoles } = require('./lib/roles');
const { estimate } = require('./lib/estimate');
const profile = require('./lib/profile');
const crypto = require('crypto');
const { redactRequest, createRedactor } = require('./lib/redact');
const xlsxPick = require('./lib/xlsx_pick');
const { FORMS } = require('./lib/forms_logistics');
const { createMinutes, listMinutes, readMinutes } = require('./lib/minutes');
const os = require('os');

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
const MAX_ATTACH_FILES = 30;
const MAX_PARTICIPANTS = 8;
const DEFAULT_MAX_CALLS = Number(process.env.MAX_CALLS) || 120; // 회의 한 번의 AI 호출 상한 기본값(비용 폭주 방지). 화면에서 바꿀 수 있다
const MAX_CALLS_LIMIT = 500;
const MAX_MEETINGS = 2; // 동시에 진행할 수 있는 회의 수
let activeMeetings = 0;
// 회의록 저장 위치: 실행파일(또는 프로젝트) 옆 '회의록' 폴더. 데모 모드에서는 임시 폴더.
const minutesDir = () => process.env.MINUTES_DIR || (isMock() ? path.join(os.tmpdir(), 'ai-council-test-minutes') : path.join(appDir(), '회의록'));
const UNLIMITED_ROUNDS = 30; // '결론 날 때까지'의 안전 상한(무한 루프/비용 폭주 방지). 평행선이면 그보다 먼저 멈춘다
const MAX_ATTACH_CHARS = 150_000;
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.css': 'text/css; charset=utf-8' };

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

function readBody(req, limit = 2_000_000) {
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

function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('파일이 너무 큽니다(20MB 이하)')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// 엑셀 시트·행 고르기: 한 번 읽은 통합 문서를 잠시 보관(최대 4개, 20분)하고, 고른 부분만 글로 뽑아 준다.
const xlsxCache = new Map(); // token -> { wb, name, at }
function xlsxRemember(wb, name) {
  const now = Date.now();
  for (const [k, v] of xlsxCache) if (now - v.at > 20 * 60 * 1000) xlsxCache.delete(k);
  while (xlsxCache.size >= 4) xlsxCache.delete(xlsxCache.keys().next().value);
  const token = crypto.randomBytes(8).toString('hex');
  xlsxCache.set(token, { wb, name, at: now });
  return token;
}
function xlsxOpen(buf, name) {
  let wb;
  try { wb = xlsxPick.parseWorkbook(buf); } catch (e) { throw new Error(`엑셀(.xlsx) 파일을 읽지 못했습니다: ${String(e.message || e).slice(0, 80)}`); }
  return { token: xlsxRemember(wb, name), name, sheets: xlsxPick.describe(wb) };
}
async function handleXlsx(req, res, url) {
  try {
    if (url.pathname === '/api/xlsx/inspect') {
      const buf = await readRaw(req, 20 * 1024 * 1024);
      const name = String(url.searchParams.get('name') || '엑셀.xlsx').slice(0, 120);
      return sendJson(res, 200, xlsxOpen(buf, name));
    }
    const b = JSON.parse(await readBody(req, 100_000));
    if (url.pathname === '/api/xlsx/inspect-folder') {
      const f = readFolderXlsx(b.path, b.rel);
      return sendJson(res, 200, xlsxOpen(f.buf, f.name));
    }
    const hit = xlsxCache.get(String(b.token || ''));
    if (!hit) return sendJson(res, 404, { error: '엑셀을 다시 열어 주세요(보관 시간이 지났습니다)' });
    hit.at = Date.now();
    const picks = (Array.isArray(b.picks) ? b.picks : []).slice(0, 6);
    if (!picks.length) return sendJson(res, 400, { error: '가져올 시트를 고르세요' });
    const maxChars = Math.min(80000, Math.max(500, Math.floor(Number(b.maxChars)) || 80000));
    const r = xlsxPick.extractSelection(hit.wb, picks, { maxChars, rowNumbers: b.rowNumbers !== false, previewLines: b.preview ? 14 : 0, stats: b.stats === true });
    return sendJson(res, 200, r);
  } catch (e) {
    return sendJson(res, 400, { error: String(e.message || e) });
  }
}

function config() {
  return {
    mock: isMock(),
    setupNeeded: !isMock() && !Object.keys(PROVIDERS).some((id) => hasApiKey(id) || cliAvailable(id)),
    defaultMode: explicitMode || autoMode(),
    sage: SAGE,
    defaultMaxCalls: DEFAULT_MAX_CALLS,
    maxCallsLimit: MAX_CALLS_LIMIT,
    minutesDefault: process.env.NO_MINUTES !== '1',
    roles: publicRoles(),
    teams: TEAMS,
    forms: FORMS,
    profileTemplate: profile.TEMPLATE,
    providers: Object.entries(PROVIDERS).map(([id, p]) => ({
      id,
      label: p.label,
      vendor: p.vendor,
      keyEnv: p.keyEnv,
      apiConfigured: hasApiKey(id),
      cliAvailable: cliAvailable(id),
      cliBin: p.cli ? p.cli.bin : null,
      cliSupported: Boolean(p.cli),
      color: p.color || null,
      envHint: p.envHint || p.keyEnv,
      hint: p.hint || '',
      extra: Boolean(p.compat),
      persona: PERSONAS[id],
      model: defaultModel(id),
      modelPinned: Boolean(pinnedModel(id)),
      cliModels: cliModelChoices(id),
      models: p.models,
    })),
  };
}

// 이 프로그램은 내 컴퓨터의 폴더를 읽고 쓸 수 있으므로, 다른 웹사이트가 몰래 요청을 보내지 못하게
// (CSRF / DNS rebinding) 주소(Host)와 출처(Origin)가 이 서버 자신인 요청만 받는다.
function sameOrigin(req) {
  const host = String(req.headers.host || '').toLowerCase();
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)) return false;
  const origin = req.headers.origin;
  return !origin || origin.toLowerCase() === `http://${host}`;
}

async function handleFolder(req, res, action) {
  let body;
  try {
    body = JSON.parse(await readBody(req, 700_000));
  } catch {
    return sendJson(res, 400, { error: '잘못된 요청입니다' });
  }
  try {
    if (action === 'scan') return sendJson(res, 200, scanFolder(body.path));
    const saved = saveOutput(body.path, { name: body.name, format: body.format, content: body.content });
    return sendJson(res, 200, saved);
  } catch (err) {
    return sendJson(res, 400, { error: String(err.message || err) });
  }
}

async function handleEstimate(req, res) {
  let b;
  try {
    b = JSON.parse(await readBody(req, 20_000));
  } catch {
    return sendJson(res, 400, { error: '잘못된 요청입니다' });
  }
  const consensus = b.consensus === true;
  const maxCalls = clampCalls(b.maxCalls);
  return sendJson(res, 200, estimate({
    n: Math.min(MAX_PARTICIPANTS, Math.max(1, Number(b.n) || 1)),
    rounds: Math.min(3, Math.max(1, Number(b.rounds) || 2)),
    consensus,
    unlimited: consensus && b.unlimited === true,
    maxRounds: Math.min(8, Math.max(2, Number(b.maxRounds) || 5)),
    persona: b.persona === true,
    premortem: b.premortem === true,
    chars: Math.max(0, Number(b.chars) || 0),
    maxCalls,
  }));
}
const clampCalls = (v) => Math.min(MAX_CALLS_LIMIT, Math.max(10, Math.floor(Number(v)) || DEFAULT_MAX_CALLS));

// 대상별 문서 초안: 결론(이미 가려진 글)과 종류만 받아 AI 호출 1회. 결론 밖의 숫자는 프로그램이 다시 찾아 알려 준다.
let draftBusy = false;
async function handleDraft(req, res) {
  let b;
  try { b = JSON.parse((await readBody(req, 100_000)) || '{}'); } catch { return sendJson(res, 400, { error: '잘못된 요청입니다' }); }
  const kind = String(b.kind || '');
  const conclusion = String(b.conclusion || '').trim().slice(0, 12000);
  const id = String(b.provider || '');
  const mode = MODES.includes(b.mode) ? b.mode : 'api';
  if (!drafts.KINDS[kind]) return sendJson(res, 400, { error: '알 수 없는 문서 종류입니다' });
  if (!conclusion) return sendJson(res, 400, { error: '바탕이 될 결론이 없습니다' });
  if (!PROVIDERS[id] || !isConfigured(id, mode)) return sendJson(res, 400, { error: '이 AI 는 지금 쓸 수 없습니다. 연결 설정을 확인하세요' });
  let note = String(b.note || '').slice(0, 300).trim();
  if (note && b.redact?.enabled !== false) note = createRedactor(redactOptions(b.redact && typeof b.redact === 'object' ? b.redact : {})).text(note);
  if (draftBusy) return sendJson(res, 429, { error: '다른 문서 초안을 만드는 중입니다. 끝난 뒤에 다시 눌러 주세요' });
  draftBusy = true;
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  try {
    const text = (await callProvider(id, { mode, model: b.model ? String(b.model).slice(0, 80) : undefined, system: '당신은 한국 기업의 업무 문서를 쓰는 전문가입니다. 주어진 회의 결론만을 근거로 쓰고, 없는 사실을 만들지 않습니다.', prompt: drafts.buildPrompt(kind, conclusion, note), signal: AbortSignal.any([ac.signal, AbortSignal.timeout(180000)]) })).trim();
    return sendJson(res, 200, { kind, label: drafts.KINDS[kind].label, text, check: drafts.checkDraft(text, conclusion) });
  } catch (e) {
    return sendJson(res, 502, { error: setup.scrub(String(e.message || e).slice(0, 300)) });
  } finally { draftBusy = false; }
}

// 연결 확인: 아주 짧은 요청 한 번(유료 API 는 아주 적은 비용). 키나 오류 문구에 키가 섞이면 지워서 돌려준다.
let setupTesting = false;
async function handleSetupTest(req, res) {
  let b;
  try { b = JSON.parse((await readBody(req, 2_000)) || '{}'); } catch { return sendJson(res, 400, { error: '잘못된 요청입니다' }); }
  const id = String(b.provider || '');
  const mode = b.mode === 'cli' ? 'cli' : 'api';
  if (!PROVIDERS[id]) return sendJson(res, 400, { error: '알 수 없는 AI 입니다' });
  if (mode === 'cli' && !PROVIDERS[id].cli) return sendJson(res, 400, { error: '이 AI 는 CLI 방식이 없습니다' });
  if (setupTesting) return sendJson(res, 429, { error: '다른 연결 확인이 진행 중입니다' });
  setupTesting = true;
  const t0 = Date.now();
  try {
    const out = await callProvider(id, { mode, system: '연결 확인용입니다. 짧게 답하세요.', prompt: '연결 확인입니다. OK 라고만 답하세요.', signal: AbortSignal.timeout(60000) });
    return sendJson(res, 200, { ok: true, ms: Date.now() - t0, reply: setup.scrub(String(out).trim().slice(0, 40)) });
  } catch (e) {
    return sendJson(res, 200, { ok: false, ms: Date.now() - t0, error: setup.scrub(String(e.message || e).slice(0, 300)) });
  } finally { setupTesting = false; }
}

// 진행 중인 회의: 사람이 회의 도중에 끼어들거나 "결론 내 달라"고 할 수 있다.
const liveMeetings = new Map(); // id -> { notes: [], cursor, wrap, redactor, emit }
const MAX_NOTES = 10;

async function handleSay(req, res) {
  let b;
  try { b = JSON.parse(await readBody(req, 20_000)); } catch { return sendJson(res, 400, { error: '잘못된 요청입니다' }); }
  const m = liveMeetings.get(String(b.id || ''));
  if (!m) return sendJson(res, 404, { error: '진행 중인 회의가 아닙니다' });
  if (b.wrapUp === true) {
    if (!m.wrap) { m.wrap = true; m.emit({ type: 'wrapup' }); }
    return sendJson(res, 200, { ok: true });
  }
  const raw = String(b.text || '').trim();
  if (!raw) return sendJson(res, 400, { error: '내용을 입력하세요' });
  if (raw.length > 1500) return sendJson(res, 400, { error: '한 번에 1500자까지 말할 수 있습니다' });
  if (m.notes.length >= MAX_NOTES) return sendJson(res, 400, { error: `끼어들기는 회의당 ${MAX_NOTES}번까지입니다` });
  const text = m.redactor ? m.redactor.text(raw) : raw; // 회의가 시작될 때와 같은 가리기 설정을 쓴다
  m.notes.push(text);
  m.emit({ type: 'interject', text });
  return sendJson(res, 200, { ok: true, count: m.notes.length });
}

// 화면에서 온 가리기 설정을 검사해 안전한 값으로 만든다.
function redactOptions(ro) {
  const cats = {};
  for (const k of ['rrn', 'phone', 'email', 'account', 'plate']) if (ro.categories && ro.categories[k] === false) cats[k] = false;
  const names = (Array.isArray(ro.names) ? ro.names : String(ro.names || '').split(/\r?\n/)).slice(0, 200).map((n) => String(n).slice(0, 40));
  return { categories: cats, names };
}

// 미리보기: 이 회의를 시작하면 무엇이 가려져서 나가는지 알려 준다(가린 글 자체는 돌려주지 않고 건수와 몇 개의 예만).
async function handleRedactPreview(req, res) {
  let b;
  try { b = JSON.parse(await readBody(req, 6_000_000)); } catch { return sendJson(res, 400, { error: '잘못된 요청입니다' }); }
  const atts = (Array.isArray(b.attachments) ? b.attachments : []).slice(0, MAX_ATTACH_FILES).map((a) => ({ name: String(a?.name || '').slice(0, 200), text: String(a?.text || '') }));
  if (b.useProfile !== false) { const pa = profile.profileAttachment(); if (pa) atts.unshift(pa); }
  if (b.carryActions === true) { const ca = actions.carryAttachment(minutesDir()); if (ca) atts.unshift({ name: ca.name, text: ca.text }); }
  if (Array.isArray(b.precedents) && b.precedents.length) { const pa = decisions.precedentAttachment(minutesDir(), b.precedents); if (pa) atts.unshift({ name: pa.name, text: pa.text }); }
  const pinned = (Array.isArray(b.pinned) ? b.pinned : []).slice(0, 3).map((h) => ({ question: String(h.question || '').slice(0, 500), conclusion: String(h.conclusion || '').slice(0, 3000) }));
  const rr = redactRequest({ question: String(b.question || '').slice(0, 8000), attachments: atts, history: pinned }, redactOptions(b.redact || {}));
  return sendJson(res, 200, { report: rr.report });
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
    // 참가자 id 는 'gpt' 또는 같은 AI 를 여러 자리에 앉힐 때의 'gpt-2' 형태. 앞부분이 AI 종류다.
    .filter((p, i, a) => /^[a-z]+(-\d{1,2})?$/.test(String(p?.id)) && PROVIDERS[String(p.id).split('-')[0]] && a.findIndex((q) => q.id === p.id) === i)
    .slice(0, MAX_PARTICIPANTS)
    .map((p) => {
      const typed = String(p.model || '').trim().slice(0, 100);
      // CLI 모드에서 모델을 비우면 CLI 자체 기본 모델을 쓴다.
      const role = ROLES[p.role] ? p.role : '';
      const effort = EFFORTS.includes(p.effort) ? p.effort : ''; // '' = 자동(서비스 기본)
      return { id: p.id, provider: p.id.split('-')[0], model: typed, role, effort }; // 비우면 호출 시점에 자동 결정(API: 서비스 목록의 추천, CLI: CLI 기본)
    });
  if (!participants.length) return sendJson(res, 400, { error: '참가할 AI를 한 명 이상 선택하세요' });
  const missing = participants.filter((p) => !isConfigured(p.provider, mode)).filter((p, i, a) => a.findIndex((q) => q.provider === p.provider) === i);
  if (missing.length) {
    const names = missing.map((p) => PROVIDERS[p.provider]);
    const hint = (n) =>
      !n.cli ? `${n.label}(${n.envHint || n.keyEnv} 설정 필요. 이 AI 는 API 방식만 지원)`
      : mode === 'cli' ? `${n.cli.bin} CLI`
      : mode === 'mixed' ? `${n.label}(${n.keyEnv} 또는 ${n.cli.bin} CLI)`
      : n.keyEnv;
    const error =
      mode === 'cli' ? `CLI가 설치되어 있지 않습니다: ${names.map(hint).join(', ')}`
      : mode === 'mixed' ? `API 키도 CLI도 없습니다: ${names.map(hint).join(', ')}`
      : `.env 에 키가 없습니다: ${names.map(hint).join(', ')}`;
    return sendJson(res, 400, { error });
  }

  const consensus = body.consensus === true;
  const unlimited = consensus && body.unlimited === true;
  const maxRounds = unlimited ? UNLIMITED_ROUNDS : Math.min(8, Math.max(2, Number(body.maxRounds) || 5)); // 합의 모드의 상한(비용 보호)
  // 첨부: 브라우저가 글자로 뽑아 보낸다. 개수/용량을 서버에서도 제한한다(모든 AI 호출에 들어가므로 비용 보호).
  const rawAtt = Array.isArray(body.attachments) ? body.attachments : [];
  if (rawAtt.length > MAX_ATTACH_FILES) return sendJson(res, 400, { error: `첨부는 최대 ${MAX_ATTACH_FILES}개까지입니다` });
  const attachments = rawAtt
    .map((a) => ({ name: String(a?.name || '파일').replace(/[\r\n<>]/g, ' ').slice(0, 120), text: String(a?.text || '') }))
    .filter((a) => a.text.trim());
  if (attachments.reduce((n, a) => n + a.text.length, 0) > MAX_ATTACH_CHARS) return sendJson(res, 400, { error: `첨부 내용이 너무 깁니다 (합계 ${MAX_ATTACH_CHARS.toLocaleString()}자 이하)` });

  const rounds = Math.min(3, Math.max(1, Number(body.rounds) || 2));
  const maxCalls = clampCalls(body.maxCalls);
  const minCalls = participants.length + 1 + (body.persona === true ? 1 : 0);
  if (maxCalls < minCalls) return sendJson(res, 400, { error: `호출 상한(${maxCalls}회)이 너무 작습니다. 이 구성은 최소 ${minCalls}회가 필요합니다` });
  if (activeMeetings >= MAX_MEETINGS) return sendJson(res, 429, { error: `이미 회의가 ${activeMeetings}개 진행 중입니다. 끝난 뒤에 시작하세요(동시 최대 ${MAX_MEETINGS}개)` });
  const moderator = participants.some((p) => p.id === body.moderator) ? body.moderator : participants[0].id;
  // 이전 회의: 사용자가 "지난 회의"에서 골라 연결한 것(pinned, 최대 3개)과 이번 화면에서 방금 한 회의(최대 3개)
  const pinned = (Array.isArray(body.pinned) ? body.pinned : [])
    .slice(0, 3)
    .map((h) => ({ question: String(h.question || '').slice(0, 500), conclusion: String(h.conclusion || '').slice(0, 3000) }));
  const recent = (Array.isArray(body.history) ? body.history : [])
    .slice(-3)
    .map((h) => ({ question: String(h.question || '').slice(0, 500), conclusion: String(h.conclusion || '').slice(0, 1500) }));
  const history0 = [...pinned, ...recent];

  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  // 회의록: 이벤트를 받을 때마다 파일에 남기므로 중간에 끊기거나 오류가 나도 그때까지의 기록이 남는다.
  // 회사 정보는 첨부 자료처럼 맨 앞에 들어간다(꺼 둘 수 있다). 용량 검사는 위에서 사용자 첨부에만 적용한다.
  if (body.useProfile !== false) { const pa = profile.profileAttachment(); if (pa) attachments.unshift(pa); }
  // 이전 회의에서 사람이 확정한 미완료 할 일을 이번 회의 자료로 올린다(켠 경우만)
  let carried = 0;
  if (body.carryActions === true) { const ca = actions.carryAttachment(minutesDir()); if (ca) { attachments.unshift({ name: ca.name, text: ca.text }); carried = ca.count; } }
  // 비슷한 과거 결정(사용자가 고른 것): id 로만 받아 저장된 내용을 자료로 올린다
  let precedents = 0;
  if (Array.isArray(body.precedents) && body.precedents.length) { const pa = decisions.precedentAttachment(minutesDir(), body.precedents); if (pa) { attachments.unshift({ name: pa.name, text: pa.text }); precedents = pa.count; } }
  // 개인정보 가리기: AI 로 보내는 질문·첨부·이전 회의에서 전화번호 등을 가명으로 바꾼다(기본 켜짐). 회의록에도 가린 글이 남는다.
  const ro = body.redact && typeof body.redact === 'object' ? body.redact : {};
  let q2 = question, atts = attachments, history = history0, redaction = null, redactor = null;
  if (ro.enabled !== false) {
    const rr = redactRequest({ question, attachments, history: history0 }, redactOptions(ro));
    q2 = rr.question; atts = rr.attachments; history = rr.history; redactor = rr.redactor;
    if (rr.report.total) redaction = { type: 'redaction', total: rr.report.total, counts: rr.report.counts };
  }
  const minutes = body.saveMinutes !== false && process.env.NO_MINUTES !== '1' ? createMinutes({ dir: minutesDir(), question: q2, attachments: atts.map((a) => a.name), mode }) : null;
  const emit = (ev) => {
    minutes?.push(ev);
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(ev)}\n\n`);
  };
  if (redaction) emit(redaction);
  const meetingId = crypto.randomBytes(8).toString('hex');
  const live = { notes: [], cursor: 0, wrap: false, redactor, emit };
  liveMeetings.set(meetingId, live);
  emit({ type: 'meeting', id: meetingId });
  const human = {
    pull: () => { const out = live.notes.slice(live.cursor); live.cursor = live.notes.length; return out; },
    hasNew: () => live.notes.length > live.cursor,
    wrap: () => live.wrap,
  };

  activeMeetings++;
  let status = '완료';
  try {
    await runCouncil({ question: q2, participants, attachments: atts, rounds, consensus, unlimited, maxRounds, maxCalls, moderator, history, mode, persona: body.persona === true, premortem: body.premortem === true, carried, precedents, human, emit, signal: ac.signal });
  } catch (err) {
    status = '오류로 종료';
    emit({ type: 'error', error: String(err.message || err) });
  } finally {
    activeMeetings--;
    liveMeetings.delete(meetingId);
  }
  if (ac.signal.aborted) status = '중단됨';
  const saved = minutes?.finish(status);
  if (saved) emit({ type: 'minutes', path: saved });
  emit({ type: 'done' });
  res.end();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/api/config') return sendJson(res, 200, config());
    if (req.method === 'GET' && url.pathname === '/api/models') return sendJson(res, 200, isMock() ? {} : await listAllModels());
    if (req.method === 'POST' && url.pathname.startsWith('/api/') && !sameOrigin(req)) return sendJson(res, 403, { error: '허용되지 않은 요청 출처입니다' });
    if (req.method === 'GET' && url.pathname === '/api/profile') return sendJson(res, 200, { text: profile.readProfile(), max: profile.MAX_SAVE });
    if (req.method === 'POST' && url.pathname === '/api/profile') {
      try { const { text } = JSON.parse((await readBody(req, 100_000)) || '{}'); return sendJson(res, 200, { text: profile.writeProfile(text) }); }
      catch (e) { return sendJson(res, 400, { error: String(e.message || e) }); }
    }
    if (req.method === 'GET' && url.pathname === '/api/setup') {
      const names = setup.keyNames();
      return sendJson(res, 200, {
        mock: isMock(),
        envFile: setup.envFile(),
        checks: setup.checks({ minutesDir: minutesDir(), profileFile: process.env.PROFILE_FILE || path.join(appDir(), '회사정보.md') }),
        providers: Object.entries(PROVIDERS).filter(([id]) => names[id] || PROVIDERS[id].keyless || PROVIDERS[id].cli).map(([id, p]) => ({
          id, label: p.label, vendor: p.vendor, keyEnv: names[id] || null, canSetKey: Boolean(names[id]),
          apiConfigured: hasApiKey(id), cliSupported: Boolean(p.cli), cliAvailable: cliAvailable(id), extra: Boolean(p.compat),
        })),
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/setup/key') {
      try {
        const b = JSON.parse((await readBody(req, 5_000)) || '{}');
        setup.setKey(String(b.provider || ''), b.remove === true ? null : b.key);
        return sendJson(res, 200, { ok: true, apiConfigured: hasApiKey(String(b.provider)) });
      } catch (e) { return sendJson(res, 400, { error: setup.scrub(e.message || e) }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/draft') return await handleDraft(req, res);
    if (req.method === 'POST' && url.pathname === '/api/setup/test') return await handleSetupTest(req, res);
    if (req.method === 'GET' && url.pathname === '/api/usage') {
      const days = Math.min(3650, Math.max(0, Math.floor(Number(url.searchParams.get('days'))) || 0));
      return sendJson(res, 200, { ...usageStats.summarize(minutesDir(), { days }), labels: Object.fromEntries(Object.entries(PROVIDERS).map(([id, p]) => [id, p.label])) });
    }
    if (req.method === 'GET' && url.pathname === '/api/decisions') return sendJson(res, 200, { items: decisions.load(minutesDir()), due: decisions.due(minutesDir()).map((x) => x.id) });
    if (req.method === 'POST' && url.pathname.startsWith('/api/decisions/')) {
      try {
        const b = JSON.parse((await readBody(req, 60_000)) || '{}');
        const act = url.pathname.slice('/api/decisions/'.length);
        if (act === 'add') return sendJson(res, 200, { item: decisions.add(minutesDir(), b) });
        if (act === 'update') return sendJson(res, 200, { item: decisions.update(minutesDir(), String(b.id || ''), b.patch) });
        if (act === 'delete') { decisions.remove(minutesDir(), String(b.id || '')); return sendJson(res, 200, { ok: true }); }
        if (act === 'similar') return sendJson(res, 200, { items: decisions.similar(minutesDir(), String(b.question || '').slice(0, 4000)).map(({ id, title, summary, outcome, result, created, score }) => ({ id, title, summary, outcome, result, created, score })) });
        return sendJson(res, 404, { error: '없는 요청입니다' });
      } catch (e) { return sendJson(res, 400, { error: String(e.message || e) }); }
    }
    if (req.method === 'GET' && url.pathname === '/api/actions') return sendJson(res, 200, { items: actions.load(minutesDir()) });
    if (req.method === 'POST' && url.pathname.startsWith('/api/actions/')) {
      try {
        const b = JSON.parse((await readBody(req, 60_000)) || '{}');
        const act = url.pathname.slice('/api/actions/'.length);
        if (act === 'add') return sendJson(res, 200, actions.add(minutesDir(), b.meeting, b.items));
        if (act === 'update') return sendJson(res, 200, { item: actions.update(minutesDir(), String(b.id || ''), b.patch) });
        if (act === 'delete') { actions.remove(minutesDir(), String(b.id || '')); return sendJson(res, 200, { ok: true }); }
        return sendJson(res, 404, { error: '없는 요청입니다' });
      } catch (e) { return sendJson(res, 400, { error: String(e.message || e) }); }
    }
    if (req.method === 'GET' && url.pathname === '/api/backup') {
      const { buffer, meta } = backup.build({ minutesDir: minutesDir(), profileText: profile.readProfile() });
      const d = new Date();
      const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
      res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="ai-council-backup-${stamp}.zip"`, 'x-backup-minutes': String(meta.minutes), 'x-backup-profile': meta.profile ? '1' : '0' });
      return res.end(buffer);
    }
    if (req.method === 'POST' && url.pathname === '/api/backup/restore') {
      try { return sendJson(res, 200, backup.restore(await readRaw(req, 100 * 1024 * 1024), { minutesDir: minutesDir(), readProfile: profile.readProfile, writeProfile: profile.writeProfile })); }
      catch (e) { return sendJson(res, 400, { error: String(e.message || e) }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/redact/preview') return await handleRedactPreview(req, res);
    if (req.method === 'GET' && url.pathname === '/api/minutes') return sendJson(res, 200, { items: listMinutes(minutesDir(), { q: String(url.searchParams.get('q') || '').slice(0, 100) }) });
    if (req.method === 'GET' && url.pathname === '/api/minutes/item') {
      const it = readMinutes(minutesDir(), String(url.searchParams.get('id') || '').slice(0, 200));
      return it ? sendJson(res, 200, it) : sendJson(res, 404, { error: '회의록을 찾을 수 없습니다' });
    }
    if (req.method === 'POST' && url.pathname === '/api/council/say') return await handleSay(req, res);
    if (req.method === 'POST' && url.pathname === '/api/council') return await handleCouncil(req, res);
    if (req.method === 'POST' && url.pathname === '/api/estimate') return await handleEstimate(req, res);
    if (req.method === 'POST' && url.pathname.startsWith('/api/xlsx/')) return await handleXlsx(req, res, url);
    if (req.method === 'POST' && url.pathname === '/api/folder/scan') return await handleFolder(req, res, 'scan');
    if (req.method === 'POST' && url.pathname === '/api/folder/save') return await handleFolder(req, res, 'save');

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
