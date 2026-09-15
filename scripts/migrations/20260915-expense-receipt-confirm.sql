-- 报销单申请人确认收款（2026-09-15）
--
-- 上线方式：先做一次经过验证的 PostgreSQL 备份，再把整个文件执行一次。
-- 重复执行是安全的：约束先 DROP IF EXISTS 再重建；「已打款 → 已完成」的数据修正
-- 只在第一次执行（received_at 列还不存在）时做，之后新产生的待确认收款单不会被误改。
-- 中途失败会整体回滚，修好原因后重跑即可，不要为了重试去删表或恢复整库。
-- 内容与 server/src/schema.sql 末尾「报销审批」一节保持一致。
--
-- 新增：
--   expense_claims.status        completed 已完成 —— 申请人确认收到钱；paid 的含义变成「出纳已打款、待确认收款」
--   expense_claims.received_at   申请人确认收款的时间
--   expense_claims.reminded_at   最近一次提醒申请人确认收款的时间（每天最多一条）
--   expense_claim_actions.action confirm 确认收到 | dispute 反馈没收到（单子回到出纳）
--
-- 数据修正：上线前已经是 paid 的单子直接算已完成（用户 2026-09-15 确认），received_at 留空、不补审批记录。
BEGIN;

ALTER TABLE expense_claims DROP CONSTRAINT IF EXISTS expense_claims_status_check;
ALTER TABLE expense_claims ADD CONSTRAINT expense_claims_status_check
  CHECK (status IN ('draft', 'pending', 'returned', 'withdrawn', 'paid', 'completed', 'cancelled'));

ALTER TABLE expense_claim_actions DROP CONSTRAINT IF EXISTS expense_claim_actions_action_check;
ALTER TABLE expense_claim_actions ADD CONSTRAINT expense_claim_actions_action_check
  CHECK (action IN ('submit', 'approve', 'skip', 'return', 'pay', 'cancel', 'withdraw', 'revoke',
                    'confirm', 'dispute'));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'expense_claims' AND column_name = 'received_at'
  ) THEN
    UPDATE expense_claims SET status = 'completed' WHERE status = 'paid';
    ALTER TABLE expense_claims ADD COLUMN received_at TIMESTAMPTZ;
  END IF;
END $$;

ALTER TABLE expense_claims ADD COLUMN IF NOT EXISTS reminded_at TIMESTAMPTZ;

COMMIT;
