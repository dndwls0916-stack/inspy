const fs = require('fs');
const path = require('path');

// 실행 중인 위치: 단일 실행파일이면 실행파일이 있는 폴더, 아니면 프로젝트 폴더
function appDir() {
  let sea = false;
  try {
    sea = require('node:sea').isSea();
  } catch {}
  return sea ? path.dirname(process.execPath) : path.join(__dirname, '..');
}

// 의존성 없이 .env 를 읽는다. 이미 설정된 환경변수는 덮어쓰지 않는다.
function loadEnv(file = path.join(appDir(), '.env')) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (/^(['"]).*\1$/.test(val)) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

module.exports = { loadEnv, appDir };
