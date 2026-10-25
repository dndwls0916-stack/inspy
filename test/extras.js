// 사전 부검, 데이터 백업·옮기기 검증. 실행: npm test
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.MOCK = '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'extras-'));
process.env.PROFILE_FILE = path.join(tmp, '회사정보.md');
process.env.MINUTES_DIR = path.join(tmp, 'm');
const { writeZip } = require('../lib/zip');
const { estimate } = require('../lib/estimate');
const backup = require('../lib/backup');

assert.equal(estimate({ n: 2, premortem: true }).calls.max, estimate({ n: 2 }).calls.max + 1, '사전 부검은 호출 1회를 더한다');
assert.equal(estimate({ n: 2, premortem: true, maxCalls: 10 }).calls.max, estimate({ n: 2, maxCalls: 10 }).calls.max + (estimate({ n: 2 }).calls.max < 10 ? 1 : 0));

const { server } = require('../server');
server.listen(0, '127.0.0.1', async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const meet = async (extra) => {
    const res = await fetch(`${base}/api/council`, { method: 'POST', body: JSON.stringify({ question: '사전부검 시험', rounds: 1, moderator: 'claude', mode: 'api', participants: [{ id: 'gpt' }, { id: 'claude' }], ...extra }) });
    return (await res.text()).split('\n\n').filter((c) => c.startsWith('data: ')).map((c) => JSON.parse(c.slice(6)));
  };
  try {
    // 사전 부검: 기본은 꺼짐, 켜면 결론 뒤에 한 번, 회의록에 저장
    let evs = await meet({});
    assert(!evs.some((e) => e.type === 'premortem'), '기본은 사전 부검 없음');
    evs = await meet({ premortem: true });
    const iF = evs.findIndex((e) => e.type === 'final'), iP = evs.findIndex((e) => e.type === 'premortem');
    assert(iF >= 0 && iP > iF, '결론 뒤에 사전 부검');
    assert(evs[iP].text.includes('실패 이유'));
    const plain = await meet({});
    assert.equal(evs.find((e) => e.type === 'usage').calls, plain.find((e) => e.type === 'usage').calls + 1, '사전 부검은 호출 1회');
    const md = fs.readdirSync(process.env.MINUTES_DIR).filter((n) => n.endsWith('.md')).map((n) => fs.readFileSync(path.join(process.env.MINUTES_DIR, n), 'utf8'));
    assert(md.some((t) => t.includes('사전 부검')), '회의록에 사전 부검 저장');
    // 호출 상한에 걸리면 생략하고 이유를 알린다(결론은 그대로)
    const { runCouncil } = require('../lib/council');
    const got = [];
    await runCouncil({ question: 'Q', participants: [{ id: 'gpt' }, { id: 'claude' }], rounds: 1, maxCalls: plain.find((e) => e.type === 'usage').calls, moderator: 'claude', mode: 'api', premortem: true, emit: (e) => got.push(e), signal: new AbortController().signal });
    assert(got.some((e) => e.type === 'final') && !got.some((e) => e.type === 'premortem'));
    assert(got.some((e) => e.type === 'premortem_error' && /상한/.test(e.error)));

    // 백업: 만들기 → 다른 곳에 풀기, 덮어쓰지 않기, 안전하지 않은 이름 거절
    await fetch(`${base}/api/profile`, { method: 'POST', body: JSON.stringify({ text: '우리 회사: 물류' }) });
    const dl = await fetch(`${base}/api/backup`);
    assert.equal(dl.status, 200);
    assert(/attachment; filename="ai-council-backup-\d{8}\.zip"/.test(dl.headers.get('content-disposition')));
    const zip = Buffer.from(await dl.arrayBuffer());
    const { readZip } = require('../lib/zip');
    const z = readZip(zip);
    assert(z.has('backup.json') && z.has('회사정보.md') && z.names().some((n) => n.startsWith('회의록/') && n.endsWith('.jsonl')));
    assert(!z.names().some((n) => /\.env|key/i.test(n)), '키 파일은 넣지 않는다');

    const dest = path.join(tmp, 'other');
    const noProf = { minutesDir: dest, readProfile: () => cur, writeProfile: (t) => { cur = t; } };
    let cur = '';
    let rep = backup.restore(zip, noProf);
    assert(rep.added >= 2 && rep.existing === 0 && rep.profile === 'restored' && cur.includes('물류'));
    rep = backup.restore(zip, noProf);
    assert.equal(rep.added, 0, '두 번째는 덮어쓰지 않는다');
    assert(rep.existing >= 2 && rep.profile === 'same');
    cur = '다른 내용';
    assert.equal(backup.restore(zip, noProf).profile, 'kept', '있는 회사 정보는 덮어쓰지 않는다');

    const evil = writeZip([{ name: 'backup.json', data: '{}' }, { name: '회의록/../evil.md', data: 'x' }, { name: '회의록/a/b.md', data: 'x' }, { name: '회의록/ok.md', data: 'ok' }, { name: '회의록/run.exe', data: 'x' }]);
    rep = backup.restore(evil, { minutesDir: path.join(tmp, 'evil'), readProfile: () => '', writeProfile() {} });
    assert.equal(rep.added, 1); assert.equal(rep.rejected, 3);
    assert(!fs.existsSync(path.join(tmp, 'evil.md')) && !fs.existsSync(path.join(tmp, 'evil', 'evil.md')));
    assert.throws(() => backup.restore(writeZip([{ name: 'x.txt', data: 'x' }]), noProf), /백업 파일이 아닙니다/);
    assert.throws(() => backup.restore(Buffer.from('not a zip'), noProf), /읽지 못했습니다/);

    // 서버 복원 API
    const r1 = await fetch(`${base}/api/backup/restore`, { method: 'POST', headers: { origin: base }, body: zip });
    assert.equal(r1.status, 200);
    assert.equal((await r1.json()).added, 0);
    const r2 = await fetch(`${base}/api/backup/restore`, { method: 'POST', body: Buffer.from('zzz') });
    assert.equal(r2.status, 400);
    console.log('extras ok');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});
