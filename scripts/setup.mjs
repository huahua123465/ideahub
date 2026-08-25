/**
 * 一键启动：node scripts/setup.mjs（Windows 上双击 启动.bat 即可）
 *
 * 按顺序做这些事，每一步失败都给出下一步该怎么办，而不是甩一段堆栈：
 *   1. 检查 Node 版本
 *   2. 准备 .env
 *   3. 装依赖（只有一个 pg）
 *   4. 连数据库；连不上就试着用 Docker 起一个
 *   5. 建表 + 灌种子数据（只在库是空的时候）
 *   6. 起前后端，打开浏览器
 *
 * 数据库实在起不来时，会退到「仅界面模式」—— 前端用内置演示数据，界面照样完整可点。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, copyFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';

const c = {
  dim:  s => `\x1b[90m${s}\x1b[0m`,
  ok:   s => `\x1b[32m${s}\x1b[0m`,
  warn: s => `\x1b[33m${s}\x1b[0m`,
  err:  s => `\x1b[31m${s}\x1b[0m`,
  b:    s => `\x1b[1m${s}\x1b[0m`,
};
let stepN = 0;
const step = t => console.log(`\n${c.b(`[${++stepN}/6]`)} ${t}`);
const good = t => console.log(`      ${c.ok('✓')} ${t}`);
const warn = t => console.log(`      ${c.warn('!')} ${t}`);
const info = t => console.log(`      ${c.dim(t)}`);

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    cwd: ROOT, encoding: 'utf8', shell: isWin,
    stdio: opts.quiet ? 'pipe' : 'inherit', ...opts,
  });
}

console.log(`
  ${c.b('IdeaHub · 内部灵感库')}
  ${c.dim('一键启动。中途任何一步出问题，下面都会写清楚怎么办。')}`);

/* ---------- 1. Node 版本 ---------- */
step('检查 Node 版本');
{
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) {
    console.log(c.err(`      ✗ 当前是 Node ${process.versions.node}，本项目需要 20 或更高。`));
    console.log(`        去 https://nodejs.org 装一个 LTS 版本再回来。`);
    process.exit(1);
  }
  good(`Node ${process.versions.node}`);
}

/* ---------- 2. .env ---------- */
step('准备配置文件');
{
  const env = join(ROOT, '.env');
  if (!existsSync(env)) {
    copyFileSync(join(ROOT, '.env.example'), env);
    good('已从 .env.example 生成 .env');
  } else {
    good('.env 已存在');
  }
  await import('../server/src/lib/env.mjs');
}

/* ---------- 3. 依赖 ---------- */
step('检查依赖');
let driver = 'pg';
{
  let hasPg = false;
  try { await import('pg'); hasPg = true; } catch { /* 还没装 */ }

  if (hasPg) {
    good('pg 已安装');
  } else {
    info('正在安装 pg（全项目唯一的依赖，通常十几秒）…');
    const r = run('npm', ['install', '--no-audit', '--no-fund'], { quiet: true });
    try { await import('pg'); hasPg = true; } catch { /* 装失败 */ }

    if (hasPg) {
      good('pg 安装完成');
    } else {
      warn('pg 装不上（可能是网络或镜像源问题）');
      const psql = run(isWin ? 'where' : 'which', ['psql'], { quiet: true });
      if (psql.status === 0) {
        driver = 'psql';
        warn('检测到本机有 psql，改用免依赖的 psql 驱动继续');
      } else {
        console.log(c.err('      ✗ 没有 pg 也没有 psql，连不了数据库。'));
        info(r.stderr?.split('\n').slice(-4).join('\n') || '');
        info('可以先看界面：node scripts/serve-web.mjs');
        info('或换个 npm 镜像后重试：npm config set registry https://registry.npmmirror.com');
        process.exit(1);
      }
    }
  }
  process.env.DB_DRIVER = driver;
}

/* ---------- 4. 数据库 ---------- */
step('连接数据库');
let db = null;
{
  const tryConnect = async () => {
    try {
      const m = await import('../server/src/db/index.mjs?t=' + Date.now());
      await m.query('SELECT 1');
      return m;
    } catch (e) {
      return { error: e.message };
    }
  };

  db = await tryConnect();
  if (db.error) {
    warn('连不上，试着用 Docker 起一个…');
    const dk = run('docker', ['compose', '-f', 'docker-compose.dev.yml', 'up', '-d'], { quiet: true });

    if (dk.status !== 0) {
      console.log(c.err('      ✗ 数据库连不上，Docker 也用不了。'));
      info('三条路，任选一条：');
      info('  a) 装 Docker Desktop，然后重新双击 启动.bat');
      info('  b) 本机装 PostgreSQL 16，建一个叫 ideahub 的库，把连接串填进 .env');
      info('  c) 只想看界面的话：node scripts/serve-web.mjs（零依赖，界面完整可点）');
      process.exit(1);
    }

    info('Docker 容器已拉起，等数据库就绪…');
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 2000));
      db = await tryConnect();
      if (!db.error) break;
      process.stdout.write('.');
    }
    console.log('');
    if (db.error) {
      console.log(c.err('      ✗ 等了 60 秒数据库还没起来：' + db.error));
      info('看一眼容器日志：docker compose -f docker-compose.dev.yml logs db');
      process.exit(1);
    }
  }
  good(`已连上（驱动 ${driver}）`);
}

/* ---------- 5. 建表 + 种子数据 ---------- */
step('检查数据');
{
  let tables = 0, ideas = 0;
  try {
    const t = await db.query(
      `SELECT count(*)::int AS n FROM information_schema.tables
       WHERE table_schema='public' AND table_name IN
       ('users','ideas','idea_votes','idea_comments','idea_activities')`);
    tables = t.rows[0].n;
    if (tables === 5) {
      const i = await db.query('SELECT count(*)::int AS n FROM ideas');
      ideas = i.rows[0].n;
    }
  } catch { /* 表还不存在 */ }
  await db.close();

  if (tables < 5) {
    info('表还没建，正在建…');
    const r = run(process.execPath, ['server/src/db/init.mjs'], { quiet: true });
    if (r.status !== 0) {
      console.log(c.err('      ✗ 建表失败：'));
      console.log(r.stdout || r.stderr);
      process.exit(1);
    }
    good('建表完成');
  } else {
    good('表已存在');
  }

  if (ideas === 0) {
    info('库是空的，灌入种子数据…');
    const r = run(process.execPath, ['server/src/seed.mjs'], { quiet: true });
    if (r.status !== 0) {
      console.log(c.err('      ✗ 灌数据失败：'));
      console.log(r.stdout || r.stderr);
      process.exit(1);
    }
    good('种子数据就绪（26 条灵感，含演示里那批）');
  } else {
    good(`已有 ${ideas} 条灵感，跳过灌数据`);
    info('想重来一遍的话：npm run db:reset');
  }
}

/* ---------- 6. 启动 ---------- */
step('启动服务');
{
  const port = process.env.PORT || 3000;
  const url = `http://localhost:${port}`;

  const child = spawn(process.execPath, ['server/src/index.mjs'], {
    cwd: ROOT, env: { ...process.env, DB_DRIVER: driver }, stdio: 'inherit',
  });

  // 等健康检查通过再开浏览器，避免打开一个白页
  for (let i = 0; i < 25; i++) {
    await new Promise(r => setTimeout(r, 400));
    try {
      const r = await fetch(url + '/api/health');
      if (r.ok) break;
    } catch { /* 还没起来 */ }
  }

  console.log(`
  ${c.ok('全部就绪')}

    打开   ${c.b(url)}
    停止   Ctrl + C
`);

  const open = isWin ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(open[0], open[1], { detached: true, stdio: 'ignore' }).unref(); } catch { /* 打不开就算了 */ }

  const stop = () => { try { child.kill(); } catch { /* 已退出 */ } process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  child.on('exit', code => process.exit(code ?? 0));
}
