// 사용량 요약: 저장된 회의록(.jsonl)의 usage 이벤트를 모아 호출 수와 글자 수를 AI 별로 보여 준다.
// 정확한 것: 호출 수, 보낸·받은 글자 수(회의 중 모든 AI 호출의 합). 추정인 것: 토큰(글자 수로 어림), 비용(사용자가 넣은 단가로 계산).
// 프로그램은 AI 서비스의 가격을 알지 못한다(자주 바뀐다). 문서 초안·연결 확인 호출은 회의 밖이라 들어 있지 않다.
const fs = require('fs');
const path = require('path');

const MAX_FILES = 600;
const MAX_READ = 3 * 1024 * 1024;

function readMeeting(file, id) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  if (!st.isFile() || st.size > MAX_READ) return null;
  let meta = null, start = null, usage = null, final = null, end = null;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === 'meta') meta = ev;
    else if (ev.type === 'start') start = ev;
    else if (ev.type === 'usage') usage = ev;
    else if (ev.type === 'final') final = ev;
    else if (ev.type === 'end') end = ev;
  }
  if (!meta) return null;
  const detail = usage?.detail && typeof usage.detail === 'object' ? usage.detail : null;
  const q = String(meta.question || '');
  const m = /^\[안건:\s*([^\]\n]+)\]/.exec(q);
  return {
    id,
    startedAt: meta.startedAt || st.mtime.toISOString(),
    title: (m ? m[1] : q.split('\n')[0]).slice(0, 60),
    mode: meta.mode || '',
    status: end?.status || '기록 중단',
    calls: Number(usage?.calls) || 0,
    maxCalls: usage?.maxCalls ?? null,
    rounds: start?.rounds ?? null,
    participants: (start?.participants || []).length,
    reached: final?.consensus ? Boolean(final.consensus.reached) : null,
    hasDetail: Boolean(detail),
    detail: detail || {},
  };
}

// days: 최근 며칠(0 이면 전체)
function summarize(dir, { days = 30, now = Date.now() } = {}) {
  let names;
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')).sort().reverse(); } catch { names = []; }
  const since = days > 0 ? now - days * 86400000 : 0;
  const meetings = [];
  for (const n of names.slice(0, MAX_FILES)) {
    const m = readMeeting(path.join(dir, n), n.slice(0, -6));
    if (!m) continue;
    if (Date.parse(m.startedAt) < since) continue;
    meetings.push(m);
  }
  const byProvider = {};
  const totals = { meetings: meetings.length, calls: 0, withDetail: 0, apiCalls: 0, cliCalls: 0, inChars: 0, outChars: 0 };
  for (const m of meetings) {
    totals.calls += m.calls;
    if (m.hasDetail) totals.withDetail++;
    for (const [id, d] of Object.entries(m.detail)) {
      const via = d.via === 'cli' ? 'cli' : 'api';
      const key = `${id}|${via}`;
      const b = (byProvider[key] ||= { provider: id, via, calls: 0, inChars: 0, outChars: 0 });
      const c = Number(d.calls) || 0, i = Number(d.inChars) || 0, o = Number(d.outChars) || 0;
      b.calls += c; b.inChars += i; b.outChars += o;
      totals.inChars += i; totals.outChars += o;
      if (via === 'cli') totals.cliCalls += c; else totals.apiCalls += c;
    }
  }
  return { days, totals, byProvider: Object.values(byProvider).sort((a, b) => b.calls - a.calls), meetings: meetings.slice(0, 200) };
}

module.exports = { summarize, readMeeting };
