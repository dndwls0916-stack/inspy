// CLI 모드 검증: 가짜 claude/codex/gemini 실행 파일로 stdin·인자·오류 처리를 확인한다. 실행: npm run test:cli
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fakecli-'));
const fake = (name, body) => {
  const f = path.join(dir, name);
  fs.writeFileSync(f, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return f;
};
// 인자와 stdin 첫 줄을 그대로 돌려주는 가짜 CLI
process.env.CLAUDE_BIN = fake('claude', 'IN=$(cat); echo "claude args=[$*] stdin_has_question=$(echo "$IN" | grep -c Q-MARK)"');
process.env.CODEX_BIN = fake('codex', 'cat >/dev/null; echo "codex args=[$*]"');
process.env.GEMINI_BIN = fake('gemini', 'cat >/dev/null; echo "boom" >&2; exit 3'); // 실패하는 CLI
delete process.env.MOCK;
for (const k of ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY']) delete process.env[k];

const { server } = require('../server');
const { buildSpawn, pickWinBin, PROVIDERS } = require('../lib/providers');

// --- Windows 실행 계획(순수 함수) 검증: 실제 Windows 가 없어도 인자 처리 규칙을 확인한다 ---
{
  const lin = buildSpawn('/usr/bin/claude', ['-p', '--model', 'a b'], 'linux');
  assert.deepEqual(lin, { cmd: '/usr/bin/claude', args: ['-p', '--model', 'a b'], shell: false }, '리눅스는 셸 없이 그대로');
  const exe = buildSpawn('C:\\Users\\me\\claude.exe', ['-p'], 'win32');
  assert.equal(exe.shell, false, '.exe 는 셸 없이');
  const cmd = buildSpawn('C:\\Users\\내 이름\\npm\\gemini.cmd', ['-m', 'gemini-2.5-pro', '-p', 'Answer the request. Use Korean.'], 'win32');
  assert.equal(cmd.shell, true, '.cmd 는 셸 필요');
  assert.equal(cmd.cmd, '"C:\\Users\\내 이름\\npm\\gemini.cmd" -m gemini-2.5-pro -p "Answer the request. Use Korean."', '공백/한글 경로와 공백 있는 인자만 따옴표');
  assert.deepEqual(cmd.args, [], '셸 명령은 문자열 하나');
  for (const bad of ['x & calc', 'x"y', 'a|b', 'a;b', '$(id)', 'a`b', 'a%PATH%', 'a>b']) {
    assert.throws(() => buildSpawn('g.cmd', ['-m', bad], 'win32'), /사용할 수 없는 문자/, `차단: ${bad}`);
  }
  assert.equal(pickWinBin(['C:\\n\\gemini', 'C:\\n\\gemini.cmd']), 'C:\\n\\gemini.cmd', '확장자 없는 sh 스크립트 제외');
  assert.equal(pickWinBin(['C:\\n\\claude.cmd', 'C:\\b\\claude.exe']), 'C:\\b\\claude.exe', '.exe 우선');
  assert.equal(pickWinBin(['C:\\n\\gemini']), null);
  // 실제 고정 인자는 모두 통과해야 한다
  for (const id of Object.keys(PROVIDERS)) buildSpawn('x.cmd', PROVIDERS[id].cli.args('some-model_1.5:pro'), 'win32');
  console.log('OK: Windows 실행 계획 규칙');
}

async function sse(res) {
  const events = [];
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6)));
    }
  }
  return events;
}

server.listen(0, '127.0.0.1', async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body) => fetch(`${base}/api/council`, { method: 'POST', body: JSON.stringify(body) });
  try {
    const cfg = await (await fetch(`${base}/api/config`)).json();
    assert(cfg.providers.every((p) => p.cliAvailable && !p.apiConfigured), 'CLI만 사용 가능');

    // API 모드인데 키가 없으면 거절
    assert.equal((await post({ question: 'Q', participants: [{ id: 'claude' }], mode: 'api' })).status, 400);

    // CLI 모드: claude 성공, gemini 실패(회의는 계속), 사회자는 claude
    const res = await post({ question: 'Q-MARK', participants: [{ id: 'claude', model: 'm1' }, { id: 'gpt' }, { id: 'gemini' }], rounds: 1, moderator: 'claude', mode: 'cli' });
    const ev = await sse(res);
    const claude = ev.find((e) => e.type === 'turn' && e.who === 'claude');
    assert(claude.text.includes('args=[-p --model m1]'), claude.text);
    assert(claude.text.includes('stdin_has_question=1'), 'stdin 으로 질문 전달');
    const gpt = ev.find((e) => e.type === 'turn' && e.who === 'gpt');
    assert(gpt.text.includes('args=[exec --skip-git-repo-check -s read-only -]'), gpt.text); // 모델 비움 -> -m 없음
    const err = ev.find((e) => e.type === 'turn_error' && e.who === 'gemini');
    assert(err && err.error.includes('종료 코드 3') && err.error.includes('boom'), JSON.stringify(err));
    assert(ev.some((e) => e.type === 'final' && e.who === 'claude'));
    console.log('OK: CLI 모드 정상');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
