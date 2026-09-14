-- 报销单撤回 / 撤销同意（2026-09-14）
--
-- 上线方式：先做一次经过验证的 PostgreSQL 备份，再把整个文件执行一次。
-- 只放宽两条 CHECK 约束，不改任何已有数据；重复执行是安全的（先 DROP IF EXISTS 再重建）。
-- 中途失败会整体回滚，修好原因后重跑即可，不要为了重试去删表或恢复整库。
-- 内容与 server/src/schema.sql 末尾「报销审批」一节保持一致。
--
-- 新增：
--   expense_claims.status        withdrawn 已撤回 —— 申请人在打款前把审批中的单子拿回来改
--   expense_claim_actions.action withdraw  撤回
--                                revoke    撤销同意 —— 审批人在下一步处理前收回自己的同意
BEGIN;

ALTER TABLE expense_claims DROP CONSTRAINT IF EXISTS expense_claims_status_check;
ALTER TABLE expense_claims ADD CONSTRAINT expense_claims_status_check
  CHECK (status IN ('draft', 'pending', 'returned', 'withdrawn', 'paid', 'cancelled'));

ALTER TABLE expense_claim_actions DROP CONSTRAINT IF EXISTS expense_claim_actions_action_check;
ALTER TABLE expense_claim_actions ADD CONSTRAINT expense_claim_actions_action_check
  CHECK (action IN ('submit', 'approve', 'skip', 'return', 'pay', 'cancel', 'withdraw', 'revoke'));

COMMIT;
