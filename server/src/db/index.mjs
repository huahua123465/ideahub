/**
 * 数据库统一出口
 *
 * 两种驱动，接口完全一致：
 *   pg    生产用。需要 `npm i pg`。
 *   psql  备用。不装任何 npm 包，直接调本机的 psql 命令行。
 *         适合「机器上有 PostgreSQL 但暂时不想装 node 依赖」的情况，
 *         也是本项目在 CI / 无网环境下跑测试用的驱动。
 *
 * 用 DB_DRIVER 环境变量切换，默认 pg。
 */
import '../lib/env.mjs';

const DRIVER = process.env.DB_DRIVER || 'pg';

const impl = DRIVER === 'psql'
  ? await import('./psql.mjs')
  : await import('./pg.mjs');

/** 执行一条 SQL。params 用 $1 $2 占位。返回 { rows, rowCount } */
export const query = impl.query;

/**
 * 在一个事务里执行。回调拿到的 c 有 c.query(sql, params)。
 * 抛异常自动 ROLLBACK，正常返回自动 COMMIT。
 */
export const tx = impl.tx;

/** 关闭连接池（进程退出前调） */
export const close = impl.close;

export const driverName = DRIVER;
