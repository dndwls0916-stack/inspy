# AI 회의실

질문을 올리면 **GPT · Gemini · Claude**가 라운드별로 의견을 내고 서로 반박한 뒤, 사회자 AI가 **최종 결론**을 정리해 보여주는 로컬 웹 프로그램입니다. 설치할 패키지가 없습니다 (Node.js 18+ 만 필요).

> 📖 **처음이라면 [사용 설명서(docs/guide.html)](docs/guide.html)를 먼저 보세요.** 실행파일 실행, API 키 발급, 문제 해결까지 단계별로 안내합니다. (내려받아 브라우저로 열면 됩니다)

## 실행 방식 두 가지

| | API 키 | CLI 로그인 |
|---|---|---|
| 준비 | `.env` 에 API 키 입력 | `claude` / `codex` / `gemini` CLI 설치 + 로그인 |
| 비용 | API 사용량 과금 | 각 구독/계정 한도 |
| 속도·안정성 | 빠름, 모델 지정 쉬움 | 호출마다 프로세스 실행이라 느림 |
| 시작 | `npm run start:api` | `npm run start:cli` |

**혼합 방식**: AI마다 *API 키가 있으면 API, 없으면 CLI* 를 자동 선택합니다. (예: Claude·GPT 는 CLI 로그인, Gemini 는 무료 API 키) 시작 방식을 지정하지 않으면 키와 CLI 가 모두 있을 때 혼합으로 시작합니다. `npm run start:mixed` 로도 시작할 수 있습니다.

> ⚠️ Gemini CLI 의 개인 구글 계정 로그인("Sign in with Google")은 Google 정책 변경으로 막힌 경우가 있습니다(`This client is no longer supported for Gemini Code Assist for individuals`). Gemini 는 API 키(aistudio.google.com, 무료 사용량 있음)로 쓰고 혼합 방식을 사용하세요.

`npm start` 는 기본 방식(API)으로 시작하고, **어느 쪽으로 시작하든 화면 왼쪽의 "실행 방식"에서 바꿀 수 있습니다.**
(기본 방식은 `MODE=api|cli|mixed` 환경변수로도 지정할 수 있고, 방식은 회의 단위로 하나를 선택합니다.)

```bash
cp .env.example .env     # API 방식: 사용할 AI의 키만 채우세요 (키가 있는 AI만 참가)
npm start                # http://localhost:3000
npm run start:cli        # CLI 방식으로 시작
npm run demo             # 키/CLI 없이 화면만 확인 (가짜 응답)
```

CLI 방식 참고:
- CLI는 서버가 임시 폴더에서 실행하며, 프롬프트는 stdin 으로 전달합니다. (셸을 거치지 않음)
- 모델 입력칸을 비우면 각 CLI의 기본 모델을 씁니다.
- CLI 경로가 다르면 `CLAUDE_BIN`, `CODEX_BIN`, `GEMINI_BIN` 으로 지정하세요.
- Windows 에서 npm 으로 설치한 `.cmd` CLI 도 자동으로 찾아 실행합니다. 인자는 허용 문자(영문/숫자/`. _ : / -`)만 통과시키며 프롬프트는 stdin 으로만 전달합니다. (실제 Windows 에서는 아직 검증하지 못한 기능입니다.)
- 설치·로그인: `npm i -g @anthropic-ai/claude-code @openai/codex @google/gemini-cli` 후 각각 `claude`, `codex`, `gemini` 를 한 번씩 실행해 로그인하세요.

| AI | 환경변수 | 기본 모델 |
|---|---|---|
| GPT (OpenAI) | `OPENAI_API_KEY` | `gpt-4o` |
| Gemini (Google) | `GEMINI_API_KEY` | `gemini-2.5-flash` |
| Claude (Anthropic) | `ANTHROPIC_API_KEY` | `claude-sonnet-5-5` |

모델명은 `.env` 또는 화면의 입력칸에서 바꿀 수 있습니다. 모델 이름은 서비스가 자주 바꾸므로, **API 키가 있으면 서비스에서 지금 쓸 수 있는 모델 목록을 가져와** 입력칸 목록으로 보여 주고(`/api/models`, 10분 캐시), 기본 모델이 목록에 없으면 최신 주력 모델을 자동으로 고릅니다. `.env` 의 `*_MODEL` 로 고정하면 그대로 씁니다. CLI 방식은 칸을 **비우는 것**이 가장 안전합니다. 모델 때문에 실패하면 오류 메시지 끝에 해결 방법이 붙습니다.

## 실행파일 (Node 설치 없이 더블클릭)

Node.js가 없는 PC에서도 쓰려면 단일 실행파일로 빌드합니다.

```bash
npm install
npm run build:exe        # 현재 OS용 -> dist/ai-council-<os>-<arch>
npm run build:exe:win    # Windows용(.exe)을 다른 OS에서 교차 빌드
```

- 실행하면 콘솔 창이 뜨고 브라우저가 자동으로 열립니다. 창을 닫으면 종료됩니다.
- 처음 실행하면 실행파일 옆에 `.env` 템플릿이 생깁니다. API 키 방식은 여기에 키를 넣고 다시 실행하세요. 키가 없고 CLI가 설치돼 있으면 자동으로 CLI 방식으로 시작합니다.
- macOS용은 서명(codesign) 때문에 macOS에서 빌드해야 합니다. 3개 OS용을 한 번에 받으려면 GitHub의 **Actions → Build executables → Run workflow** 를 실행하고 결과 Artifacts 를 내려받으세요. (`v1.0.0` 같은 태그를 푸시하면 Release 에 자동 첨부됩니다.)
- 서명되지 않은 실행파일이라 Windows SmartScreen("PC를 보호했습니다")이나 macOS 보안 경고가 뜰 수 있습니다. Windows는 "추가 정보 → 실행", macOS는 우클릭 → 열기로 실행하세요.

## 삼국지 모드

화면 왼쪽의 **삼국지 모드**(기본 켜짐)를 끄면 일반 화면으로 바뀝니다. 선택은 브라우저에 기억됩니다.

| 캐릭터 | AI | 성격 |
|---|---|---|
| 유비 (備) | Claude | 온화하고 신중. 맏형으로 **최종 결단을 주재** |
| 관우 (羽) | GPT | 강직하고 원칙적 |
| 장비 (飛) | Gemini | 호탕하고 직설적 |

**군의 장면**: 병풍 앞 원탁에 세 형제가 앉고, 탁자 위 의제 두루마리에 내 질문이 올라옵니다. 누가 숙고 중인지 실시간으로 빛나고, 방금 한 발언은 자막으로 나옵니다. (모바일에서는 자막을 숨깁니다.)

**제갈량의 한마디**: 최종 결단이 나오면 군사 제갈량(亮)이 *한 줄 요약 · 군사의 책략 · 오늘의 첫 수* 세 줄을 올립니다. 결단을 쓴 AI가 제갈량을 대신 연기하며(추가 호출 1회), 실패해도 회의 결과에는 영향이 없습니다.

발언은 사극풍 말투로 나옵니다. 말투는 가볍게 곁들이는 수준이며 분석 내용과 형식은 그대로입니다. 최종 결단 문서는 평소처럼 알아보기 쉬운 형식으로 정리됩니다. 캐릭터 설정은 `lib/personas.js` 에서 바꿀 수 있습니다.

## 회의 방식

1. **1라운드**: 각 AI가 서로의 답을 보지 않고 독립적으로 의견을 냅니다. (병렬 호출)
2. **2~3라운드** (선택): 앞선 회의록을 읽고 동의/반박/수정된 입장을 말합니다.
3. **최종 결론**: 선택한 사회자가 *결론 · 합의된 점 · 의견이 갈린 점 · 다음 단계*로 정리합니다.

- 화면에서 참가 AI, 모델, 라운드 수(1~3), 사회자를 선택할 수 있습니다. 한 AI만 선택해도 동작합니다.
- 한 AI가 오류가 나도 회의는 계속됩니다. 사회자가 실패하면 다른 AI가 대신 정리합니다.
- 같은 화면에서 이어서 질문하면 이전 결론이 맥락으로 전달됩니다. "새 회의 시작"으로 초기화합니다.
- 서버는 `127.0.0.1` 에만 열리며 API 키는 서버(.env)에만 있고 브라우저로 전달되지 않습니다.

## 구조

```
server.js          HTTP 서버, SSE 스트리밍 (/api/council, /api/config)
lib/council.js     회의 진행 로직 (라운드, 프롬프트, 사회자)
lib/personas.js    삼국지 캐릭터 설정 (이름, 색, 말투)
lib/models.js       서비스의 모델 목록 조회, 기본 모델 추천, 모델 오류 힌트
lib/providers.js   OpenAI / Gemini / Anthropic API 어댑터 + CLI 실행기 (+ 데모 모드)
public/            웹 화면 (index.html, app.js, style.css)
test/smoke.js      데모 모드 통합 테스트
test/cli.js        가짜 CLI로 CLI 방식 검증 (npm test 에서 둘 다 실행)
scripts/build.js   단일 실행파일 빌드 (Node SEA)
```
