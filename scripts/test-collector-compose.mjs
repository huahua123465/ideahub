/** 静态检查 Compose 中 Collector 不会暴露公网且资源限制完整。 */
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../docker-compose.yml', import.meta.url), 'utf8');
const start = source.indexOf('\n  collector:');
const end = source.indexOf('\n  caddy:', start);
if (start < 0 || end < 0) throw new Error('docker-compose.yml 缺少 collector 服务');
const block = source.slice(start, end);

const checks = [
  ['没有宿主机 ports 映射', !/^\s{4}ports:/m.test(block)],
  ['仅 expose 5000', /^\s{4}expose:\s*\["5000"\]/m.test(block)],
  ['init 已启用', /^\s{4}init:\s*true/m.test(block)],
  ['内存不超过 1536m', /^\s{4}mem_limit:\s*1536m/m.test(block)],
  ['CPU 上限 1.5', /^\s{4}cpus:\s*1\.5/m.test(block)],
  ['PID 上限 256', /^\s{4}pids_limit:\s*256/m.test(block)],
  ['共享内存 256m', /^\s{4}shm_size:\s*256m/m.test(block)],
  ['丢弃全部 capabilities', /^\s{4}cap_drop:\s*\[ALL\]/m.test(block)],
  ['禁止提权', /no-new-privileges:true/.test(block)],
  ['采集并发固定 1', /COLLECTOR_MAX_CONCURRENT:\s*"1"/.test(block)],
  ['OCR 固定 1', /COLLECTOR_OCR_WORKERS:\s*"1"/.test(block)],
  ['Web线程固定 1', /COLLECTOR_WEB_THREADS:\s*"1"/.test(block)],
  ['状态目录默认在仓库外', /\/opt\/ideahub-collector\/state/.test(block)],
  ['输出目录默认在仓库外', /\/opt\/ideahub-collector\/output/.test(block)],
];

let failed = 0;
for (const [name, pass] of checks) {
  console.log(`  ${pass ? '✓' : '✗'} ${name}`);
  if (!pass) failed++;
}
if (failed) {
  console.error(`\nCollector Compose：${failed} 项未通过`);
  process.exitCode = 1;
} else {
  console.log(`\nCollector Compose：${checks.length} 项通过`);
}

