# AI 회의실

질문을 올리면 **GPT · Gemini · Claude**가 라운드별로 의견을 내고 서로 반박한 뒤, 사회자 AI가 **최종 결론**을 정리해 보여주는 로컬 웹 프로그램입니다. 설치할 패키지가 없습니다 (Node.js 18+ 만 필요).

## 시작하기

```bash
cp .env.example .env     # 사용할 AI의 API 키만 채우세요 (키가 있는 AI만 참가)
npm start                # http://localhost:3000
```

키 없이 화면만 보고 싶다면 `npm run demo` (가짜 응답으로 동작).

| AI | 환경변수 | 기본 모델 |
|---|---|---|
| GPT (OpenAI) | `OPENAI_API_KEY` | `gpt-4o` |
| Gemini (Google) | `GEMINI_API_KEY` | `gemini-2.5-flash` |
| Claude (Anthropic) | `ANTHROPIC_API_KEY` | `claude-sonnet-5-5` |

모델명은 `.env` 또는 화면의 입력칸에서 자유롭게 바꿀 수 있습니다.

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
lib/providers.js   OpenAI / Gemini / Anthropic 어댑터 (+ 데모 모드)
public/            웹 화면 (index.html, app.js, style.css)
test/smoke.js      데모 모드 통합 테스트 (npm test)
```
