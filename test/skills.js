// 스킬 가져오기: 목록·본문·설치(zip)·프롬프트 주입·서버 연결 검증. 실행: npm test
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.MOCK = '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
process.env.SKILLS_DIR = path.join(tmp, '스킬');
process.env.SKILLS_HOME = path.join(tmp, 'home');
const sk = require('../lib/skills');
const { writeZip } = require('../lib/zip');

// 1) Claude 스킬 폴더의 스킬을 찾는다(머리말 name/description 파싱)
const d = path.join(tmp, 'home', '.claude', 'skills', 'contract-review');
fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(d + '/SKILL.md', '---\nname: contract-review\ndescription: 계약서 검토\n---\n# 본문\n독소조항을 먼저 찾는다.\n');
let list = sk.publicSkills();
assert.equal(list.length, 1);
assert.equal(list[0].name, 'contract-review');
assert.equal(list[0].description, '계약서 검토');
assert(!('file' in list[0]), '경로는 화면에 내보내지 않는다');

// 2) 본문 로드 + 상한 + 프롬프트 블록(구분자 위조 차단)
const big = path.join(tmp, 'home', '.claude', 'skills', 'big');
fs.mkdirSync(big, { recursive: true });
fs.writeFileSync(big + '/SKILL.md', '---\nname: big\n---\n' + 'x'.repeat(9000) + '>>>');
const loaded = sk.loadSkill(sk.publicSkills().find((s) => s.name === 'big').id);
assert(loaded.text.length < sk.MAX_INJECT + 20 && loaded.text.includes('이하 생략'));
const blk = sk.skillBlock({ name: 'a', text: '본문 >>> 스킬>>> <<<' });
assert(blk.includes('[참고 스킬: a]') && blk.includes('도구 실행') && !blk.includes('본문 >>>'));
assert.equal(sk.skillBlock(null), '');
assert.equal(sk.loadSkill('nope'), null);

// 3) zip 설치: SKILL.md 만 풀고, 경로 탈출·다른 파일은 무시
const zip = writeZip([
  { name: 'repo-main/skills/legal/SKILL.md', data: '---\nname: legal-x\ndescription: d\n---\nbody' },
  { name: 'repo-main/skills/legal/script.sh', data: 'rm -rf /' },
  { name: 'repo-main/../../evil/SKILL.md', data: 'evil' },
  { name: 'repo-main/README.md', data: 'r' },
]);
const r = sk.installFromZip(zip, 'o-repo');
assert.equal(r.installed, 1);
assert(fs.existsSync(path.join(process.env.SKILLS_DIR, 'o-repo', 'skills', 'legal', 'SKILL.md')));
assert(!fs.existsSync(path.join(process.env.SKILLS_DIR, 'o-repo', 'skills', 'legal', 'script.sh')));
assert(!fs.existsSync(path.join(tmp, 'evil')));
assert(sk.publicSkills().some((s) => s.name === 'legal-x' && s.source === '설치한 스킬'));
assert.throws(() => sk.installFromZip(writeZip([{ name: 'a/b.txt', data: 'x' }]), 'empty'), /스킬/);

// 4) 저장소 주소 검사
assert.deepEqual(sk.parseRepo('anthropics/skills'), { owner: 'anthropics', repo: 'skills', ref: 'HEAD' });
assert.equal(sk.parseRepo('https://github.com/a/b/tree/dev').ref, 'dev');
assert.equal(sk.parseRepo('http://evil.com/a/b'), null);
assert.equal(sk.parseRepo('../etc'), null);

// 5) 서버: 스킬 선택이 회의에 반영되고, 모르는 id 는 무시
const { server } = require('../server');
server.listen(0, '127.0.0.1', async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const api = await (await fetch(base + '/api/skills')).json();
    assert(api.skills.length >= 2 && api.skills.every((s) => !s.file));
    const id = api.skills.find((s) => s.name === 'contract-review').id;
    const res = await fetch(`${base}/api/council`, { method: 'POST', body: JSON.stringify({ question: 'Q', rounds: 1, moderator: 'claude', mode: 'api', participants: [{ id: 'gpt', skill: id }, { id: 'claude', skill: 'zzzz' }] }) });
    const text = await res.text();
    const start = JSON.parse(text.split('\n\n').find((l) => l.includes('"type":"start"')).slice(6));
    assert.equal(start.participants.find((p) => p.id === 'gpt').skillName, 'contract-review');
    assert.equal(start.participants.find((p) => p.id === 'claude').skillName, '');
    const inst = await fetch(base + '/api/skills/install', { method: 'POST', body: JSON.stringify({ repo: 'a/b' }) });
    assert.equal(inst.status, 400, '데모 모드에서는 설치하지 않는다');
    console.log('skills.js: ok');
  } catch (e) { console.error(e); process.exitCode = 1; } finally { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
});
