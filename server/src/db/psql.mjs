/**
 * 备用驱动：直接驱动本机的 psql 命令行，零 npm 依赖。
 *
 * 实现方式：常驻一个 psql 交互进程，用哨兵行切分每条语句的输出，
 * 结果统一用 json_agg 取回来，所以类型和 pg 驱动一致。
 *
 * 注意：这个驱动把参数拼成 SQL 字面量（psql 不支持 $n 绑定）。
 * 拼接前做了严格转义，但它仍然只建议用于开发和 CI，生产请用 pg 驱动。
 */
import { spawn } from 'node:child_process';
import { URL } from 'node:url';

const SENTINEL = '__IDEAHUB_EOQ__';

function parseUrl(u) {
  const url = new URL(u);
  return {
    host: url.hostname || 'localhost',
    port: url.port || '5432',
    user: decodeURIComponent(url.username || 'postgres'),
    password: decodeURIComponent(url.password || ''),
    db: decodeURIComponent(url.pathname.replace(/^\//, '')) || 'postgres',
  };
}

/** 把 JS 值编成 SQL 字面量 */
export function literal(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('不能把 ' + v + ' 作为 SQL 参数');
    return String(v);
  }
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof Date) return `'${v.toISOString()}'::timestamptz`;
  if (Array.isArray(v)) {
    if (v.length === 0) return `'{}'::text[]`;
    return `ARRAY[${v.map(literal).join(',')}]::text[]`;
  }
  if (typeof v === 'object') return `${literal(JSON.stringify(v))}::jsonb`;
  const s = String(v);
  // 有反斜杠就用 E'' 转义串，否则普通单引号串
  if (s.includes('\\')) return `E'${s.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * 把 $1 $2 替换成字面量。
 *
 * 这里刻意做了和 pg 一样严格的参数校验：**占位符个数必须和传入参数个数完全一致**。
 * pg 走扩展查询协议，多传一个参数就会报
 * "bind message supplies N parameters, but prepared statement requires M"，
 * 而纯字符串替换本来是察觉不到的 —— 那样就会出现「开发时好好的，换成生产驱动就炸」。
 * 宁可在这里先炸。
 */
function bind(sql, params) {
  const used = new Set();
  for (const m of sql.matchAll(/\$(\d+)/g)) used.add(Number(m[1]));

  const n = params ? params.length : 0;
  if (used.size !== n) {
    throw new Error(
      `参数个数对不上：SQL 里用到 ${used.size} 个占位符（${[...used].sort((a, b) => a - b).map(i => '$' + i).join(' ')}），` +
      `却传了 ${n} 个参数。pg 驱动会直接拒绝这种语句。\nSQL: ${sql.trim().slice(0, 200)}`);
  }
  for (const i of used) {
    if (i < 1 || i > n) throw new Error(`SQL 用到了 $${i}，但只传了 ${n} 个参数`);
  }
  if (n === 0) return sql;

  return sql.replace(/\$(\d+)/g, (m, k) => literal(params[Number(k) - 1]));
}

const RETURNS_ROWS = /^\s*(select|with|table|values|show|explain)\b/i;
const HAS_RETURNING = /\breturning\b[\s\S]*$/i;

class Session {
  constructor(cfg) { this.cfg = cfg; this.queue = Promise.resolve(); }

  start() {
    if (this.proc) return;
    const { host, port, user, password, db } = this.cfg;
    this.proc = spawn('psql', [
      '-X',            // 不读 ~/.psqlrc
      '-q',            // 不打印命令标签
      '-A',            // 不对齐
      '-t',            // 不打印表头
      '-v', 'ON_ERROR_STOP=0',
      '-h', host, '-p', port, '-U', user, '-d', db,
    ], { env: { ...process.env, PGPASSWORD: password }, stdio: ['pipe', 'pipe', 'pipe'] });

    this.buf = '';
    this.waiters = [];
    const onData = chunk => {
      this.buf += chunk.toString('utf8');
      let idx;
      while ((idx = this.buf.indexOf(SENTINEL)) !== -1) {
        const out = this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + SENTINEL.length).replace(/^\r?\n/, '');
        const w = this.waiters.shift();
        if (w) w(out);
      }
    };
    this.proc.stdout.on('data', onData);
    this.proc.stderr.on('data', onData);   // 错误信息也走同一条流，便于按顺序读
    this.proc.on('exit', code => {
      this.proc = null;
      this.waiters.splice(0).forEach(w => w(`ERROR:  psql 进程退出（code=${code}）`));
    });
  }

  /** 串行发送，保证语句顺序 —— 事务依赖这个顺序 */
  send(sqlText) {
    this.start();
    const run = () => new Promise(resolve => {
      this.waiters.push(resolve);
      this.proc.stdin.write(sqlText + '\n\\echo ' + SENTINEL + '\n');
    });
    this.queue = this.queue.then(run, run);
    return this.queue;
  }

  async q(sql, params = []) {
    const bound = bind(sql, params);
    const wantRows = RETURNS_ROWS.test(bound) || HAS_RETURNING.test(bound);
    const stmt = wantRows
      ? `WITH _q AS (${bound.replace(/;\s*$/, '')}) SELECT coalesce(json_agg(row_to_json(_q)),'[]') FROM _q;`
      : `${bound.replace(/;\s*$/, '')};`;

    const raw = (await this.send(stmt)).trim();
    const errLine = raw.split('\n').find(l => /^(ERROR|FATAL|PANIC):/.test(l.trim()));
    if (errLine) {
      const e = new Error(errLine.replace(/^(ERROR|FATAL|PANIC):\s*/, ''));
      e.sql = bound;
      throw e;
    }
    if (!wantRows) return { rows: [], rowCount: 0 };

    const jsonLine = raw.split('\n').filter(Boolean).pop() || '[]';
    let rows;
    try { rows = JSON.parse(jsonLine); } catch { rows = []; }
    return { rows: rows || [], rowCount: (rows || []).length };
  }

  end() {
    if (!this.proc) return;
    try { this.proc.stdin.end(); } catch { /* 已关闭 */ }
    this.proc = null;
  }
}

const cfg = parseUrl(process.env.DATABASE_URL || 'postgres://postgres:ideahub@localhost:5432/ideahub');
const main = new Session(cfg);

export async function query(sql, params = []) {
  return main.q(sql, params);
}

/** 事务：独占一个 psql 会话，保证 BEGIN/COMMIT 落在同一连接上 */
export async function tx(fn) {
  const s = new Session(cfg);
  try {
    await s.q('BEGIN');
    const out = await fn({ query: (sql, params = []) => s.q(sql, params) });
    await s.q('COMMIT');
    return out;
  } catch (e) {
    try { await s.q('ROLLBACK'); } catch { /* 会话可能已断 */ }
    throw e;
  } finally {
    s.end();
  }
}

export async function close() { main.end(); }
