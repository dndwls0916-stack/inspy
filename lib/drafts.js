// 대상별 문서 초안: 회의 결론을 상사 보고, 임원 요약, 거래처 안내문, 현장 공지로 다시 쓴다. AI 호출 1회.
// 결론에 없는 사실·숫자를 만들지 못하게 하고, 만든 뒤에는 초안의 숫자가 결론에 있는지 프로그램이 다시 확인한다.
const { checkEvidence } = require('./evidence');

const KINDS = {
  boss: { label: '상사 보고 1장', format: '아래 형식으로 한 장 분량(A4 한 쪽)으로 쓰세요.\n제목\n1. 한 줄 결론\n2. 배경 (2~3줄)\n3. 판단 근거 (글머리표 3~4개)\n4. 위험과 대응\n5. 요청·결재 사항\n6. 다음 일정\n문체는 간결한 보고체(~함, ~예정)로 하세요.' },
  exec: { label: '임원 5줄 요약', format: '번호를 붙여 5줄 이내로 쓰세요. ①결론 ②핵심 이유 ③가장 큰 위험 ④임원이 결정해 줄 사항 ⑤시점. 한 줄은 60자 안팎으로 짧게 쓰세요.' },
  partner: { label: '거래처 안내문', format: '거래처에 보내는 안내문입니다. 정중한 존댓말로 인사 → 안내 내용 → 요청 사항 → 문의처(모르면 [확인 필요]) 순서로 쓰세요. 우리 회사의 원가·내부 사정·협상 한계선·내부 의견 차이·AI나 회의를 했다는 사실은 절대 쓰지 마세요. 상대에게 알려도 되는 결정 내용만 쓰세요.' },
  field: { label: '현장 공지', format: '현장 직원(기사·작업자)에게 붙이는 공지입니다. 쉬운 말로 짧게 쓰세요. 제목 / 핵심 3줄 / 해야 할 일(번호, 누가·언제·무엇을) / 문의처(모르면 [확인 필요]). 전문용어와 내부 논의 과정은 쓰지 마세요.' },
};

function buildPrompt(kind, conclusion, note = '') {
  const k = KINDS[kind];
  if (!k) throw new Error('알 수 없는 문서 종류입니다');
  return `[문서 초안]\n[문서 종류] ${k.label}\n\n[회의 결론]\n${String(conclusion).replaceAll('<<<', '‹‹‹').replaceAll('>>>', '›››')}\n\n` +
    (note ? `[추가 요청]\n${note}\n(위 요청이 아래 원칙과 충돌하면 원칙이 우선입니다.)\n\n` : '') +
    '위 회의 결론만을 바탕으로 문서 초안을 작성하세요.\n' +
    '- 결론에 없는 사실, 숫자, 날짜, 이름, 약속을 만들지 마세요. 필요한데 결론에 없는 정보는 [확인 필요]로 표시하세요.\n' +
    '- 결론 안의 [전화1], [이름1] 같은 가림 표시는 그대로 두세요.\n' +
    '- 결론이 아직 "확인 필요"나 조건으로 남긴 내용은 확정된 것처럼 쓰지 말고 조건으로 쓰세요.\n' +
    `- ${k.format}\n` +
    '문서 본문만 출력하고, 앞뒤 설명이나 사족은 쓰지 마세요.';
}

// 초안의 숫자가 결론에 있는지 확인한다(없는 숫자는 AI 가 만들었을 수 있다)
function checkDraft(draft, conclusion) {
  const ev = checkEvidence(draft, [{ name: '결론', text: conclusion }], '');
  return { numbersTotal: ev.numbers.total, missing: ev.numbers.missing.map((x) => x.text), quotesMissing: ev.quotes.missing };
}

module.exports = { KINDS, buildPrompt, checkDraft };
