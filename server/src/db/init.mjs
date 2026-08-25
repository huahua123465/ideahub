/**
 * 建表脚本：npm run db:init
 * 加 --drop 会先把所有表删掉重建（本地开发用，线上别加）
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { query, close, driverName } from './index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const drop = process.argv.includes('--drop');

const DROP_SQL = `
DROP TABLE IF EXISTS idea_activities, idea_comments, idea_votes, ideas, users CASCADE;
DROP SEQUENCE IF EXISTS idea_code_seq;
DROP TYPE IF EXISTS idea_status, user_role CASCADE;
`;

try {
  console.log(`[db:init] 驱动=${driverName}  目标=${(process.env.DATABASE_URL || '默认本地库').replace(/:[^:@/]+@/, ':***@')}`);

  if (drop) {
    console.log('[db:init] --drop：先清空旧表…');
    for (const stmt of DROP_SQL.split(';').map(s => s.trim()).filter(Boolean)) {
      await query(stmt);
    }
  }

  const sql = await readFile(join(here, '..', 'schema.sql'), 'utf8');
  // 按语句切分时要保护 $$ ... $$ 函数体里的分号
  for (const stmt of splitStatements(sql)) {
    await query(stmt);
  }

  const { rows } = await query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema='public' ORDER BY table_name`);
  console.log('[db:init] 完成，现有表：', rows.map(r => r.table_name).join(', '));
} catch (e) {
  console.error('[db:init] 失败：', e.message);
  process.exitCode = 1;
} finally {
  await close();
}

/** 切分 SQL 语句，跳过 $$ 包裹的函数体和单引号字符串里的分号 */
function splitStatements(sql) {
  const out = [];
  let cur = '', inDollar = false, inQuote = false, i = 0;
  while (i < sql.length) {
    const two = sql.slice(i, i + 2);
    if (!inQuote && two === '$$') { inDollar = !inDollar; cur += two; i += 2; continue; }
    const ch = sql[i];
    if (!inDollar && ch === "'") inQuote = !inQuote;
    if (ch === ';' && !inDollar && !inQuote) { if (cur.trim()) out.push(cur.trim()); cur = ''; i++; continue; }
    cur += ch; i++;
  }
  if (cur.trim()) out.push(cur.trim());
  // 去掉纯注释块
  return out.filter(s => s.split('\n').some(l => l.trim() && !l.trim().startsWith('--')));
}
