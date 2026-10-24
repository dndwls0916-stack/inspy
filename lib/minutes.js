// 회의록 자동 저장: 이벤트를 JSONL 로 한 줄씩 남기고(중단·오류에도 남도록), 끝나면 읽기 좋은 Markdown 으로 만든다.
// 첨부 파일의 내용은 저장하지 않고 이름만 적는다. 기존 파일은 덮어쓰지 않는다.
const fs = require('fs');
const path = require('path');

const KEEP = new Set(['start', 'round', 'turn', 'turn_error', 'consensus', 'ratify', 'final', 'sage', 'sage_error', 'budget', 'usage', 'error']);
const VOTE = { agree: '동의', conditional: '조건부', disagree: '반대', unknown: '확인 못함' };

// 안건 양식으로 보낸 질문은 "[안건: 이름]" 으로 시작한다. 파일 이름과 제목에는 그 이름을 쓴다.
const titleOf = (q) => { const m = /^\[안건:\s*([^\]\n]+)\]/.exec(String(q || '')); return m ? m[1] : String(q || '').split('\n')[0]; };
const safeName = (s) => String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\.{2,}/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+|[. ]+$/g, '').slice(0, 40) || '회의';
const pad = (n) => String(n).padStart(2, '0');
const stampOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const who = (ev) => `${ev.label}${ev.roleName ? ` · ${ev.roleName}` : ''}`;

function renderMinutes(events, { question, status, startedAt = new Date(), attachments = [], mode = '' }) {
  const start = events.find((e) => e.type === 'start');
  const out = [];
  out.push(`# 회의록: ${titleOf(question).slice(0, 60)}`, '');
  out.push(`- 일시: ${startedAt.toLocaleString('ko-KR')}`, `- 상태: ${status}`);
  if (mode) out.push(`- 실행 방식: ${mode.toUpperCase()}`);
  if (start) {
    out.push(`- 라운드: ${start.consensus ? (start.unlimited ? '합의/결론 날 때까지(제한 없음)' : `합의까지(최대 ${start.maxRounds})`) : `${start.rounds}`}`);
    out.push('', '## 참가자', '', '| 이름 | 역할 | 모델 | 생각 깊이 | 방식 |', '|---|---|---|---|---|');
    for (const p of start.participants) out.push(`| ${p.label} | ${p.roleName || '-'} | ${p.model || '자동'} | ${p.effort || '자동'} | ${p.via} |`);
  }
  if (attachments.length) out.push('', `- 첨부(이름만 기록, 파일 내용은 저장하지 않음. 단 AI 답변이 인용한 부분은 본문에 남을 수 있음): ${attachments.join(', ')}`);
  out.push('', '## 질문', '', ...String(question).split('\n').map((l) => `> ${l}`), '');
  let hasFinal = false;
  for (const ev of events) {
    if (ev.type === 'round') out.push(`## ${ev.round}라운드`, '');
    else if (ev.type === 'turn') out.push(`### ${who(ev)}${ev.model ? ` _(${ev.model})_` : ''}`, '', ev.text, '');
    else if (ev.type === 'turn_error') out.push(`### ${who(ev)} — 오류`, '', `호출에 실패했습니다: ${ev.error}`, '');
    else if (ev.type === 'consensus') {
      out.push(`### 합의 판정 (${ev.round}라운드) — ${ev.pendingRatify ? '합의 후보' : ev.reached ? '합의' : '쟁점 남음'}`, '', ev.summary || '');
      if (ev.disagreements?.length) out.push('', '남은 쟁점:', ...ev.disagreements.map((d) => `- ${d}`));
      if (ev.contradiction) out.push('', '_판정이 합의라고 했지만 남은 쟁점이 있어 합의로 인정하지 않았습니다._');
      out.push('');
    } else if (ev.type === 'ratify') {
      out.push(`### 최종안 확인 (${ev.round}라운드) — ${ev.reached ? (ev.missing?.length ? '응답자 전원 동의' : '전원 동의') : '합의 보류'}`, '', ev.summary || '', '');
      for (const v of ev.votes) out.push(`- **${VOTE[v.vote] || v.vote}** ${who({ label: v.label, roleName: v.roleName })}${v.vote === 'agree' ? '' : ` — ${v.condition || v.reason || ''}`}`);
      if (ev.missing?.length) out.push('', `_호출에 실패한 참가자의 입장은 확인되지 않았습니다: ${ev.missing.join(', ')}_`);
      out.push('');
    } else if (ev.type === 'budget') out.push(`> ⚠️ ${ev.message}`, '');
    else if (ev.type === 'final') {
      hasFinal = true;
      const c = ev.consensus;
      out.push('## 최종 결론', '', `_정리: ${ev.label}${c ? ` · ${c.reached ? (c.partial ? '응답자 합의' : '합의') : '합의 못함'}${c.reason ? ` (${c.reason})` : ''}` : ''}${ev.missing?.length ? ` · 불참: ${ev.missing.join(', ')}` : ''}_`, '', ev.text, '');
    } else if (ev.type === 'sage') out.push(`## ${ev.label} 의 한마디`, '', ev.text, '');
    else if (ev.type === 'usage') out.push(`> AI 호출 ${ev.calls}회${ev.maxCalls ? ` / 상한 ${ev.maxCalls}회` : ''}`, '');
    else if (ev.type === 'error') out.push(`> ❌ 오류: ${ev.error}`, '');
  }
  if (!hasFinal) out.push('## 최종 결론', '', `_${status === '완료' ? '결론이 만들어지지 않았습니다.' : `회의가 ${status === '중단됨' ? '중단되어' : `${status}되어`} 최종 결론이 없습니다. 위는 그때까지의 기록입니다.`}_`, '');
  return out.join('\n');
}

function createMinutes({ dir, question, attachments = [], mode = '' }) {
  const events = [];
  const startedAt = new Date();
  let base = null;
  let jsonl = null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (let n = 1; n < 100 && !base; n++) {
      const b = path.join(dir, `${stampOf(startedAt)}_${safeName(titleOf(question))}${n > 1 ? `-${n}` : ''}`);
      try {
        fs.writeFileSync(`${b}.jsonl`, '', { flag: 'wx' });
        base = b;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
    }
    jsonl = base ? `${base}.jsonl` : null;
    // 프로세스가 갑자기 꺼져도 어떤 회의였는지 알 수 있도록 질문과 설정을 맨 앞줄에 남긴다. (첨부는 이름만)
    if (jsonl) fs.appendFileSync(jsonl, JSON.stringify({ type: 'meta', question, startedAt: startedAt.toISOString(), mode, attachments }) + '\n');
  } catch {
    jsonl = null; // 저장할 수 없어도 회의는 계속한다
  }
  return {
    push(ev) {
      if (!KEEP.has(ev.type)) return;
      events.push(ev);
      if (jsonl) try { fs.appendFileSync(jsonl, JSON.stringify(ev) + '\n'); } catch {}
    },
    finish(status) {
      if (!jsonl) return null;
      try { fs.appendFileSync(jsonl, JSON.stringify({ type: 'end', status, at: new Date().toISOString() }) + '\n'); } catch {}
      try {
        const file = `${base}.md`;
        fs.writeFileSync(file, renderMinutes(events, { question, status, startedAt, attachments, mode }), { flag: 'wx' });
        return file;
      } catch {
        return jsonl;
      }
    },
  };
}

module.exports = { createMinutes, renderMinutes };
