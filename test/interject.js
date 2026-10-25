// 회의 중 사람 끼어들기·결론 요청 검증. 실행: npm test
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.MOCK = '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'interject-'));
process.env.MINUTES_DIR = path.join(tmp, 'm');
process.env.PROFILE_FILE = path.join(tmp, 'p.md');
const { server } = require('../server');
const { listMinutes } = require('../lib/minutes');

server.listen(0, '127.0.0.1', async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (u, b) => fetch(base + u, { method: 'POST', body: JSON.stringify(b) });
  // 회의를 흘려 읽으면서 onEvent 에서 끼어들 수 있게 한다.
  async function meet(body, onEvent) {
    const res = await post('/api/council', { question: 'Q', moderator: 'claude', mode: 'api', participants: [{ id: 'gpt' }, { id: 'claude' }], ...body });
    const events = [];
    let id = null, buf = '';
    for await (const c of res.body) {
      buf += Buffer.from(c).toString();
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const l = buf.slice(0, i); buf = buf.slice(i + 2);
        if (!l.startsWith('data: ')) continue;
        const ev = JSON.parse(l.slice(6));
        events.push(ev);
        if (ev.type === 'meeting') id = ev.id;
        await onEvent?.(ev, id);
      }
    }
    return events;
  }
  try {
    // 1) 고정 2라운드: 1라운드 중에 한마디 → 2라운드 발언과 최종 결론 프롬프트에 전달된다
    let sent = false;
    let ev = await meet({ rounds: 2, question: '연락 010-1234-5678 확인' }, async (e, id) => {
      if (e.type === 'turn' && !sent) {
        sent = true;
        const r = await post('/api/council/say', { id, text: '비용 상한은 100만원입니다. 담당자 010-9999-8888' });
        assert.equal(r.status, 200);
      }
    });
    const ij = ev.find((e) => e.type === 'interject');
    assert(ij && ij.text.includes('비용 상한') && !ij.text.includes('9999'), '끼어들기 이벤트(개인정보는 가려서)');
    const r1 = ev.filter((e) => e.type === 'turn' && e.round === 1);
    const r2 = ev.filter((e) => e.type === 'turn' && e.round === 2);
    assert(r1.length && r2.length && r2.every((t) => t.text.includes('진행자 말 반영')), '2라운드 발언에 반영');
    assert(!r1.some((t) => t.text.includes('진행자 말 반영')), '1라운드는 이미 시작됐으니 반영 안 됨');
    assert(ev.find((e) => e.type === 'final').text.includes('진행자말전달'), '최종 결론에 전달');

    // 2) 합의 모드: 결론 요청 → 다음 라운드를 열지 않고 마무리
    sent = false;
    ev = await meet({ consensus: true, maxRounds: 6, rounds: 6 }, async (e, id) => {
      if (e.type === 'turn' && !sent) { sent = true; assert.equal((await post('/api/council/say', { id, wrapUp: true })).status, 200); }
    });
    assert(ev.some((e) => e.type === 'wrapup'));
    assert.equal(ev.filter((e) => e.type === 'round').length, 1, '1라운드 뒤 바로 결론');
    const fin = ev.find((e) => e.type === 'final');
    assert(fin.text.includes('결론요청') && fin.consensus && !fin.consensus.reached && fin.consensus.reason.includes('진행자'));

    // 3) 합의가 났어도 그 사이 새 의견이 있으면 한 번 더 확인
    sent = false;
    ev = await meet({ consensus: true, maxRounds: 8, rounds: 8 }, async (e, id) => {
      if (e.type === 'turn' && e.round === 3 && !sent) { sent = true; await post('/api/council/say', { id, text: '안전이 비용보다 우선입니다' }); }
    });
    const rounds = ev.filter((e) => e.type === 'round').length;
    assert(rounds >= 4, `새 의견 때문에 합의 라운드(3) 뒤에 한 번 더 진행: ${rounds}`);
    assert(ev.find((e) => e.type === 'final').consensus.reached, '결국 합의');

    // 4) 입력 검사
    assert.equal((await post('/api/council/say', { id: 'nope', text: 'x' })).status, 404, '없는 회의');
    sent = false;
    await meet({ rounds: 1 }, async (e, id) => {
      if (e.type === 'meeting') {
        assert.equal((await post('/api/council/say', { id, text: '   ' })).status, 400, '빈 말');
        assert.equal((await post('/api/council/say', { id, text: 'a'.repeat(1501) })).status, 400, '너무 긴 말');
        for (let i = 0; i < 10; i++) assert.equal((await post('/api/council/say', { id, text: `말${i}` })).status, 200);
        assert.equal((await post('/api/council/say', { id, text: '열한 번째' })).status, 400, '회의당 10번까지');
      }
    });
    // 회의가 끝나면 끼어들 수 없다
    assert.equal((await post('/api/council/say', { id: ev.find((e) => e.type === 'meeting').id, text: '늦음' })).status, 404);

    // 5) 회의록에 남는다
    const withNote = listMinutes(process.env.MINUTES_DIR, { q: '' });
    const md = fs.readdirSync(process.env.MINUTES_DIR).filter((f) => f.endsWith('.md')).map((f) => fs.readFileSync(path.join(process.env.MINUTES_DIR, f), 'utf8')).join('\n');
    assert(md.includes('진행자(사람)의 한마디') && md.includes('결론 정리를 요청'), '회의록에 끼어들기와 결론 요청이 남는다');
    assert(withNote.length >= 4);
    console.log('interject.js: ok');
  } catch (e) { console.error(e); process.exitCode = 1; } finally { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
});
