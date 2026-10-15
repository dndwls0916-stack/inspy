// 회의 진행 로직: 라운드별로 AI들이 의견을 내고, 사회자가 결론을 정리한다.
const { PROVIDERS, callProvider } = require('./providers');
const { PERSONAS, SAGE, STYLE_RULE } = require('./personas');

const SYSTEM = (label, others, persona = null) =>
  (persona ? `${STYLE_RULE}${persona.style}\n` : '') +
  `당신은 ${label}입니다. 지금은 ${others.length ? others.join(', ') + '와(과) 함께' : '혼자'} 사용자의 질문을 놓고 하는 회의에 참석 중입니다. ` +
  '한국어로 답하세요. 군더더기 없이 핵심 위주로, 근거와 함께 말하세요. ' +
  '모르는 것은 아는 척하지 말고, 동의하지 않으면 정중하지만 분명하게 반박하세요.';

function historyBlock(history) {
  if (!history?.length) return '';
  const lines = history.slice(-3).map((h, i) => `${i + 1}. 질문: ${h.question}\n   당시 결론: ${h.conclusion}`);
  return `[이전 회의 맥락]\n${lines.join('\n')}\n\n`;
}

function transcriptOf(rounds, labelOf, upto) {
  return rounds
    .slice(0, upto)
    .map((turns, r) => `--- ${r + 1}라운드 ---\n` + turns.map((t) => `[${labelOf(t.who)}]\n${t.text}`).join('\n\n'))
    .join('\n\n');
}

/**
 * @param {object} p
 * @param {string} p.question
 * @param {{id:string, model:string}[]} p.participants
 * @param {number} p.rounds 1~3
 * @param {string} p.moderator participant id
 * @param {object[]} p.history
 * @param {(event:object)=>void} p.emit
 * @param {AbortSignal} p.signal
 */
async function runCouncil({ question, participants, rounds, moderator, history, mode = 'api', persona = false, emit, signal }) {
  const labelOf = (id) => PROVIDERS[id].label;
  const modelOf = Object.fromEntries(participants.map((p) => [p.id, p.model]));
  const ids = participants.map((p) => p.id);
  const ctx = historyBlock(history);
  const transcript = []; // transcript[r] = [{who, text}]
  const failed = new Set();

  emit({ type: 'start', mode, persona, participants: participants.map((p) => ({ id: p.id, label: labelOf(p.id), model: p.model })), rounds, moderator });

  for (let r = 1; r <= rounds; r++) {
    if (signal.aborted) return;
    const active = ids.filter((id) => !failed.has(id));
    if (!active.length) break;
    emit({ type: 'round', round: r, total: rounds });

    const turns = [];
    transcript.push(turns);

    await Promise.all(
      active.map(async (id) => {
        const others = active.filter((o) => o !== id).map(labelOf);
        let prompt;
        if (r === 1) {
          prompt =
            `${ctx}[질문]\n${question}\n\n` +
            '당신의 독립적인 의견을 말하세요. 형식: 핵심 주장 1~2문장, 이어서 근거/제안을 글머리표 3~5개. 400자~700자 내외.';
        } else {
          prompt =
            `${ctx}[질문]\n${question}\n\n[지금까지의 회의록]\n${transcriptOf(transcript, labelOf, r - 1)}\n\n` +
            `이제 ${r}라운드입니다. 다른 참가자의 의견을 읽고 (1) 동의하는 점 (2) 반박하거나 보완할 점 (3) 당신의 수정된 입장을 말하세요. ` +
            '이미 한 말을 반복하지 마세요. 400자~700자 내외.';
        }
        emit({ type: 'thinking', round: r, who: id });
        try {
          const text = (await callProvider(id, { mode, model: modelOf[id], system: SYSTEM(labelOf(id), others, persona ? PERSONAS[id] : null), prompt, signal })).trim();
          turns.push({ who: id, text });
          emit({ type: 'turn', round: r, who: id, label: labelOf(id), text });
        } catch (err) {
          if (signal.aborted) return;
          failed.add(id);
          emit({ type: 'turn_error', round: r, who: id, label: labelOf(id), error: String(err.message || err) });
        }
      }),
    );
  }

  if (signal.aborted) return;
  const spoke = transcript.flat();
  if (!spoke.length) {
    emit({ type: 'error', error: '모든 AI 호출이 실패했습니다. API 키와 모델명을 확인하세요.' });
    return;
  }

  // 사회자: 지정한 AI가 우선, 실패하면 다른 AI가 대신한다.
  const order = [moderator, ...ids.filter((i) => i !== moderator)].filter((i) => !failed.has(i) || i === moderator);
  const finalPrompt =
    `[최종 결론 작성]\n${ctx}[질문]\n${question}\n\n[회의록]\n${transcriptOf(transcript, labelOf, transcript.length)}\n\n` +
    '당신은 이 회의의 사회자입니다. 특정 참가자(자신 포함)를 편들지 말고 회의 내용을 종합해 아래 형식으로 작성하세요.\n' +
    '## 결론\n(질문에 대한 직접적인 답, 3~5문장)\n## 합의된 점\n(글머리표)\n## 의견이 갈린 점\n(누가 어떤 입장이었는지, 글머리표. 없으면 "없음")\n## 추천 다음 단계\n(번호 목록)';
  // 삼국지 모드: 결단 뒤에 군사 제갈량이 한마디 올린다. 실패해도 회의 결과에는 영향이 없다.
  async function sageSays({ id, text }) {
    if (signal.aborted) return;
    emit({ type: 'thinking', round: 'sage', who: 'sage' });
    const prompt =
      `[군사의 한마디]\n[질문]\n${question}\n\n[회의의 최종 결단]\n${text}\n\n` +
      '당신은 군사 제갈량입니다. 세 형제의 군의 결과를 듣고, 마지막으로 짧은 한마디를 올리세요. 결단의 내용을 뒤집거나 새로운 사실을 지어내지 말고, 아래 형식을 정확히 지키세요.\n' +
      '**한 줄 요약:** (30자 안팎)\n**군사의 책략:** (제갈량 말투로 1~2문장. 핵심 조언과 경계할 점 하나)\n**오늘의 첫 수:** (지금 당장 할 수 있는 구체적 행동 하나)';
    try {
      const out = (await callProvider(id, { mode, model: modelOf[id], system: SYSTEM(SAGE.name, [], SAGE), prompt, signal })).trim();
      emit({ type: 'sage', by: id, label: labelOf(id), text: out });
    } catch (err) {
      if (!signal.aborted) emit({ type: 'sage_error', error: String(err.message || err) });
    }
  }

  emit({ type: 'thinking', round: 'final', who: order[0] });
  for (const id of order) {
    try {
      const text = (await callProvider(id, { mode, model: modelOf[id], system: SYSTEM(labelOf(id), []), prompt: finalPrompt, signal })).trim();
      emit({ type: 'final', who: id, label: labelOf(id), text });
      if (persona) await sageSays({ id, text });
      return;
    } catch (err) {
      if (signal.aborted) return;
      emit({ type: 'turn_error', round: 'final', who: id, label: labelOf(id), error: String(err.message || err) });
    }
  }
  emit({ type: 'error', error: '결론 작성에 실패했습니다.' });
}

module.exports = { runCouncil };
