// 데모(MOCK) 모드로 서버를 띄워 전체 회의 흐름을 검증한다. 실행: npm test
const assert = require('assert');
process.env.MOCK = '1';
const { server } = require('../server');

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
  try {
    const cfg = await (await fetch(`${base}/api/config`)).json();
    assert.equal(cfg.providers.length, 3);

    const bad = await fetch(`${base}/api/council`, { method: 'POST', body: JSON.stringify({ question: '' }) });
    assert.equal(bad.status, 400);

    const res = await fetch(`${base}/api/council`, {
      method: 'POST',
      body: JSON.stringify({ question: '테스트 질문', participants: [{ id: 'gpt' }, { id: 'gemini' }, { id: 'claude' }], rounds: 2, moderator: 'claude' }),
    });
    const events = await sse(res);
    const turns = events.filter((e) => e.type === 'turn');
    assert.equal(turns.length, 6, '3명 x 2라운드');
    assert.equal(events.filter((e) => e.type === 'final').length, 1);
    assert.equal(events.at(-1).type, 'done');

    // 삼국지 모드: 말투 지침이 전달되고, 꺼져 있으면 전달되지 않는다.
    const sg = await sse(await fetch(`${base}/api/council`, { method: 'POST', body: JSON.stringify({ question: 'Q', participants: [{ id: 'gpt' }], rounds: 1, persona: true }) }));
    assert(sg.find((e) => e.type === 'turn').text.includes('(사극 말투)'), '삼국지 모드 말투');
    assert(!turns[0].text.includes('(사극 말투)'), '일반 모드에는 말투 없음');
    const sage = sg.find((e) => e.type === 'sage');
    assert(sage && sage.text.includes('한 줄 요약'), '제갈량의 한마디');
    assert(sg.findIndex((e) => e.type === 'final') < sg.findIndex((e) => e.type === 'sage'), '결단 뒤에 한마디');
    assert(!events.some((e) => e.type === 'sage'), '일반 모드에는 제갈량 없음');
    assert(cfg.sage.name === '제갈량');
    assert(cfg.providers.every((p) => p.persona?.name), '캐릭터 정보');

    assert.equal((await fetch(`${base}/`)).status, 200);
    assert.equal((await fetch(`${base}/../server.js`)).status, 404);
    console.log('OK: 회의 흐름 정상 (turns=%d)', turns.length);
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});
