-- 采购申请（2026-09-14）
--
-- 上线方式：先做一次经过验证的 PostgreSQL 备份，再把整个文件执行一次。
-- 只新增表和索引，不改任何已有表；重复执行是安全的（全部 IF NOT EXISTS）。
-- 附件复用 attachments（scope = 'purchase'），那张表没有 scope / side 约束，不用改。
-- 中途失败会整体回滚，修好原因后重跑即可，不要为了重试去删表或恢复整库。
-- 内容与 server/src/schema.sql 末尾「采购申请」一节保持一致。
BEGIN;

-- ---------- 采购申请（2026-09-14） ----------
-- 流程：申请人提交 → 部门负责人 → 总经理 → 财务（立项完成）→ 付款 → 申请人提交交付清单（闭环）。
-- 审批人复用报销审批的配置（expense_dept_leaders / expense_role_holders），同样按当前配置实时算。
--   一次性支付：财务审批通过后自动生成一笔全额付款，申请人填收款账户 → 出纳转款。
--   非一次性支付：申请人按需发起多笔付款（合计不超过立项金额），每笔 财务审批 → 出纳转款。
-- 付过至少一笔、且没有在途付款时，申请人可以提交交付清单，采购闭环。

-- 采购申请单。
--   pay_type：one_time 一次性支付 | installment 非一次性支付
--   status  ：draft 草稿 | pending 立项审批中 | returned 已退回 | withdrawn 已撤回
--             | executing 立项通过、付款与交付中 | completed 已完成 | cancelled 已作废
--   stage   ：只在 pending 时有值，表示立项卡在哪一步
--   round   ：第几次提交立项。退回或撤回后重提 +1
--   reminded_at：最近一次「待提交交付清单」的每日提醒时间，防止重复提醒
CREATE TABLE IF NOT EXISTS purchase_requests (
  id            BIGSERIAL PRIMARY KEY,
  applicant_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  dept          TEXT NOT NULL CHECK (length(btrim(dept)) BETWEEN 1 AND 40),
  pay_type      TEXT NOT NULL CHECK (pay_type IN ('one_time', 'installment')),
  title         TEXT NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 120),
  apply_date    DATE NOT NULL,
  amount_cents  BIGINT NOT NULL CHECK (amount_cents > 0 AND amount_cents <= 9999999999),
  note          TEXT CHECK (note IS NULL OR length(note) <= 2000),
  status        TEXT NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft', 'pending', 'returned', 'withdrawn', 'executing', 'completed', 'cancelled')),
  stage         TEXT CHECK (stage IN ('leader', 'gm', 'finance')),
  round         INT NOT NULL DEFAULT 0 CHECK (round >= 0),
  submitted_at  TIMESTAMPTZ,
  approved_at   TIMESTAMPTZ,
  delivery_note TEXT CHECK (delivery_note IS NULL OR length(delivery_note) <= 2000),
  completed_at  TIMESTAMPTZ,
  reminded_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT purchase_requests_stage_ck CHECK ((status = 'pending') = (stage IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_purchase_requests_applicant
  ON purchase_requests(applicant_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_purchase_requests_pending
  ON purchase_requests(stage, dept) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_purchase_requests_executing
  ON purchase_requests(id) WHERE status = 'executing';

-- 付款。一次性支付只有一笔；非一次性支付可以有多笔。
--   status：pending 进行中 | paid 已转款 | cancelled 已取消
--   stage ：只在 pending 时有值。account 待申请人填收款账户 | finance 待财务审批 | cashier 待出纳转款
CREATE TABLE IF NOT EXISTS purchase_payments (
  id            BIGSERIAL PRIMARY KEY,
  request_id    BIGINT NOT NULL REFERENCES purchase_requests(id) ON DELETE CASCADE,
  seq           INT NOT NULL CHECK (seq >= 1),
  amount_cents  BIGINT NOT NULL CHECK (amount_cents > 0 AND amount_cents <= 9999999999),
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'cancelled')),
  stage         TEXT CHECK (stage IN ('account', 'finance', 'cashier')),
  payee_name    TEXT CHECK (payee_name IS NULL OR length(btrim(payee_name)) BETWEEN 1 AND 100),
  payee_account TEXT CHECK (payee_account IS NULL OR length(btrim(payee_account)) BETWEEN 1 AND 64),
  payee_bank    TEXT CHECK (payee_bank IS NULL OR length(payee_bank) <= 100),
  note          TEXT CHECK (note IS NULL OR length(note) <= 1000),
  paid_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT purchase_payments_stage_ck CHECK ((status = 'pending') = (stage IS NOT NULL)),
  CONSTRAINT purchase_payments_seq_uq UNIQUE (request_id, seq)
);
-- 「待我处理」按付款步骤找单子，只扫在途的那一小撮
CREATE INDEX IF NOT EXISTS idx_purchase_payments_pending
  ON purchase_payments(stage, request_id) WHERE status = 'pending';

-- 留痕。只追加，不修改。payment_id 为空的是立项审批记录，有值的是那一笔付款的记录。
--   submit 提交 | approve 通过 | skip 自动跳过 | return 退回 | revoke 撤销同意 | withdraw 撤回
--   cancel 作废 / 取消付款 | account 提交收款账户 | pay 确认转款 | deliver 提交交付清单
CREATE TABLE IF NOT EXISTS purchase_actions (
  id         BIGSERIAL PRIMARY KEY,
  request_id BIGINT NOT NULL REFERENCES purchase_requests(id) ON DELETE CASCADE,
  payment_id BIGINT REFERENCES purchase_payments(id) ON DELETE SET NULL,
  round      INT NOT NULL CHECK (round >= 0),
  stage      TEXT CHECK (stage IN ('leader', 'gm', 'finance', 'account', 'cashier')),
  action     TEXT NOT NULL
             CHECK (action IN ('submit', 'approve', 'skip', 'return', 'revoke', 'withdraw',
                               'cancel', 'account', 'pay', 'deliver')),
  actor_id   BIGINT REFERENCES users(id) ON DELETE SET NULL,
  comment    TEXT CHECK (comment IS NULL OR length(comment) <= 1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_purchase_actions
  ON purchase_actions(request_id, id);
-- 「我经手过的单子」要按经手人反查
CREATE INDEX IF NOT EXISTS idx_purchase_actions_actor
  ON purchase_actions(actor_id, request_id);

COMMIT;
