// 회사 정보: 실행파일 옆 '회사정보.md' 한 개. 모든 회의에 "첨부 자료"처럼 자동으로 들어가
// AI 가 우리 회사 사정(사업, 조직, KPI 산식)을 알고 답하게 한다. 메모장으로 직접 고쳐도 된다.
const fs = require('fs');
const path = require('path');
const { appDir } = require('./env');

const MAX_SAVE = 20000; // 파일 저장 상한(글자)
const MAX_USE = 8000; // 회의 한 번에 AI 에 보내는 상한(글자). 모든 호출에 들어가므로 비용을 막는다.
const file = () => process.env.PROFILE_FILE || path.join(appDir(), '회사정보.md');

function readProfile() {
  try { return fs.readFileSync(file(), 'utf8'); } catch { return ''; }
}
function writeProfile(text) {
  const t = String(text ?? '').replace(/\r\n/g, '\n');
  if (t.length > MAX_SAVE) throw new Error(`회사 정보가 너무 깁니다 (${MAX_SAVE.toLocaleString()}자 이하)`);
  if (!t.trim()) { try { fs.unlinkSync(file()); } catch {} return ''; }
  fs.writeFileSync(file(), t, 'utf8');
  return t;
}
// 회의에 넣을 첨부 항목(없으면 null)
function profileAttachment() {
  const t = readProfile().trim();
  if (!t) return null;
  return { name: '회사 정보', text: t.length > MAX_USE ? t.slice(0, MAX_USE) + '\n…(이하 생략)' : t };
}

const TEMPLATE = `# 회사 정보
(아래 괄호 부분을 우리 회사에 맞게 고쳐 주세요. 모르는 것은 비워 두세요. AI 는 여기에 없는 내용을 지어내지 않습니다.)

## 사업
- 업종: 물류·운송 (화물 배차·운송, 택배 배송 현장 운영, 신규 물류사업)
- 주요 거래처: (입력)
- 차량·인력 구조: 고정차량 / 용차 / 위수탁 차주 (입력)

## 조직
- (팀 이름과 인원, 하는 일을 입력)

## 핵심 지표(KPI) 정의 — 산식과 목표 수치는 직접 적어 주세요
- 고정차량 완편율 = 실제 투입 고정차량 수 ÷ 필요 고정차량 수 × 100 (목표: )
- 긴급배차 평균 대응시간 = 긴급배차 요청부터 배차 완료까지 총 소요시간 ÷ 긴급배차 건수 (목표: )
- 협력사 배차 이행률 = 배차 완료 건수 ÷ 요청 건수 × 100 (목표: )
- 정산 정확도 = 오류 없는 정산 건수 ÷ 전체 정산 건수 × 100 / 정산 마감 준수율 (목표: )
- 운송 CS 발생률 = 운송 CS 건수 ÷ 전체 배송 완료 건수 × 100 (목표: )
- 배송완료율, 미배송률, 소분·적재 오류율, 사고·파손·분실 재발률, 공헌이익률 (산식·목표: )

## 회의 원칙
- (예: 안전이 비용보다 우선, 거래처와 약속한 시간은 우선 지킨다 등)
`;

module.exports = { readProfile, writeProfile, profileAttachment, TEMPLATE, MAX_SAVE, MAX_USE };
