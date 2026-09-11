-- 报销审批（2026-09-11）
--
-- 上线方式：先做一次经过验证的 PostgreSQL 备份，再把整个文件执行一次。
-- 只新增表和索引，不改任何已有表；重复执行是安全的（全部 IF NOT EXISTS）。
-- 中途失败会整体回滚，修好原因后重跑即可，不要为了重试去删表或恢复整库。
-- 内容与 server/src/schema.sql 末尾「报销审批」一节保持一致。
BEGIN;

-- ---------- 报销审批（2026-09-11） ----------
-- 流程：申请人提交 → 部门负责人 → 总经理 → 财务 → 出纳打款。
-- 审批人不写在单据上，而是每一步按下面两张配置表实时算出来：
-- 有人离职或换岗，管理员改一次配置，卡在路上的单子立刻转给新的人，不会烂在旧人手里。
-- 谁审过、谁跳过，都记在 expense_claim_actions 里，历史不会因为配置变化而改写。

-- 部门 → 部门负责人。报销单上的「部门」只能从这里选，
-- 所以不依赖 users.dept 有没有填（线上大部分账号那一栏是空的）。
CREATE TABLE IF NOT EXISTS expense_dept_leaders (
  dept       TEXT PRIMARY KEY CHECK (length(btrim(dept)) BETWEEN 1 AND 40),
  leader_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sort       INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 全公司各一人：总经理、财务、出纳。
CREATE TABLE IF NOT EXISTS expense_role_holders (
  role       TEXT PRIMARY KEY CHECK (role IN ('gm', 'finance', 'cashier')),
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 报销单。一单一个类型、一个金额。
--   status：draft 草稿 | pending 审批中 | returned 已退回 | paid 已打款 | cancelled 已作废
--   stage ：只在 pending 时有值，表示卡在哪一步
--   round ：第几次提交。退回后重提会 +1，审批记录按轮次区分
-- 金额存「分」，避免浮点误差；上限 99,999,999.99 元。
-- 申请人外键用 RESTRICT：财务单据不能因为删了账号就跟着消失。
CREATE TABLE IF NOT EXISTS expense_claims (
  id           BIGSERIAL PRIMARY KEY,
  applicant_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  dept         TEXT NOT NULL CHECK (length(btrim(dept)) BETWEEN 1 AND 40),
  category     TEXT NOT NULL
               CHECK (category IN ('office', 'daily', 'travel', 'entertainment', 'other')),
  title        TEXT NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 120),
  expense_date DATE NOT NULL,
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0 AND amount_cents <= 9999999999),
  note         TEXT CHECK (note IS NULL OR length(note) <= 2000),
  status       TEXT NOT NULL DEFAULT 'draft'
               CHECK (status IN ('draft', 'pending', 'returned', 'paid', 'cancelled')),
  stage        TEXT CHECK (stage IN ('leader', 'gm', 'finance', 'cashier')),
  round        INT NOT NULL DEFAULT 0 CHECK (round >= 0),
  submitted_at TIMESTAMPTZ,
  paid_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT expense_claims_stage_ck CHECK ((status = 'pending') = (stage IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_expense_claims_applicant
  ON expense_claims(applicant_id, id DESC);
-- 「待我审批」按步骤 + 部门找单子，只扫审批中的那一小撮
CREATE INDEX IF NOT EXISTS idx_expense_claims_pending
  ON expense_claims(stage, dept) WHERE status = 'pending';

-- 审批留痕。只追加，不修改。
--   submit 提交 | approve 通过 | skip 自动跳过 | return 退回 | pay 打款 | cancel 作废
-- skip 的 actor 记的是「本该审批的那个人」，comment 写跳过原因。
CREATE TABLE IF NOT EXISTS expense_claim_actions (
  id         BIGSERIAL PRIMARY KEY,
  claim_id   BIGINT NOT NULL REFERENCES expense_claims(id) ON DELETE CASCADE,
  round      INT NOT NULL CHECK (round >= 0),
  stage      TEXT CHECK (stage IN ('leader', 'gm', 'finance', 'cashier')),
  action     TEXT NOT NULL
             CHECK (action IN ('submit', 'approve', 'skip', 'return', 'pay', 'cancel')),
  actor_id   BIGINT REFERENCES users(id) ON DELETE SET NULL,
  comment    TEXT CHECK (comment IS NULL OR length(comment) <= 1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_expense_claim_actions
  ON expense_claim_actions(claim_id, id);
-- 「我经手过的单子」要按审批人反查
CREATE INDEX IF NOT EXISTS idx_expense_claim_actions_actor
  ON expense_claim_actions(actor_id, claim_id);

COMMIT;
