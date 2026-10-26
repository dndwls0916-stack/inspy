// 첫 실행 설정(키 저장·연결 확인·쓰기 점검) 검증. 실행: npm test
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.MOCK = '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-'));
process.env.ENV_FILE = path.join(tmp, '.env');
process.env.MINUTES_DIR = path.join(tmp, 'm');
process.env.PROFILE_FILE = path.join(tmp, '회사정보.md');
const setup = require('../lib/setup');

// 줄 단위 교체: 다른 줄과 주석은 그대로, 빈 줄(OPENAI_API_KEY=)은 채우고, 없는 키는 덧붙인다
fs.writeFileSync(process.env.ENV_FILE, '# 설정\nOPENAI_API_KEY=\nGEMINI_API_KEY=old\nPORT=3000\n');
setup.writeEnvLine(process.env.ENV_FILE, 'OPENAI_API_KEY', 'sk-test-12345678');
setup.writeEnvLine(process.env.ENV_FILE, 'ANTHROPIC_API_KEY', 'ant-test-12345678');
let t = fs.readFileSync(process.env.ENV_FILE, 'utf8');
assert(t.startsWith('# 설정\nOPENAI_API_KEY=sk-test-12345678\nGEMINI_API_KEY=old\nPORT=3000\n') && t.includes('ANTHROPIC_API_KEY=ant-test-12345678'));
assert.equal((t.match(/OPENAI_API_KEY/g) || []).length, 1);
setup.writeEnvLine(process.env.ENV_FILE, 'GEMINI_API_KEY', null);
assert(fs.readFileSync(process.env.ENV_FILE, 'utf8').includes('GEMINI_API_KEY=\n'));

// 검증과 허용 목록
assert.throws(() => setup.validateKey(''), /입력/);
assert.throws(() => setup.validateKey('짧음'), /길이/);
assert.throws(() => setup.validateKey('abc def ghijk'), /공백/);
assert.throws(() => setup.validateKey('abcdefgh"ij'), /공백/);
assert.throws(() => setup.setKey('nope', 'abcdefghijk'), /저장할 수 없는/);
assert.throws(() => setup.setKey('ollama', 'abcdefghijk'), /저장할 수 없는/, '키가 필요 없는 AI 는 대상이 아니다');
assert(!Object.values(setup.keyNames()).includes('PATH'));

// 키 저장 → 환경에 즉시 반영, 제거
delete process.env.GROQ_API_KEY;
setup.setKey('groq', 'gsk_abcdefghijkl');
assert.equal(process.env.GROQ_API_KEY, 'gsk_abcdefghijkl');
setup.setKey('groq', null);
assert.equal(process.env.GROQ_API_KEY, undefined);
assert(setup.scrub('오류 gsk_zzzzzzzzzzzz 와 sk-abcdefghijklmnop').includes('sk-…'));
process.env.OPENAI_API_KEY = 'sk-live-secretsecret';
assert(!setup.scrub('실패: Bearer sk-live-secretsecret 거절').includes('secretsecret'));

// 쓰기 점검
const c = setup.checks({ minutesDir: process.env.MINUTES_DIR, profileFile: process.env.PROFILE_FILE });
assert(c.env.ok && c.minutes.ok && c.profile.ok);
const blocker = path.join(tmp, 'afile'); fs.writeFileSync(blocker, 'x');
assert.equal(setup.checks({ minutesDir: path.join(blocker, 'sub'), profileFile: process.env.PROFILE_FILE }).minutes.ok, false, '폴더를 만들 수 없으면 실패로 알린다');

const { server } = require('../server');
server.listen(0, '127.0.0.1', async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (u, b, h) => fetch(base + u, { method: 'POST', headers: h, body: JSON.stringify(b) });
  try {
    const st = await (await fetch(`${base}/api/setup`)).json();
    assert(st.checks.minutes.ok && st.providers.find((p) => p.id === 'gpt').canSetKey && !st.providers.find((p) => p.id === 'ollama').canSetKey);
    assert(!JSON.stringify(st).includes('sk-live-secretsecret'), '키 값은 내려보내지 않는다');
    let r = await post('/api/setup/key', { provider: 'claude', key: 'ant-new-key-1234567' });
    assert.equal(r.status, 200);
    assert.equal(process.env.ANTHROPIC_API_KEY, 'ant-new-key-1234567');
    assert(!(await r.text()).includes('ant-new-key'));
    r = await post('/api/setup/key', { provider: 'claude', remove: true });
    assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
    assert.equal((await post('/api/setup/key', { provider: 'claude', key: 'x y' })).status, 400);
    assert.equal((await post('/api/setup/key', { provider: 'PATH', key: 'abcdefghijk' })).status, 400);
    assert.equal((await post('/api/setup/key', { provider: 'gpt', key: 'abcdefghijk' }, { origin: 'http://evil.example' })).status, 403, '다른 사이트에서는 못 보낸다');
    const t1 = await (await post('/api/setup/test', { provider: 'gpt', mode: 'api' })).json();
    assert(t1.ok && typeof t1.ms === 'number');
    assert.equal((await post('/api/setup/test', { provider: 'nope' })).status, 400);
    assert.equal((await post('/api/setup/test', { provider: 'deepseek', mode: 'cli' })).status, 400);
    const cfg = await (await fetch(`${base}/api/config`)).json();
    assert.equal(cfg.setupNeeded, false);
    console.log('setup.js: ok');
  } catch (e) { console.error(e); process.exitCode = 1; } finally { server.close(); }
});
