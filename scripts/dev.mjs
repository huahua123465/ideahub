/** 一条命令同时起后端和前端：npm run dev */
import '../server/src/lib/env.mjs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const procs = [];

function run(name, file, color) {
  const p = spawn(process.execPath, [join(root, file)], { cwd: root, env: process.env });
  const tag = `\x1b[${color}m[${name}]\x1b[0m `;
  const pipe = stream => stream.on('data', d =>
    String(d).split('\n').filter(Boolean).forEach(l => console.log(tag + l)));
  pipe(p.stdout); pipe(p.stderr);
  p.on('exit', c => { console.log(tag + `退出（code=${c}）`); stop(); });
  procs.push(p);
}

function stop() {
  for (const p of procs) { try { p.kill(); } catch { /* 已退出 */ } }
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

run('后端', 'server/src/index.mjs', '36');
run('前端', 'scripts/serve-web.mjs', '35');

console.log('\n  两个都起来后打开 http://localhost:' + (process.env.WEB_PORT || 5173) + '\n');
