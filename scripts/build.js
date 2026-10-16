// 단일 실행파일 빌드 (Node SEA). 사용법:
//   node scripts/build.js                  현재 OS용
//   node scripts/build.js --target=win-x64 Windows용 (다른 OS에서 교차 빌드 가능)
// 결과: dist/ 폴더. macOS용은 macOS에서 빌드해야 합니다 (서명 필요).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const build = path.join(root, 'build');
const dist = path.join(root, 'dist');
const targetArg = (process.argv.find((a) => a.startsWith('--target=')) || '').slice(9) || 'host';
const isWin = targetArg === 'win-x64';
if (!['host', 'win-x64'].includes(targetArg)) throw new Error(`지원하지 않는 target: ${targetArg}`);
const hostTag = `${process.platform === 'win32' ? 'win' : process.platform}-${os.arch()}`;
const outName = isWin ? 'ai-council-win-x64.exe' : `ai-council-${hostTag}${process.platform === 'win32' ? '.exe' : ''}`;

async function nodeBinary() {
  if (!isWin || process.platform === 'win32') return process.execPath;
  // 블롭은 같은 버전의 Node 와 맞아야 하므로 현재 Node 와 같은 버전의 node.exe 를 받는다.
  const cache = path.join(build, `node-${process.version}-win-x64.exe`);
  if (!fs.existsSync(cache)) {
    const url = `https://nodejs.org/dist/${process.version}/win-x64/node.exe`;
    console.log(`다운로드: ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`다운로드 실패 HTTP ${res.status}`);
    fs.writeFileSync(cache, Buffer.from(await res.arrayBuffer()));
  }
  return cache;
}

(async () => {
  fs.rmSync(build, { recursive: true, force: true });
  fs.mkdirSync(build, { recursive: true });
  fs.mkdirSync(dist, { recursive: true });

  // 1) 서버 코드를 파일 하나로 묶는다
  require('esbuild').buildSync({
    entryPoints: [path.join(root, 'server.js')],
    outfile: path.join(build, 'app.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['node:sea'],
  });

  // 2) 화면 파일과 .env 템플릿을 에셋으로 포함한다
  const assets = { '.env.example': path.join(root, '.env.example') };
  const walk = (dir, rel = '') => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(dir, r);
      else assets[`public/${r}`] = path.join(dir, r);
    }
  };
  walk(path.join(root, 'public'));
  const config = { main: path.join(build, 'app.cjs'), output: path.join(build, 'app.blob'), disableExperimentalSEAWarning: true, assets };
  fs.writeFileSync(path.join(build, 'sea-config.json'), JSON.stringify(config, null, 2));
  execFileSync(process.execPath, ['--experimental-sea-config', path.join(build, 'sea-config.json')], { stdio: 'inherit' });

  // 3) Node 바이너리를 복사해 블롭을 주입한다
  const out = path.join(dist, outName);
  fs.copyFileSync(await nodeBinary(), out);
  fs.chmodSync(out, 0o755);
  const mac = process.platform === 'darwin' && !isWin;
  if (mac) execFileSync('codesign', ['--remove-signature', out]);
  await require('postject').inject(out, 'NODE_SEA_BLOB', fs.readFileSync(path.join(build, 'app.blob')), {
    sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    ...(mac ? { machoSegmentName: 'NODE_SEA' } : {}),
  });
  if (mac) execFileSync('codesign', ['--sign', '-', out]);

  console.log(`\n완료: ${path.relative(root, out)} (${(fs.statSync(out).size / 1e6).toFixed(0)}MB)`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
