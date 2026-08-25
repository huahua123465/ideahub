/** 生产驱动：node-postgres 连接池 */
import pg from 'pg';

// BIGINT 默认被 pg 返回成字符串（怕精度丢失）。我们的 id 不会超过 2^53，转成数字更好用。
pg.types.setTypeParser(20, v => (v === null ? null : Number(v)));
// NUMERIC 同理
pg.types.setTypeParser(1700, v => (v === null ? null : Number(v)));

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://postgres:ideahub@localhost:5432/ideahub',
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', err => console.error('[db] 连接池空闲连接出错:', err.message));

export async function query(sql, params = []) {
  const r = await pool.query(sql, params);
  return { rows: r.rows, rowCount: r.rowCount };
}

export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn({
      query: async (sql, params = []) => {
        const r = await client.query(sql, params);
        return { rows: r.rows, rowCount: r.rowCount };
      },
    });
    await client.query('COMMIT');
    return out;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* 连接已断则忽略 */ }
    throw e;
  } finally {
    client.release();
  }
}

export async function close() {
  await pool.end();
}
