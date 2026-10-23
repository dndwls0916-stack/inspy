// 회의를 시작하기 전에 AI 호출 수와 토큰 사용량을 대략 알려 준다. (council.js 의 호출 구조와 같은 식)
// 호출 수는 정확한 계산이고, 토큰은 글자 수 기반의 거친 추정이다. 자동 모델 대체/재시도, 생각(thinking) 토큰은 반영하지 못한다.
const UNLIMITED_ROUNDS = 30;

// 라운드 시작 전 예산 검사에 쓰는 예약분(council.js 와 같은 값을 쓴다). 결론/판정이 실패해 다른 참가자가 대신할 몫을 한 번 더 남긴다.
const reserveFinal = (n, persona) => 1 + (n > 1 ? 1 : 0) + (persona ? 1 : 0);
const reserveJudge = (n) => 1 + (n > 1 ? 1 : 0);

// council.js 의 진행(라운드 시작 때 예산 검사 → 발언 → 판정 → 최종안 확인 → 결론)을 그대로 따라가 호출 수와 토큰을 센다.
// scenario: 'min' = 2라운드에 합의되고 확인도 통과 / 'max' = 매 라운드 판정은 합의, 확인에서 보류
function simulate({ n, rounds, consensus, limit, persona, chars, maxCalls }, scenario) {
  const base = Math.ceil(chars / 2) + 800;
  const per = (r) => base + Math.max(0, r - 1) * n * 350;
  let calls = 0, tokens = 0, ran = 0;
  for (let r = 1; r <= limit; r++) {
    const need = n + reserveFinal(n, persona) + (consensus && r >= 2 ? reserveJudge(n) + n : 0);
    if (r > 1 && calls + need > maxCalls) break;
    ran = r;
    calls += n; tokens += n * per(r);
    if (consensus && r >= 2) {
      calls += 1; tokens += 800 + r * n * 350; // 판정(첨부 없음)
      calls += n; tokens += n * (base + 350); // 최종안 확인
      if (scenario === 'min') break;
    }
  }
  calls += 1 + (persona ? 1 : 0); tokens += per(Math.max(1, ran)) * (1 + (persona ? 1 : 0)); // 결론(+제갈량)
  return { calls, tokens, ran };
}

function estimate({ n, rounds = 2, consensus = false, unlimited = false, maxRounds = 5, persona = false, chars = 0, maxCalls = Infinity }) {
  n = Math.max(1, Math.floor(n) || 1);
  const limit = !consensus ? rounds : n < 2 ? 1 : unlimited ? UNLIMITED_ROUNDS : maxRounds;
  const args = { n, rounds, consensus: consensus && n >= 2, limit, persona, chars, maxCalls };
  const lo = simulate(args, 'min');
  const hi = simulate(args, 'max');
  const uncapped = simulate({ ...args, maxCalls: Infinity }, 'max');
  const min = Math.min(lo.calls, hi.calls);
  return {
    calls: { min, max: hi.calls, uncapped: uncapped.calls, capped: uncapped.calls > hi.calls },
    rounds: limit,
    inputTokens: { min: Math.round(Math.min(lo.tokens, hi.tokens)), max: Math.round(hi.tokens) },
    outputTokens: { min: min * 500, max: hi.calls * 500 },
    approx: true,
  };
}

module.exports = { estimate, UNLIMITED_ROUNDS, reserveFinal, reserveJudge };
