-- 小额免总经理审批的额度（2026-09-16）
--
-- 上线方式：先做一次经过验证的 PostgreSQL 备份，再把整个文件执行一次。
-- 重复执行是安全的：只建表，不写数据，也不动任何已有单据。
-- 中途失败会整体回滚，修好原因后重跑即可，不要为了重试去删表或恢复整库。
-- 内容与 server/src/schema.sql「报销审批」一节里的 approval_thresholds 保持一致。
--
-- 新增：
--   approval_thresholds  报销 / 采购各一条「金额 ≤ 额度 就跳过总经理审批」的额度配置
--
-- 数据：这张表故意留空。没有行就用代码里的默认值（报销 300 元、采购 2000 元），
-- 管理员在「审批设置」里手动填过才写行，之后以行里的值为准；清空那一栏会把行删掉、退回默认值。
-- 已经在途的单子不受影响：额度和审批人一样，每一步按当时的配置实时算。
BEGIN;

CREATE TABLE IF NOT EXISTS approval_thresholds (
  kind          TEXT PRIMARY KEY CHECK (kind IN ('expense', 'purchase')),
  gm_free_cents BIGINT NOT NULL CHECK (gm_free_cents >= 0 AND gm_free_cents <= 9999999999),
  updated_by    BIGINT REFERENCES users(id) ON DELETE SET NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;
