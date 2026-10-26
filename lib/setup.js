// 첫 실행 설정: 화면에서 API 키를 .env 에 저장하고, 연결과 저장 폴더 쓰기 권한을 점검한다.
// 키는 한 번 받아서 파일과 이 프로그램의 환경에만 넣고, 어떤 응답에도 다시 내려보내지 않는다.
const fs = require('fs');
const path = require('path');
const { appDir } = require('./env');
const { PROVIDERS } = require('./providers');

const envFile = () => process.env.ENV_FILE || path.join(appDir(), '.env');
// 키를 받을 수 있는 이름: 키가 필요한 AI 의 환경변수뿐(임의의 환경변수를 쓰지 못하게 한다)
const keyNames = () => Object.fromEntries(Object.entries(PROVIDERS).filter(([, p]) => p.keyEnv && !p.keyless).map(([id, p]) => [id, p.keyEnv]));

function validateKey(key) {
  const k = String(key ?? '').trim();
  if (!k) throw new Error('키를 입력하세요');
  if (k.length < 8 || k.length > 400) throw new Error('키 길이가 올바르지 않습니다');
  if (!/^[\x21-\x7e]+$/.test(k) || /["'`]/.test(k)) throw new Error('키에는 공백·한글·따옴표가 들어갈 수 없습니다. 복사한 키를 그대로 붙여 넣으세요');
  return k;
}

// .env 의 해당 줄만 바꾸고 나머지는 그대로 둔다. value 가 null 이면 그 줄을 비운다.
function writeEnvLine(file, name, value) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text ? text.split(/\r?\n/) : [];
  const re = new RegExp(`^\\s*${name}\\s*=`);
  const line = `${name}=${value ?? ''}`;
  let hit = false;
  const out = lines.map((l) => (re.test(l) ? (hit = true, line) : l));
  if (!hit) { if (out.length && out[out.length - 1] === '') out.splice(out.length - 1, 0, line); else out.push(line, ''); }
  fs.writeFileSync(file, out.join(nl), { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {} // 키가 들어 있으니 다른 사용자가 못 읽게(Windows 에서는 무시됨)
}

function setKey(provider, key) {
  const name = keyNames()[provider];
  if (!name) throw new Error('키를 저장할 수 없는 AI 입니다');
  const k = key == null || key === '' ? null : validateKey(key);
  try { writeEnvLine(envFile(), name, k); }
  catch (e) { throw new Error(`설정 파일(.env)에 쓰지 못했습니다(${e.code || '오류'}). 이 폴더에 쓰기 권한이 있는지 확인하거나, 파일을 직접 편집하세요: ${envFile()}`); }
  if (k) process.env[name] = k; else delete process.env[name];
}

function writable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-test-${process.pid}`);
    fs.writeFileSync(probe, 'x');
    fs.unlinkSync(probe);
    return true;
  } catch { return false; }
}
function checks({ minutesDir, profileFile }) {
  return {
    env: { path: envFile(), ok: writable(path.dirname(envFile())) },
    minutes: { path: minutesDir, ok: writable(minutesDir) },
    profile: { path: profileFile, ok: writable(path.dirname(profileFile)) },
  };
}

// 오류 문구에 키가 섞여 나가지 않게 지운다
function scrub(text) {
  let s = String(text ?? '');
  for (const name of Object.values(keyNames())) { const v = process.env[name]; if (v && v.length >= 8) s = s.split(v).join('[키]'); }
  return s.replace(/(sk-|AIza|key=)[A-Za-z0-9_\-]{8,}/g, '$1…');
}

module.exports = { envFile, keyNames, validateKey, writeEnvLine, setKey, checks, scrub };
