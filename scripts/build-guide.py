#!/usr/bin/env python3
"""docs/guide.html(사용 설명서)을 만든다. 화면 그림은 docs/img/*.jpg 를 base64 로 넣어 파일 하나로 배포한다.
실행: python3 scripts/build-guide.py"""
import base64, pathlib

root = pathlib.Path(__file__).resolve().parent.parent
img = lambda name: 'data:image/jpeg;base64,' + base64.b64encode((root / 'docs' / 'img' / name).read_bytes()).decode()

HTML = r'''<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI 회의실 사용 설명서 (처음 쓰는 사람용)</title>
<style>
  :root { --bg:#f7f7fb; --panel:#ffffff; --text:#1f2430; --muted:#5b6475; --line:#d9dce6; --accent:#4f46e5; --code:#eef0f7; --ok:#15803d; --warn:#b45309; --bad:#b91c1c; }
  @media (prefers-color-scheme: dark) { :root { --bg:#14161d; --panel:#1d2029; --text:#eceef5; --muted:#a3abbd; --line:#343949; --accent:#8b86ff; --code:#272b38; --ok:#4ade80; --warn:#fbbf24; --bad:#f87171; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:18px/1.85 "Malgun Gothic","Apple SD Gothic Neo","Noto Sans KR",system-ui,sans-serif; }
  main { max-width: 860px; margin: 0 auto; padding: 28px 18px 90px; }
  h1 { font-size: 32px; line-height: 1.35; margin: 0 0 8px; }
  h2 { font-size: 26px; margin: 56px 0 12px; padding: 10px 14px; background: var(--accent); color:#fff; border-radius: 12px; }
  h3 { font-size: 21px; margin: 30px 0 8px; }
  p, li { margin: 8px 0; }
  .lead { font-size: 19px; color: var(--muted); }
  nav { display:flex; flex-wrap:wrap; gap:8px; margin: 16px 0 6px; }
  nav a { background: var(--panel); border:1px solid var(--line); padding: 6px 14px; border-radius: 999px; text-decoration:none; color: var(--accent); font-weight:700; font-size:16px; }
  .box { background: var(--panel); border: 2px solid var(--line); border-radius: 14px; padding: 14px 18px; margin: 16px 0; }
  .ok { border-color: var(--ok); background: color-mix(in srgb, var(--ok) 9%, var(--panel)); }
  .warn { border-color: var(--warn); background: color-mix(in srgb, var(--warn) 10%, var(--panel)); }
  .bad { border-color: var(--bad); background: color-mix(in srgb, var(--bad) 9%, var(--panel)); }
  .box > b.t { display:block; font-size: 19px; margin-bottom: 4px; }
  .ok > b.t { color: var(--ok); } .warn > b.t { color: var(--warn); } .bad > b.t { color: var(--bad); }
  code { background: var(--code); border-radius: 6px; padding: 2px 7px; font-family: Consolas,"D2Coding",monospace; font-size: 16px; word-break: break-all; }
  pre { background: var(--code); border-radius: 10px; padding: 14px 16px; overflow-x: auto; font: 16px/1.6 Consolas,"D2Coding",monospace; margin: 12px 0; border: 1px solid var(--line); user-select: all; }
  ol.steps { list-style: none; counter-reset: s; padding: 0; }
  ol.steps > li { counter-increment: s; position: relative; margin: 18px 0; padding: 12px 16px 12px 66px; background: var(--panel); border: 1px solid var(--line); border-radius: 14px; }
  ol.steps > li::before { content: counter(s); position: absolute; left: 14px; top: 12px; width: 38px; height: 38px; border-radius: 50%; background: var(--accent); color:#fff; font-weight:800; display:grid; place-items:center; font-size: 20px; }
  img { max-width: 100%; border: 2px solid var(--line); border-radius: 12px; margin: 10px 0 2px; background: #fff; }
  figcaption { color: var(--muted); font-size: 16px; margin-bottom: 10px; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 17px; }
  th, td { border: 1px solid var(--line); padding: 8px 12px; text-align: left; vertical-align: top; }
  th { background: var(--code); }
  details { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 4px 16px; margin: 10px 0; }
  summary { cursor: pointer; font-weight: 700; padding: 8px 0; }
  kbd { background: var(--code); border: 1px solid var(--line); border-bottom-width: 3px; border-radius: 6px; padding: 0 8px; font-size: 15px; }
  .big { font-size: 22px; font-weight: 800; }
  .path { background: var(--code); padding: 2px 8px; border-radius: 6px; font-weight: 700; }
  .map { display:grid; grid-template-columns: repeat(auto-fit,minmax(150px,1fr)); gap: 10px; margin: 14px 0; }
  .map div { background: var(--panel); border:2px solid var(--accent); border-radius:14px; padding: 10px 12px; text-align:center; font-weight:700; line-height:1.5; }
  .map small { display:block; color: var(--muted); font-weight: 400; }
</style>
</head>
<body>
<main>

<h1>🧑‍⚖️ AI 회의실 사용 설명서</h1>
<p class="lead">컴퓨터를 처음 써 보는 사람도 <b>순서대로만 따라 하면</b> 되도록 썼어요. 모르는 낱말은 맨 아래 <a href="#words">낱말 풀이</a>에 있어요.</p>
<nav>
  <a href="#what">이게 뭐예요?</a><a href="#ready">준비물</a><a href="#s1">① 켜기</a><a href="#s2">② Claude</a><a href="#s3">③ ChatGPT</a><a href="#s4">④ Gemini</a><a href="#s5">⑤ 첫 회의</a><a href="#more">더 잘 쓰기</a><a href="#cost">돈·한도</a><a href="#help">막혔어요</a><a href="#words">낱말 풀이</a>
</nav>

<h2 id="what">이게 뭐예요?</h2>
<p>질문 하나를 쓰면 <b>여러 AI 친구(Claude, ChatGPT, Gemini)</b>가 회의실에 둘러앉아 서로 의견을 말하고, 서로 반박하고, 마지막에 <b>결론</b>을 정리해서 보여 주는 프로그램이에요.</p>
<ul>
  <li>⚖️ <b>변호사</b>, 📈 <b>투자자</b>, 💼 <b>CFO</b> 같은 <b>직업</b>을 AI에게 정해 줄 수 있어요. (56가지)</li>
  <li>👥 회의 인원은 <b>1명~8명</b>. 6명을 <b>전부 Claude</b>로 할 수도, <b>반반</b>으로 나눌 수도 있어요.</li>
  <li>📎 파일(문서, 엑셀, 파워포인트)을 읽혀서 회의하고, 결과를 <b>워드·엑셀·파워포인트 파일</b>로 저장할 수도 있어요.</li>
</ul>
<div class="box warn"><b class="t">이 프로그램이 내 컴퓨터 밖으로 보내는 것</b>
내가 쓴 질문과 붙인 파일 내용은 <b>AI 회사(Anthropic, OpenAI, Google)의 서버로 전송돼요.</b> 비밀번호, 주민번호, 회사 기밀 같은 건 올리지 마세요.</div>

<h2 id="ready">시작하기 전에 준비할 것</h2>
<table>
  <tr><th>준비물</th><th>왜 필요해요?</th></tr>
  <tr><td>💻 Windows 컴퓨터 (10 또는 11), 인터넷</td><td>프로그램을 켜요.</td></tr>
  <tr><td>🟠 <b>Claude 계정</b> (구독 중인 것)</td><td>Claude AI를 불러요. <b>돈이 따로 안 들고</b> 구독 사용량 안에서 써요.</td></tr>
  <tr><td>🟢 <b>ChatGPT 계정</b></td><td>ChatGPT AI를 불러요. 이것도 구독(또는 무료 계정) 안에서 써요.</td></tr>
  <tr><td>🔵 <b>Google 계정</b> (지메일)</td><td>Gemini의 <b>무료 열쇠(API 키)</b>를 만들어요.</td></tr>
</table>
<div class="box ok"><b class="t">왜 이렇게 나눠요? (비용 때문이에요)</b>
Claude와 ChatGPT는 <b>이미 내는 구독</b>으로 쓰고, Gemini는 <b>무료 열쇠</b>로 써요. 그래서 <b>추가 요금이 거의 안 들어요.</b> 이 프로그램은 이 조합을 <b>"혼합"</b>이라고 불러요. (열쇠가 있는 AI는 열쇠로, 없는 AI는 로그인해 둔 프로그램으로 불러요.)</div>
<p>전체 순서는 이래요. 각 단계는 <b>10분 안팎</b>이에요.</p>
<div class="map">
  <div>① 프로그램 켜기<small>더블클릭</small></div>
  <div>② Claude 연결<small>한 번만</small></div>
  <div>③ ChatGPT 연결<small>한 번만</small></div>
  <div>④ Gemini 열쇠 넣기<small>한 번만</small></div>
  <div>⑤ 첫 회의!<small>질문 쓰기</small></div>
</div>
<p>②③④는 <b>처음 한 번만</b> 하면 돼요. 다음부터는 ①만 하면 바로 쓸 수 있어요.</p>

<h2 id="s1">① 프로그램 켜기</h2>
<ol class="steps">
  <li><b>압축 풀기.</b> 받은 <code>ai-council-windows.zip</code> 파일 위에서 <b>마우스 오른쪽 버튼</b> → <b>모두 압축 풀기</b> → <b>압축 풀기</b>를 눌러요. 폴더가 하나 생겨요. (바탕화면에 풀면 찾기 쉬워요.)
    <div class="box bad"><b class="t">꼭 지켜요</b>압축을 <b>풀지 않고</b> zip 안에서 바로 켜면 안 돼요. 꼭 풀어서 나온 <b>폴더 안에서</b> 켜세요.</div></li>
  <li><b>더블클릭.</b> 폴더 안의 <span class="path">AI-Council.exe</span> 를 <b>마우스 왼쪽 버튼으로 두 번 빠르게</b> 눌러요.</li>
  <li><b>파란 창이 나오면.</b> "Windows의 PC 보호" 파란 창이 뜰 수 있어요. 고장이 아니에요. 직접 만든 프로그램이라 Windows가 처음 보는 것뿐이에요.
    <ol><li><b>추가 정보</b>를 눌러요.</li><li>그러면 나타나는 <b>실행</b> 버튼을 눌러요.</li></ol></li>
  <li><b>검은 창이 나오고, 잠시 뒤 인터넷 창(브라우저)이 열려요.</b> 이 화면이 나오면 성공이에요. (아래 그림)
    <div class="box bad"><b class="t">검은 창은 닫지 마세요!</b>검은 창을 닫으면 프로그램이 꺼져요. 작게 줄여(－ 버튼) 두면 돼요. 다 쓰고 끌 때만 닫으세요.</div></li>
  <li>인터넷 창이 <b>저절로 안 열리면</b> 인터넷 창(크롬 등)을 직접 열고, 맨 위 주소 칸에 <code>localhost:3000</code> 이라고 쓰고 <kbd>Enter</kbd> 를 눌러요.</li>
</ol>
<div class="box ok"><b class="t">✅ 이렇게 보이면 성공이에요</b>왼쪽에 "AI 회의실" 제목과 <b>참가자 카드</b>들이 보이고, 오른쪽 아래에 질문을 쓰는 칸이 있어요. 아직 AI가 연결되지 않아서 카드에 <b>"설정이 필요합니다"</b> 같은 빨간 글씨가 보일 수 있어요. 괜찮아요. ②③④에서 연결할 거예요.</div>
<p>이 단계에서 프로그램이 <b>같은 폴더에 <code>.env</code> 라는 설정 파일을 저절로 만들어요.</b> ④에서 쓸 거예요.</p>

<h3>화면 살펴보기</h3>
<figure><img alt="화면 안내(번호 그림)" src="@@OVERVIEW@@"><figcaption>번호가 붙은 곳을 설명할게요. (그림은 연습용 가짜 답변으로 만든 화면이에요.)</figcaption></figure>
<table>
  <tr><th>번호</th><th>이름</th><th>뭐 하는 곳?</th></tr>
  <tr><td>1</td><td>실행 방식</td><td><b>"혼합"</b>이 파랗게 켜져 있으면 돼요. (④까지 하면 저절로 혼합이 돼요)</td></tr>
  <tr><td>2</td><td>팀 구성</td><td>"투자팀", "임원회의"처럼 <b>회의 멤버를 한 번에</b> 정해요.</td></tr>
  <tr><td>3</td><td>AI 배정</td><td>그 멤버를 <b>어떤 AI</b>로 채울지 정해요. (전부 Claude / 반반 …)</td></tr>
  <tr><td>4</td><td>참가자 카드</td><td>한 명(한 자리)이에요. 어떤 AI인지, 직업은 뭔지 바꿀 수 있어요.</td></tr>
  <tr><td>5</td><td>토론 라운드</td><td>몇 번 의견을 주고받을지. 처음엔 <b>"2"</b> 그대로 두세요.</td></tr>
  <tr><td>6</td><td>질문 칸</td><td>여기에 질문을 써요.</td></tr>
  <tr><td>7</td><td>회의 시작</td><td>누르면 회의가 시작돼요. (<kbd>Ctrl</kbd>+<kbd>Enter</kbd> 도 돼요)</td></tr>
  <tr><td>8, 9</td><td>📎 첨부, 📁 폴더</td><td>파일이나 폴더를 읽혀서 회의해요.</td></tr>
</table>

<h2 id="s2">② Claude 연결하기 (한 번만)</h2>
<p>Claude를 부르는 작은 프로그램(<b>claude</b>)을 깔고, 내 Claude 계정으로 <b>로그인</b>해 두는 거예요.</p>
<ol class="steps">
  <li><b>PowerShell 열기.</b> 키보드 왼쪽 아래 <b>윈도우 키(⊞)</b>를 누르고 <code>powershell</code> 이라고 쳐요. <b>Windows PowerShell</b>이 나오면 눌러요. <b>파란 창</b>이 열려요.</li>
  <li><b>아래 한 줄을 복사해서 붙여 넣기.</b> 아래 회색 칸을 한 번 클릭하면 전체가 선택돼요 → <kbd>Ctrl</kbd>+<kbd>C</kbd> 로 복사 → 파란 창을 한 번 클릭하고 <b>마우스 오른쪽 버튼</b>을 누르면 붙여 넣어져요 → <kbd>Enter</kbd>.
<pre>irm https://claude.ai/install.ps1 | iex</pre>
    글자가 줄줄 올라가다가 멈추면 끝난 거예요. (1~2분)</li>
  <li><b>PowerShell을 닫고 다시 열어요.</b> (새로 깔린 걸 컴퓨터가 알아보게 하려고요.)</li>
  <li><b>로그인.</b> 파란 창에 이렇게 쳐요.
<pre>claude</pre>
    인터넷 창이 열리면 <b>내 Claude 계정으로 로그인</b>하고 허락(Authorize)을 눌러요. 파란 창으로 돌아오면 <b>"이 폴더를 믿을까요?"</b> 같은 질문이 나올 수 있어요. <b>Yes</b>(1번)를 고르고 <kbd>Enter</kbd> 를 눌러요.</li>
  <li><b>나가기.</b> 파란 창에 <code>/exit</code> 라고 쓰고 <kbd>Enter</kbd>. (안 되면 <kbd>Ctrl</kbd>+<kbd>C</kbd> 를 두 번 눌러요.)</li>
  <li><b>잘 됐는지 확인.</b>
<pre>claude --version</pre>
    숫자(예: <code>2.1.0</code>)가 나오면 성공이에요.</li>
</ol>
<div class="box warn"><b class="t">"claude 라는 말은 이름이 인식되지 않습니다"가 나오면</b>
컴퓨터가 방금 깐 프로그램의 <b>위치를 모르는</b> 거예요. 아래 한 줄을 붙여 넣고 <kbd>Enter</kbd> → <b>PowerShell을 닫았다가 다시 열고</b> <code>claude --version</code> 을 다시 해 보세요.
<pre>[Environment]::SetEnvironmentVariable("Path", $env:Path + ";$env:USERPROFILE\.local\bin", "User")</pre>
그래도 안 되면 설치가 끝날 때 파란 창에 나온 <b>"PATH"에 관한 안내 글</b>을 읽고 그대로 따라 하세요.</div>

<h2 id="s3">③ ChatGPT 연결하기 (한 번만)</h2>
<p>ChatGPT를 부르는 작은 프로그램(<b>codex</b>)을 깔고 로그인해요. 이 프로그램을 깔려면 먼저 <b>Node.js</b>라는 것이 필요해요. (처음 한 번만요.)</p>
<ol class="steps">
  <li><b>Node.js 깔기.</b> 인터넷 창에서 <code>nodejs.org</code> 에 들어가요. <b>LTS</b>라고 적힌 <b>초록색 큰 버튼</b>을 눌러 받아요. 받은 파일을 열고 <b>Next</b>(다음)만 계속 눌러서 끝까지 가요.</li>
  <li><b>PowerShell을 새로 열어요.</b> (②에서 열었던 건 닫고 새로요.)</li>
  <li><b>codex 깔기.</b>
<pre>npm install -g @openai/codex</pre>
    1~3분 걸려요. 글자가 멈추고 다시 입력할 수 있게 되면 끝이에요.</li>
  <li><b>로그인.</b>
<pre>codex login</pre>
    인터넷 창이 열리면 <b>ChatGPT 계정으로 로그인</b>하고 허락을 눌러요. 파란 창에 <code>Successfully logged in</code> 이 보이면 성공이에요.
    <div class="box warn"><b class="t">인터넷 창이 안 열리면</b><code>codex login --device-auth</code> 라고 쳐 보세요. <b>주소</b>와 <b>코드</b>가 나와요. 그 주소를 인터넷 창에서 열고 코드를 넣으면 돼요. <b>내가 직접 시작한 로그인의 코드만</b> 넣으세요. 누가 보내 준 코드는 넣지 마세요.</div></li>
  <li><b>잘 됐는지 확인.</b>
<pre>codex --version
codex login status</pre>
    버전 숫자가 나오고 <code>Logged in using ChatGPT</code> 라고 나오면 성공이에요.</li>
</ol>
<div class="box warn"><b class="t">"이 시스템에서 스크립트를 실행할 수 없으므로 npm.ps1 파일을…" 이라는 빨간 글이 나오면</b>
PowerShell 대신 <b>명령 프롬프트</b>를 쓰면 돼요. 윈도우 키(⊞)를 누르고 <code>cmd</code> 라고 쳐서 <b>명령 프롬프트</b>(검은 창)를 열고, 같은 줄을 다시 입력하세요.</div>

<h2 id="s4">④ Gemini 열쇠 만들어서 넣기 (한 번만, 무료)</h2>
<p>Gemini는 <b>열쇠(API 키)</b>를 만들어서 프로그램에게 알려 주는 방식으로 써요. 열쇠는 <b>AIza…</b> 로 시작하는 긴 글자예요.</p>
<ol class="steps">
  <li><b>열쇠 만들기.</b> 인터넷 창에서 <code>aistudio.google.com/apikey</code> 에 들어가요. Google 계정으로 로그인하고 <b>Create API key</b>(API 키 만들기)를 눌러요. 긴 글자가 나오면 <b>복사</b> 버튼을 눌러요.
    <div class="box bad"><b class="t">열쇠는 비밀번호예요</b>다른 사람에게 보여 주거나, 카톡·메일로 보내거나, 사진을 찍어 올리지 마세요. 실수로 남에게 보였다면 같은 사이트에서 그 열쇠를 지우고 새로 만드세요.</div></li>
  <li><b>설정 파일(<code>.env</code>) 열기.</b> ①에서 프로그램이 만든 폴더(AI-Council.exe가 있는 폴더)에서 <span class="path">.env</span> 파일을 찾아요. <b>마우스 오른쪽 버튼 → 연결 프로그램 → 메모장</b> 으로 열어요.
    <div class="box warn"><b class="t">.env 파일이 안 보이면</b>폴더 위쪽 메뉴에서 <b>보기 → 표시 → 숨긴 항목</b>과 <b>파일 확장명</b>에 체크(✔)를 해 보세요. 그래도 없으면 프로그램을 한 번 껐다가 다시 켜 보세요(처음 켤 때 만들어져요).</div></li>
  <li><b>한 줄 써 넣기.</b> 메모장 맨 아래에 이렇게 써요. <code>=</code> 뒤에 방금 복사한 열쇠를 <b>붙여 넣어요</b>(<kbd>Ctrl</kbd>+<kbd>V</kbd>). <b>따옴표(" ")나 빈칸은 넣지 마세요.</b>
<pre>GEMINI_API_KEY=여기에붙여넣기</pre>
    이미 <code>GEMINI_API_KEY=</code> 로 시작하는 줄이 있으면 <b>그 줄 뒤에</b> 붙여 넣으면 돼요. 앞에 <code>#</code> 이 붙어 있으면 <code>#</code> 을 지워요.</li>
  <li><b>저장.</b> <kbd>Ctrl</kbd>+<kbd>S</kbd> 를 누르고 메모장을 닫아요.</li>
  <li><b>프로그램을 껐다가 다시 켜요.</b> 검은 창을 닫고, ①처럼 <span class="path">AI-Council.exe</span> 를 다시 더블클릭해요. <b>설정 파일을 고치면 꼭 다시 켜야 해요.</b></li>
</ol>
<div class="box ok"><b class="t">✅ 이렇게 보이면 성공이에요 — "혼합"</b>
검은 창에 <code>기본 실행 방식: MIXED</code> 가 보이고, 인터넷 창 왼쪽 <b>"실행 방식"</b>에서 <b>혼합</b>이 파랗게 켜져 있어요. 참가자 카드(GPT, Gemini, Claude)에 <b>빨간 경고가 없으면</b> 준비 끝이에요! 🎉</div>
<div class="box warn"><b class="t">Gemini 무료 열쇠에 대해 꼭 알아 두세요</b>
<ul>
  <li>지금 무료 열쇠로는 <b>"3.5 flash-lite"라는 가벼운 모델만</b> 쓸 수 있는 걸로 확인됐어요. 이 프로그램은 모델을 <b>"자동"</b>으로 두면 이 가벼운 모델을 먼저 써서 <b>그냥 돼요.</b> 모델 칸은 건드리지 마세요.</li>
  <li>무료라서 <b>1분에 보낼 수 있는 횟수</b>가 적어요. 너무 빨리 많이 부르면 <code>429</code> 라는 글이 나와요. 그러면 <b>1분쯤 기다렸다가</b> 다시 하거나, 참가자 수·토론 횟수를 줄이세요. <b>한 회의에 Gemini를 여러 자리</b> 앉히면 더 빨리 걸려요.</li>
  <li><b>Claude와 ChatGPT의 열쇠(API 키)는 넣지 마세요.</b> 넣으면 구독이 아니라 <b>열쇠(유료 종량제)</b>로 불러서 <b>돈이 따로 나가요.</b> (Gemini 열쇠만 넣는 게 정답이에요.)</li>
</ul></div>

<h2 id="s5">⑤ 첫 회의 해 보기</h2>
<ol class="steps">
  <li><b>처음엔 가볍게.</b> 왼쪽 <b>토론 라운드</b>가 <b>"2 (의견 + 반박)"</b> 인지만 확인해요. 참가자는 그대로(GPT, Gemini, Claude)요.</li>
  <li><b>질문 쓰기.</b> 아래 칸에 이런 질문을 써 봐요. <i>"점심 메뉴를 정하는 가장 공정한 방법은?"</i></li>
  <li><b>회의 시작</b> 버튼을 눌러요. (또는 <kbd>Ctrl</kbd>+<kbd>Enter</kbd>)</li>
  <li><b>기다려요.</b> 카드가 하나씩 생기며 AI들이 말해요. <b>한 번에 10~60초</b> 걸릴 수 있어요. 처음엔 1~3분 걸려도 정상이에요. 멈추고 싶으면 <b>중단</b>을 눌러요.</li>
  <li><b>결론 읽기.</b> 맨 아래 노란 칸이 <b>최종 결론</b>이에요.</li>
</ol>
<figure><img alt="회의 결과 화면" src="@@RESULT@@"><figcaption>결과 화면 예시(연습용 가짜 답변). 번호 설명은 아래에 있어요.</figcaption></figure>
<table>
  <tr><th>번호</th><th>이게 뭐예요?</th></tr>
  <tr><td>1</td><td><b>최종안 확인</b> — 모두가 각자 따로 "찬성/조건부/반대"를 눌러요. 전원이 찬성해야 <b>합의</b>예요. 눈치 보고 맞장구치는 걸 막으려는 장치예요.</td></tr>
  <tr><td>2</td><td><b>최종 결론</b> — 결론, 합의된 점, 의견이 갈린 점, 다음에 할 일이 정리돼요.</td></tr>
  <tr><td>3</td><td><b>💾 결과물로 저장</b> — 이름과 종류(.md, .docx 워드, .xlsx 엑셀, .pptx 파워포인트 …)를 고르고 <b>저장</b>을 누르면 파일이 만들어져요. (먼저 📁 폴더에서 저장할 폴더를 정해야 해요. 아래에 설명이 있어요.)</td></tr>
  <tr><td>4</td><td><b>회의록 저장됨</b> — 회의 전체 기록이 <b>저절로 파일로 저장</b>돼요. 프로그램 폴더 안 <b>"회의록"</b> 폴더에 있어요.</td></tr>
</table>
<div class="box ok"><b class="t">여기까지 했으면 기본은 끝!</b>이제 아래 "더 잘 쓰기"에서 필요한 것만 골라 보세요. 다 읽을 필요는 없어요.</div>

<h2 id="more">더 잘 쓰기</h2>

<h3>사무실 화면</h3>
<p>화면 위쪽에 <b>사무실</b>이 있고, 참가자들이 자기 책상에 앉아 있어요. 질문을 쓰고 <b>회의 소집</b>을 누르면 모두 <b>회의실</b>로 걸어가서 토론해요. 누가 생각 중인지, 누가 말했는지는 머리 위 표시로 보여요. 토론 내용 전체는 <b>회의록</b> 폴더에 저장되고, 화면에는 <b>질문과 결론</b>만 남아요. 전체 토론 글을 보고 싶으면 <b>"토론 내용 보기"</b> 버튼을 누르세요. 끝나면 모두 책상으로 돌아가요.</p>
<h3>회의 중에 끼어들기</h3>
<p>회의가 돌아가는 동안에도 글 쓰는 칸에 쓸 수 있어요. 버튼이 <b>"끼어들기"</b>로 바뀌어요. 예를 들어 <b>"이번 분기 예산은 최대 300만원이야"</b>라고 쓰고 보내면, AI들이 <b>다음 라운드부터</b> 그 말을 듣고 이야기하고 <b>최종 결론</b>에도 넣어요. 토론이 충분하다 싶으면 <b>"여기서 결론"</b>을 눌러요. 지금 라운드가 끝나면 거기까지의 토론으로 결론을 정리해요. 한 회의에서 10번까지 끼어들 수 있어요. (이미 말하고 있는 라운드는 끝낸 뒤에 반영돼요.)</p>
<h3>엑셀은 필요한 부분만 골라서</h3>
<p><b>첨부</b> 버튼으로 엑셀(.xlsx)을 올리면 창이 열려요. 왼쪽에서 <b>시트</b>를 고르고, <b>시작 행·끝 행</b>을 정하고, 보낼 <b>열</b>에 체크하세요. 전화번호 같은 열은 체크를 풀면 AI에게 아예 가지 않아요. <b>"행 걸러내기"</b>에 낱말(예: A노선)을 쓰면 그 낱말이 있는 줄만 보내요. <b>미리보기</b>로 확인한 뒤 <b>첨부하기</b>를 누르세요. 다른 시트도 이어서 고를 수 있어요. 날짜는 숫자(45219)가 아니라 날짜(2023-10-20)로 바뀌어서 가요. 폴더로 읽은 엑셀에도 <b>"시트·행 고르기"</b> 버튼이 있어요.</p>
<h3>개인정보 가리기 (기본으로 켜져 있어요)</h3>
<p>기사님 전화번호, 주민번호, 이메일, 계좌번호, 차량번호는 AI에게 보내기 전에 <b>[전화1]</b> 같은 이름표로 바뀌어요. 같은 번호는 같은 이름표라서 AI가 "같은 사람"인 건 알 수 있어요. 왼쪽 <b>"개인정보 보호"</b>에서 <b>가릴 이름</b>(기사님 이름 등)을 한 줄에 하나씩 적어 두세요. <b>"지금 질문·첨부로 미리보기"</b>를 누르면 무엇이 가려지는지 먼저 볼 수 있어요. 주소와 목록에 없는 이름은 못 찾으니, 중요한 자료는 미리보기로 꼭 확인하세요.</p>
<h3>숫자는 AI가 아니라 프로그램이 계산해요</h3>
<p>엑셀 창에서 <b>"숫자 열 합계·평균을 코드로 계산해 함께 첨부"</b>를 켜면, 고른 행 <b>전체</b>의 합계·평균·최소·최대를 프로그램이 계산해 표로 붙여요. <b>"묶어서 합계 낼 열"</b>(예: 캠프, 거래처)을 고르면 묶음별 합계도 나와요. AI는 큰 표의 계산을 틀리기 쉬워서, 계산은 프로그램이 하고 AI는 해석만 하게 한 거예요. 번호·전화·계좌 같은 열은 숫자로 보지 않고 건너뛰어요. 단, 엑셀에 값이 저장되지 않은 수식 칸은 비어 있는 것으로 계산돼요.</p>
<h3>왼쪽 메뉴는 탭으로 나뉘어 있어요</h3>
<p>왼쪽 위의 <b>참가자 / 회의 / 자료·보호 / 추적 / 연결·백업</b> 탭을 눌러 바꿔 보세요. 참가자(AI 고르기·역할), 회의(라운드·호출 상한·사전 부검·알림), 자료·보호(회사 정보·개인정보 가리기), 추적(할 일과 결정 기록), 연결·백업(API 키·백업)이 들어 있어요. 마지막에 보던 탭은 기억해요. AI가 하나도 연결되지 않았으면 <b>연결·백업</b> 탭에 빨간 점이 떠요.</p>
<h3>결론을 쓸 곳에 맞게 다시 쓰기 (문서 초안)</h3>
<p>결론 맨 아래 <b>"문서 초안"</b>에서 <b>상사 보고 1장 / 임원 5줄 요약 / 거래처 안내문 / 현장 공지</b> 중 하나를 누르면, 결론을 그 용도에 맞는 글로 다시 써 줘요(AI 호출 1회). 칸에 "임원이 읽는 톤으로"처럼 <b>추가 요청</b>을 적을 수도 있어요. 초안은 칸 안에서 바로 고칠 수 있고, <b>복사</b>하거나 <b>저장</b>(워드 등)할 수 있어요.</p>
<p>꼭 알아 두세요: 초안은 <b>결론에 있는 내용만</b> 쓰게 하고, 모르는 건 <b>[확인 필요]</b>로 남겨요. 그래도 AI가 숫자를 지어낼 수 있어서, 초안에 <b>결론에 없는 숫자</b>가 있으면 빨간 경고로 알려 줘요. 거래처 안내문에는 원가·내부 사정·내부 의견 차이를 쓰지 않게 하지만, <b>보내기 전에 꼭 사람이 읽고 고치세요</b>. 개인정보 가리기를 켰다면 초안에도 <b>[전화1]</b> 같은 표시가 그대로 남아 있을 수 있으니 실제 값으로 바꿔 넣으세요.</p>
<h3>설정을 바꿔도 괜찮을까? (평가 케이스)</h3>
<p>"Gemini를 빼면 결과가 나빠질까?", "이 역할을 넣으면 나아질까?" 같은 걸 <b>감이 아니라 비교</b>로 확인하는 기능이에요. 왼쪽 <b>"회의"</b> 탭의 <b>"평가 케이스"</b>를 열고 <b>"+ 새 케이스"</b>로 자주 쓰는 대표 안건을 저장하세요. <b>기대 포인트</b>(결론에 꼭 들어가야 할 낱말을 한 줄에 하나)를 적어 두면 결론에 그 낱말이 있는지 확인해 줘요. 회의가 끝난 뒤 결정 기록 카드의 <b>"평가 케이스로 저장"</b> 버튼으로도 만들 수 있어요.</p>
<p>그다음 <b>지금 화면의 설정</b>(참가자, 역할, 실행 방식, 라운드)에 이름을 붙여(예: "기본 2라운드") <b>"이 케이스 실행"</b>을 누르세요. 설정을 바꾸고 이름을 바꿔 같은 케이스를 또 실행하면, 결과 표에서 <b>호출 수, 걸린 시간, 합의 여부, 기대 포인트 적중, 질문에 없는 숫자</b>가 비교되고, 두 개 이상 체크하면 <b>결론이 나란히</b> 보여요. <b>실행할 때마다 실제 AI 호출 비용이 들어서</b> 시작 전에 예상 호출 수를 보여 주고 확인을 받아요.</p>
<p>꼭 알아 두세요: 프로그램이 하는 채점은 <b>기계적인 확인뿐</b>이에요(낱말이 있는가, 질문에 없는 숫자가 있는가). 어느 결론이 더 <b>좋은지</b>는 알 수 없으니 두 결론을 직접 읽고 판단하세요. 같은 설정으로 돌려도 AI 답은 매번 조금씩 달라서, 한 번의 차이만 보고 결론 내지 말고 여러 케이스로 확인하세요. 평가 실행은 회의록에 남지 않고 "사용량·비용" 합계에도 들어가지 않아요(결과 표의 호출 수에서 확인).</p>
<h3>AI를 얼마나 썼는지 보기 (사용량·비용)</h3>
<p>왼쪽 <b>"회의"</b> 탭의 <b>"사용량·비용 보기"</b>를 누르면 저장된 회의록을 모아서 보여 줘요. 기간(7일/30일/90일/전체)을 고르면 <b>회의 몇 번, AI 호출 몇 번</b>, AI별(GPT/Gemini/Claude…) 호출 수와 <b>추정 토큰</b>, 회의별 목록이 나와요. 표는 <b>CSV로 저장</b>해서 엑셀에서 열 수 있어요.</p>
<p><b>비용</b>은 직접 단가를 적어야 계산돼요. 이 프로그램은 AI 서비스의 가격을 모르기 때문이에요(가격이 자주 바뀌어요). <b>"단가 입력"</b>을 열어 각 서비스 가격표에 나온 <b>100만 토큰당 입력·출력 단가</b>를 적으면 추정 비용이 나와요. CLI 로그인 방식은 구독이라 토큰 과금이 아니어서 비용에서 빠져요. 중요: 토큰은 글자 수로 <b>어림한 값</b>이고 서비스 쪽 재시도·캐시 할인은 반영되지 않아요. <b>실제 청구서가 기준</b>이에요. 문서 초안과 연결 확인에 쓴 호출은 회의 밖이라 들어 있지 않아요. 이 기능을 넣은 뒤에 한 회의부터 AI별 상세가 기록되고, 그 전 회의는 호출 수만 보여요(* 표시).</p>
<h3>결정 기록: 결론이 맞았는지 나중에 확인하기</h3>
<p>결론 맨 아래에 <b>"결정 기록"</b>이 있어요. 제목을 확인하고 <b>재검토 시점</b>(2주·1개월·3개월 뒤, 또는 안 함)을 골라 <b>"결정으로 기록"</b>을 누르면 그 결론이 결정으로 저장돼요. 왼쪽 <b>"추적"</b> 탭의 <b>결정 기록</b>에서 재검토일을 고치고, 시간이 지난 뒤 <b>결과(잘 됨 / 절반만 됨 / 잘 안 됨)</b>와 실제 수치를 적어 두세요. 재검토할 날짜가 지나면 프로그램을 열 때 "재검토할 결정이 N건 있습니다"가 떠요. 결과는 사람이 적는 거예요. AI가 대신 정하지 않아요.</p>
<h3>비슷한 안건은 과거 결정과 함께</h3>
<p>질문을 쓰다 보면 글 쓰는 칸 위에 <b>"비슷한 지난 결정"</b>이 떠요(AI를 부르지 않고 글자가 겹치는 정도로 찾아요). 참고할 결정을 <b>체크</b>하면 그 결정의 결론과 <b>결과</b>가 이번 회의 자료로 올라가고, 사회자는 이번 결론이 과거와 <b>같은 방향인지 다른 방향인지</b>, 다르다면 이유를 밝혀요. 과거에 "잘 안 됨"이었던 결정은 같은 실수를 되풀이하지 않게 반영해요. 체크하지 않으면 아무것도 보내지 않아요. 비슷하다고 찾은 게 실제로는 다른 안건일 수 있으니 내용을 읽고 고르세요.</p>
<h3>결정한 일, 끝까지 챙기기 (할 일)</h3>
<p>결론에 <b>실행 계획</b> 표가 있으면 그 아래에 <b>"할 일" 카드</b>가 떠요. 담을 항목에 체크하고 <b>담당·기한을 확인해 고친 뒤</b> <b>"체크한 항목 담기"</b>를 누르세요. AI가 적은 담당·기한은 제안일 뿐이라, 사람이 확인해서 담는 거예요. 담은 일은 왼쪽 <b>"추적"</b> 탭에서 <b>진행 중 / 보류 / 완료 / 취소</b>로 바꾸고, 담당·기한·진행 메모를 적을 수 있어요. 기한(예: 10/30, 2026-10-30)이 지났는데 안 끝난 일에는 <b>"기한 지남"</b>이 붙어요.</p>
<p>그리고 다음 회의를 열면 <b>진행 중인 할 일이 자동으로 자료에 올라가요</b>(글 쓰는 칸 위에 "미완료 할 일 N개 포함"이 보여요). 사회자는 결론의 실행 계획에서 그 일들의 상태·막힌 점을 먼저 짚고, 같은 일을 새로 또 만들지 않아요. 원치 않으면 칩의 ×를 누르거나 "추적" 탭에서 끄세요. 할 일은 회의록 폴더의 <b>실행항목.json</b> 에 저장되고 <b>백업에도 함께 담겨요</b>. 같은 내용의 진행 중인 일은 두 번 담기지 않아요.</p>
<h3>결론의 숫자, 믿어도 될까? (근거 대조)</h3>
<p>결론이 나오면 바로 아래에 <b>"근거 대조"</b> 카드가 붙어요. 결론에 나온 <b>숫자</b>와 <b>따옴표 인용</b>이 내가 올린 자료(첨부, 회사 정보)와 질문에 정말 있는지 프로그램이 글자로 찾아본 결과예요(AI를 다시 부르지 않아요). 세 가지로 나뉘어요: <b>자료에서 확인</b>(자료에 그 숫자가 있음), <b>회의 발언에만 있음</b>(AI끼리 한 말에서만 나옴), <b>어디에도 없음</b>(AI가 만들었거나 계산해서 나온 값일 수 있음). ⚠가 붙은 숫자는 보고서에 쓰기 전에 꼭 직접 확인하세요. 주의: 자료에 있는 숫자라도 <b>맞게 해석했는지</b>는 알 수 없고, 단위가 다르게 적힌 숫자(예: 1.2억 ↔ 120,000,000은 확인하지만 12만 대 ↔ 120,000대는 못 찾을 수 있어요)는 놓칠 수 있어요. "실행 계획" 표의 날짜·수량은 AI의 제안이라 검사하지 않아요.</p>
<h3>처음 실행할 때: 연결 설정</h3>
<p>왼쪽 <b>"연결 설정"</b>에서 AI별로 <b>API 키를 붙여 넣고 저장</b>하면 실행파일 옆 <b>.env</b> 파일에 적히고 바로 쓸 수 있어요(다시 실행할 필요 없음). 키가 하나도 없으면 이 칸이 저절로 열려요. 저장한 키는 화면에 다시 나오지 않고, <b>키 지우기</b>로 지울 수 있어요. <b>연결 확인</b>을 누르면 아주 짧은 요청을 한 번 보내서 진짜 되는지 확인해요(유료 API는 아주 적은 비용이 들어요). 아래쪽에는 회의록 폴더, 회사 정보 파일, 설정 파일에 <b>저장할 수 있는지</b>가 ✓/✗로 나와요. ✗면 폴더 권한을 확인하거나 다른 위치에서 실행해 보세요.</p>
<h3>빠진 칸 미리 알려 주기 (사전 점검)</h3>
<p>안건 양식에서 앞쪽 핵심 칸이 비어 있거나 절반이 넘게 비어 있으면, 회의를 시작하기 <b>전에</b> 어떤 칸이 비었는지 알려 주고 그래도 시작할지 물어요. AI 호출은 돈이 드니까, 아는 값은 채우고 시작하는 편이 좋아요. 비운 칸은 "미확인"으로 전달돼요.</p>
<h3>사전 부검 (선택)</h3>
<p>왼쪽 <b>"사전 부검"</b>을 켜면 결론이 난 뒤에 "이 결정대로 했는데 석 달 뒤 실패했다면, 가장 그럴듯한 이유 3가지"를 표로 덧붙여요. 이유, 미리 볼 수 있는 신호, 지금 할 수 있는 예방이 나와요. AI 호출이 <b>1회</b> 더 들고, 호출 상한이 모자라면 생략돼요. AI의 가정이지 확인된 사실은 아니에요. 회의록에도 저장돼요.</p>
<h3>회의 끝 알림</h3>
<p>회의가 끝나면 짧은 소리가 나요. 다른 창을 보고 있었다면 탭 제목이 "✅ 회의가 끝났습니다"로 깜박이고, 브라우저 알림을 허락했다면 알림도 떠요. 왼쪽 <b>"회의 끝 알림"</b>으로 끌 수 있어요.</p>
<h3>백업·옮기기</h3>
<p>왼쪽 <b>"백업·옮기기"</b>에서 <b>백업 내려받기</b>를 누르면 회의록과 회사 정보가 zip 하나로 내려와요. 새 PC에서는 <b>백업 불러오기</b>로 다시 넣어요. 이미 있는 파일은 덮어쓰지 않고, API 키(.env)와 첨부 원본은 들어가지 않아요. (화면 설정은 브라우저에 저장되어 있어 옮겨지지 않아요.)</p>
<h3>지난 회의 이어 가기</h3>
<p>글 쓰는 칸 위의 <b>"지난 회의"</b> 버튼을 누르면 저장된 회의록을 찾을 수 있어요. 제목이나 결론의 낱말로 검색하고 <b>"이어 가기"</b>를 누르면, 그 회의 결론이 이번 회의의 배경으로 붙어요. 붙은 회의는 칸 위에 나타나고 ×를 누르면 떼요. (회의록은 실행파일 옆 <b>회의록</b> 폴더에 저장돼요.)</p>
<h3>1. 직업(역할) 정해 주기 — "변호사 AI", "투자자 AI"</h3>
<p>참가자 카드의 <b>"역할 없음"</b> 칸을 눌러 직업을 골라요. 그러면 그 AI가 <b>그 직업의 눈으로</b> 따지고, 꼭 확인할 것을 점검해요. 예) <b>변호사</b>는 계약서의 위험한 부분을 찾고, <b>비판자</b>는 일부러 약점을 파고들어요.</p>
<p>직업은 <b>56가지</b>예요: 대표·CFO·CTO·팀장, <b>펀드매니저·애널리스트·퀀트·리스크 매니저(주식투자팀)</b>, 변호사·회계사·의사, 개발자·보안·디자이너, 마케터·영업·고객지원, 인사·노무, 진행자, 비판자 …</p>
<div class="box warn"><b>⚠️ 알아 두세요:</b> 직업은 AI에게 "이 직업의 눈으로 따져 봐"라고 시키는 것이지, 없던 지식이 생기는 건 아니에요. 아는 만큼만 말해요. 법·세금·의료·투자 말은 <b>참고용</b>이고, 중요한 결정은 진짜 전문가에게 꼭 물어보세요.<br>
<b>더 똑똑하게 만드는 법:</b> 회의 전에 진짜 자료(계약서, 회사 규정, 재무 엑셀, 보고서)를 <b>📎 첨부</b>하거나 <b>폴더</b>로 알려 주세요. 그러면 참가자들이 그 자료를 근거로 말해요.</div>

<h3>2. 팀 한 번에 만들기 + 어떤 AI로 채울지 정하기</h3>
<p>직업을 하나씩 정하기 귀찮을 때 쓰세요. <b>팀 구성</b>에서 "주식투자팀(종목 투자 결정)", "임원회의", "법률·계약 검토" 같은 <b>28가지 팀</b> 중 하나를 고르면, 멤버와 직업이 <b>한 번에</b> 만들어져요.</p>
<figure><img alt="팀 구성과 AI 배정" src="@@TEAM@@"><figcaption>① 팀 구성 ② AI 배정 ③ 반반일 때 두 AI 고르기 ④ 지금 멤버의 AI만 다시 배정 ⑤ 참가자 카드</figcaption></figure>
<p><b>② AI 배정</b>이 "그 멤버들을 누구로 채울까"예요:</p>
<table>
  <tr><th>고르는 것</th><th>결과 (멤버가 6명일 때)</th></tr>
  <tr><td><b>골고루 돌아가며</b></td><td>GPT, Gemini, Claude, GPT, Gemini, Claude</td></tr>
  <tr><td><b>전부 Claude</b> (또는 전부 GPT, 전부 Gemini)</td><td>6명 모두 Claude (화면에는 Claude 1, Claude 2 … 로 보여요)</td></tr>
  <tr><td><b>반반 (두 AI 선택)</b> → 예: GPT + Claude</td><td>앞 3명은 GPT, 뒤 3명은 Claude</td></tr>
</table>
<ul>
  <li><b>순서가 중요해요:</b> ② AI 배정을 <b>먼저</b> 고르고, 그다음 ① 팀 구성을 고르세요.</li>
  <li>팀을 만든 뒤에 AI만 바꾸고 싶으면 ② AI 배정을 다시 고르고 <b>"지금 참가자에 AI 다시 배정"</b> 버튼을 눌러요. 직업은 그대로예요.</li>
  <li><b>한 명(한 자리)만</b> 바꾸고 싶으면 그 카드 위쪽의 <b>AI 이름 칸</b>(GPT, Claude …)을 눌러 바꿔요.</li>
  <li>카드의 <b>×</b> 는 빼기, 맨 아래 <b>"+ 참가자 추가"</b> 는 한 명 더하기예요(최대 8명).</li>
</ul>

<h3>3. 토론 횟수 정하기 (라운드)</h3>
<table>
  <tr><th>고르는 것</th><th>뜻</th></tr>
  <tr><td><b>1</b></td><td>각자 의견만 말해요. 가장 빠르고 싸요.</td></tr>
  <tr><td><b>2</b> (처음 설정)</td><td>의견을 말하고, 서로 반박해요.</td></tr>
  <tr><td><b>3</b></td><td>한 번 더 깊게 토론해요.</td></tr>
  <tr><td><b>합의까지 (최대 4 / 6라운드)</b></td><td>다 같이 <b>같은 결론이 될 때까지</b> 계속해요. 그래도 안 되면 최대 횟수에서 멈춰요.</td></tr>
  <tr><td><b>결론 날 때까지 (제한 없음)</b></td><td>횟수 제한 없이 합의될 때까지 계속해요. <b>호출 상한(아래)</b> 때문에 무한히 돌지는 않아요.</td></tr>
</table>

<h3>4. 파일 읽히기와 결과 저장하기</h3>
<ul>
  <li><b>📎 첨부</b>: 질문 칸 위의 버튼을 누르거나, 파일을 화면에 <b>끌어다 놓아요</b>. 글(.txt), 표(.csv), <b>PDF</b>, <b>워드(.docx)</b> 등을 읽어요. 모든 AI가 같은 자료를 읽어요.</li>
  <li><b>📁 폴더</b>: 폴더 주소를 붙여 넣고 <b>읽기</b>를 누르면 폴더 안의 문서(워드, <b>엑셀</b>, <b>파워포인트</b> 포함)를 읽어서 목록으로 보여 줘요. 보낼 파일에 ✔ 하고 <b>선택한 파일을 첨부</b>를 눌러요.
    <br>폴더 주소 알아내기: 폴더를 연 뒤 위쪽 <b>주소 칸을 클릭</b>하면 <code>C:\Users\…</code> 같은 글이 나와요. 그걸 복사해서 붙여 넣어요.</li>
  <li><b>💾 결과물로 저장</b>: 회의가 끝나면 결론 아래에 나와요. 파일 이름과 종류(워드·엑셀·파워포인트 등)를 고르고 저장하면, 읽어 온 폴더 안 <b>"결과물"</b> 폴더에 <b>새 파일</b>로 만들어져요. <b>기존 파일은 절대 덮어쓰지 않아요.</b></li>
  <li>안 읽히는 것: 사진, 한글(.hwp), 옛날 형식(.xls .ppt .doc), 글자 없는 스캔 PDF.</li>
</ul>

<h3>5. 삼국지 모드 (재미 모드)</h3>
<p>왼쪽 위 <b>삼국지 모드</b>에 체크하면 유비·관우·장비가 병풍 앞 원탁에 앉고, 마지막에 제갈량이 한마디 해요. 기본 3명(GPT, Gemini, Claude)이 한 명씩일 때만 쓸 수 있어요. 같은 AI를 여러 자리에 앉히면 저절로 꺼져요.</p>

<h3>6. 다른 AI도 쓰고 싶어요 (Grok, DeepSeek, Llama …)</h3>
<p>꼭 안 해도 돼요. 원하면 <code>.env</code> 파일에 <b>열쇠를 한 줄 더</b> 쓰면 "+ 참가자 추가" 목록의 <b>"그 밖의 AI"</b>에 나와요. 이 AI들은 <b>열쇠(유료일 수 있어요)</b>가 필요해요.</p>
<table>
  <tr><th>AI</th><th><code>.env</code> 에 쓰는 줄</th><th>특징</th></tr>
  <tr><td>Grok</td><td><code>XAI_API_KEY=열쇠</code></td><td></td></tr>
  <tr><td>DeepSeek</td><td><code>DEEPSEEK_API_KEY=열쇠</code></td><td>싼 편</td></tr>
  <tr><td>Perplexity</td><td><code>PERPLEXITY_API_KEY=열쇠</code></td><td>인터넷 검색을 해서 답해요(최신 정보)</td></tr>
  <tr><td>Mistral / Groq / OpenRouter</td><td><code>MISTRAL_API_KEY=</code> / <code>GROQ_API_KEY=</code> / <code>OPENROUTER_API_KEY=</code></td><td>OpenRouter는 열쇠 하나로 수백 개 모델</td></tr>
  <tr><td>Ollama (내 컴퓨터에서, 무료)</td><td><code>OLLAMA_MODEL=llama3.1</code></td><td>미리 Ollama를 깔고 모델을 받아 둬야 해요. 내용이 밖으로 안 나가요.</td></tr>
</table>

<h2 id="cost">돈과 한도 걱정될 때</h2>
<ul>
  <li><b>시작 버튼 위</b>에 <b>"예상 AI 호출 7회"</b>처럼 이번 회의가 AI를 <b>몇 번 부를지</b> 미리 보여 줘요. 사람 수가 많고 토론이 길수록 늘어요. 숫자가 크면 라운드나 사람 수를 줄이세요.</li>
  <li><b>AI 호출 상한</b>(왼쪽 아래, 처음 120회): 이 횟수에 닿으면 <b>자동으로 멈추고</b> 그때까지의 내용으로 결론을 정리해요. 걱정되면 <b>30회</b>나 <b>60회</b>로 낮춰요.</li>
  <li>Claude·ChatGPT 구독은 <b>사용량 한도</b>가 있어요. 호출이 많으면 한도가 빨리 줄어요. 처음엔 <b>라운드 1~2</b>, <b>3명</b>으로 시험하세요.</li>
  <li>첨부 파일은 <b>부를 때마다 다시 들어가요</b>. 큰 파일은 호출 수가 많을수록 부담이 커져요. 필요한 부분만 올리세요.</li>
  <li>회의는 <b>동시에 2개까지</b>만 돌아가요.</li>
</ul>

<h2 id="help">막혔어요! (문제 해결)</h2>
<p>먼저 <b>빨간 카드에 적힌 글</b>을 읽어 보세요. 아래에서 비슷한 걸 눌러 보면 해결 방법이 나와요.</p>

<details><summary>zip 파일이 "올바르지 않다"고 나와요</summary><p>받는 도중에 파일이 깨진 거예요. <b>다시 받아 보세요.</b> 받은 파일 크기가 보내 준 것과 같은지(약 33MB) 확인하세요. 그래도 안 되면 알려 주세요.</p></details>
<details><summary>"Windows의 PC 보호" 파란 창이 떠요</summary><p><b>추가 정보 → 실행</b>을 누르세요. 직접 만든 프로그램에 Windows가 처음 보여 주는 정상 안내예요.</p></details>
<details><summary>검은 창은 떴는데 인터넷 창이 안 열려요</summary><p>인터넷 창(크롬 등)을 직접 열고 주소 칸에 <code>localhost:3000</code> 을 쓰고 <kbd>Enter</kbd>.</p></details>
<details><summary>"포트 3000이 이미 사용 중입니다"</summary><p>프로그램이 이미 켜져 있는 거예요. 이미 열린 검은 창을 모두 닫고 다시 켜세요. 그래도 같으면 <code>.env</code> 맨 아래에 <code>PORT=3001</code> 이라고 쓰고 저장한 뒤 다시 켜고, 주소는 <code>localhost:3001</code> 로 들어가세요.</p></details>
<details><summary>카드에 "설정이 필요합니다" 빨간 글씨가 있어요</summary><p>그 AI가 아직 연결되지 않았다는 뜻이에요. Claude는 ②, ChatGPT는 ③, Gemini는 ④를 다시 확인하세요. 하고 나서 <b>프로그램을 껐다가 다시 켜세요.</b> (연결된 AI만으로도 회의는 돼요. 연결 안 된 자리는 건너뛰어요.)</p></details>
<details><summary>"claude 라는 말은 이름이 인식되지 않습니다" / "codex …"</summary><p>설치는 됐는데 컴퓨터가 위치를 모르는 거예요. ② 아래 노란 칸의 방법을 해 보고, <b>PowerShell과 이 프로그램을 모두 껐다가 다시 켜세요.</b></p></details>
<details><summary>빨간 글: "종료 코드 1 …" 또는 시간 초과 (Claude, ChatGPT 카드)</summary>
<p>대부분 이 중 하나예요.</p>
<ol><li><b>로그인이 풀렸어요</b> → ② 또는 ③의 로그인 단계를 다시 해요.</li>
<li><b>구독 사용량을 다 썼어요</b> → 시간이 지난 뒤(몇 시간 뒤나 다음 날) 다시 해요.</li>
<li><b>처음 한 번 나오는 질문에서 멈췄어요</b> → 파란 창에서 <code>claude</code> 또는 <code>codex</code> 를 직접 켜서 질문에 답한 뒤 나와요.</li>
<li>인터넷이 끊겼어요.</li></ol>
<p>파란 창에서 <code>claude -p "안녕"</code> 이 <b>직접 되는지</b> 보면 원인을 나눌 수 있어요.</p></details>
<details><summary>Gemini 카드에 "429" 또는 "quota" 또는 "limit: 0"</summary>
<p><b>"429"</b>는 "너무 빨리 많이 불렀어요"라는 뜻이에요. <b>1분쯤 기다렸다가</b> 다시 하세요. 참가자를 줄이거나 라운드를 줄이면 덜 걸려요.</p>
<p><b>"limit: 0"</b> 은 "그 모델은 무료로 못 써요"라는 뜻이에요. 모델 칸을 <b>"자동"</b>으로 바꾸세요. 이 프로그램이 <b>무료로 되는 가벼운 모델(flash-lite)을 먼저</b> 써 봐요.</p></details>
<details><summary>Gemini 카드에 "404" 또는 "no longer available" 또는 "model not found"</summary><p>고른 모델이 이 계정에서는 못 쓰는 거예요. 모델 칸을 <b>"자동"</b>으로 바꾸거나, 목록에서 <b>flash-lite</b>가 들어간 모델을 고르세요. 그리고 <code>.env</code> 에 <code>GEMINI_MODEL=</code> 줄이 있으면 <b>그 줄을 지우세요</b>.</p></details>
<details><summary>카드에 "401" 또는 "invalid api key"</summary><p>열쇠가 틀렸거나 지워진 거예요. ④처럼 새 열쇠를 만들어 <code>.env</code> 를 고치고 다시 켜세요. 앞뒤에 빈칸이나 따옴표가 없는지 보세요.</p></details>
<details><summary>"이미 회의가 2개 진행 중입니다"</summary><p>회의가 아직 돌고 있어요. 끝나길 기다리거나 <b>중단</b>을 누르세요.</p></details>
<details><summary>회의가 너무 오래 걸려요</summary><p>AI를 부르는 횟수가 많아서예요. <b>라운드를 1~2</b>로, <b>참가자를 3명</b>으로 줄여 보세요. 시작 버튼 위 "예상 AI 호출"을 보세요. Claude·ChatGPT는 한 번 부를 때 10~60초 걸려요.</p></details>
<details><summary>화면이 이상해요 / 예전 모습이에요</summary><p>인터넷 창에서 <kbd>Ctrl</kbd>+<kbd>F5</kbd> 를 눌러요.</p></details>
<details><summary>회의 기록은 어디 있어요?</summary><p>프로그램 폴더(AI-Council.exe가 있는 곳) 안의 <b>회의록</b> 폴더에 <b>날짜_시각_질문.md</b> 파일이 있어요. 메모장으로 열 수 있어요. 기록이 남는 게 싫으면 왼쪽 아래 <b>"회의록 자동 저장"</b> 체크를 풀어요.</p></details>
<details><summary>백신 프로그램이 막아요</summary><p>직접 만든 프로그램이라 백신이 의심할 수 있어요. 받은 곳을 믿을 수 있을 때만 <b>예외로 허용</b>하세요.</p></details>
<details><summary>파일 첨부가 안 돼요</summary><p>지원 형식(글, 표, PDF, 워드)인지 확인하세요. <b>글자 없는 스캔 PDF</b>와 사진은 못 읽어요. 용량이 가득 차면 필요 없는 첨부를 × 로 지우세요. 엑셀·파워포인트는 <b>📁 폴더</b>로 읽어요.</p></details>

<div class="box">
<b>그래도 안 되면:</b> <b>검은 창에 적힌 글</b>과 <b>빨간 카드의 글</b>을 사진으로 찍어(열쇠가 보이지 않게 가리고!) 알려 주세요. 가장 빨리 원인을 찾을 수 있어요.</div>

<h2 id="words">낱말 풀이</h2>
<table>
  <tr><th>낱말</th><th>쉬운 뜻</th></tr>
  <tr><td>AI</td><td>글을 읽고 쓰고 생각을 말해 주는 똑똑한 프로그램. (Claude, ChatGPT, Gemini …)</td></tr>
  <tr><td>구독</td><td>한 달에 정해진 돈을 내고 쓰는 것.</td></tr>
  <tr><td>CLI (claude, codex)</td><td>검은/파란 글자 창에서 쓰는 작은 프로그램. 이 프로그램이 대신 눌러 줘요. 로그인한 내 구독으로 AI를 불러요.</td></tr>
  <tr><td>API 키 (열쇠)</td><td>AI 회사가 "이 사람은 써도 돼요"라고 주는 긴 비밀 글자. 비밀번호처럼 지켜요.</td></tr>
  <tr><td>혼합</td><td>열쇠가 있는 AI는 열쇠로, 없는 AI는 로그인한 프로그램으로 부르는 방식.</td></tr>
  <tr><td>모델</td><td>AI의 "종류/버전". 같은 회사 안에도 큰 것, 가벼운 것이 있어요. (flash-lite = 가볍고 빠른 모델)</td></tr>
  <tr><td>라운드</td><td>모두가 한 번씩 돌아가며 말하는 것 한 바퀴.</td></tr>
  <tr><td>합의</td><td>모두가 같은 결론에 찬성하는 것.</td></tr>
  <tr><td>호출</td><td>AI에게 한 번 물어보는 것. 호출이 많을수록 시간이 걸리고 한도가 줄어요.</td></tr>
  <tr><td>PowerShell / 명령 프롬프트</td><td>글자로 컴퓨터에 명령하는 창. 파란 창 / 검은 창.</td></tr>
  <tr><td><code>.env</code></td><td>이 프로그램의 설정 메모. 열쇠를 여기에 써요.</td></tr>
</table>

<h2>어른용 메모 (Mac · Linux · 개발자)</h2>
<ul>
  <li>Linux: 실행 권한을 주고 실행해요. <code>chmod +x ai-council-linux-x64 &amp;&amp; ./ai-council-linux-x64</code></li>
  <li>macOS: 서명 문제로 macOS에서 직접 빌드해야 해요(GitHub Actions의 <i>Build executables</i> 사용). 막히면 우클릭 → 열기.</li>
  <li>소스로 실행(Node.js 18+): <code>cp .env.example .env</code> 후 <code>npm start</code> → <code>http://localhost:3000</code>. 시험은 <code>npm test</code>, 연습용 가짜 답변은 <code>npm run demo</code>.</li>
  <li>설정 항목은 <code>.env.example</code> 참고(<code>MAX_CALLS</code>, <code>NO_MINUTES</code>, <code>MINUTES_DIR</code>, <code>PORT</code>, 다른 AI 열쇠 등). 자세한 구조는 <code>README.md</code>.</li>
  <li>이 프로그램은 <code>127.0.0.1</code>(내 컴퓨터)에서만 열려요. 질문과 파일 내용은 선택한 AI 회사로 전송돼요. 회의록에는 질문과 AI 답변이 일반 글자 파일로 남아요.</li>
  <li><b>Windows 실행파일과 실제 AI 연결은 제작 환경에서 직접 확인하지 못했어요.</b> 문제가 생기면 검은 창의 글을 알려 주세요.</li>
</ul>

</main>
</body>
</html>
'''

HTML = HTML.replace('@@OVERVIEW@@', img('overview.jpg')).replace('@@RESULT@@', img('result.jpg')).replace('@@TEAM@@', img('team.jpg'))
(root / 'docs' / 'guide.html').write_text(HTML, encoding='utf-8')
print('guide.html', len(HTML) // 1024, 'KB')
