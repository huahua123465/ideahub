-- ============================================================
-- IdeaHub 表结构
-- 核心设计：灵感池和正式库是同一张表的不同 status，不是两份存储
-- ============================================================

-- pg_trgm 用于中文相似度查重（不需要额外装分词插件）
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------- 枚举 ----------
DO $$ BEGIN
  CREATE TYPE idea_status AS ENUM (
    'draft',      -- 草稿，仅自己可见
    'pending',    -- 待评审  ┐
    'reviewing',  -- 评审中  ┘ 灵感池（预备库）
    'adopted',    -- 已采纳    正式库
    'rejected',   -- 已否决
    'archived'    -- 已归档
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('member', 'reviewer', 'admin');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- 用户 ----------
CREATE TABLE IF NOT EXISTS users (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  dept        TEXT,
  role        user_role NOT NULL DEFAULT 'member',
  avatar_hue  TEXT,                       -- 头像底色，前端按名字算，这里可覆盖
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- 灵感（唯一的内容表） ----------
CREATE TABLE IF NOT EXISTS ideas (
  id             BIGSERIAL PRIMARY KEY,
  code           TEXT UNIQUE,                    -- 采纳时才生成：IDEA-2026-0043
  title          TEXT NOT NULL,
  content        TEXT NOT NULL,                  -- Markdown 正文
  category       TEXT NOT NULL,                  -- 产品 / 技术 / 运营 / 流程 / 其他
  tags           TEXT[] NOT NULL DEFAULT '{}',
  status         idea_status NOT NULL DEFAULT 'pending',
  author_id      BIGINT NOT NULL REFERENCES users(id),
  is_anonymous   BOOLEAN NOT NULL DEFAULT false,

  -- 物化计数：避免每次列表查询都去 COUNT 子表
  vote_count     INT NOT NULL DEFAULT 0,
  comment_count  INT NOT NULL DEFAULT 0,
  view_count     INT NOT NULL DEFAULT 0,
  hot_score      REAL NOT NULL DEFAULT 0,

  -- 采纳后才填充
  owner_id       BIGINT REFERENCES users(id),    -- 立项负责人
  adopted_at     TIMESTAMPTZ,
  adopted_by     BIGINT REFERENCES users(id),
  progress       INT NOT NULL DEFAULT 0,         -- 0-100
  doc_url        TEXT,

  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ideas_status_hot  ON ideas(status, hot_score DESC);
CREATE INDEX IF NOT EXISTS idx_ideas_status_time ON ideas(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ideas_author      ON ideas(author_id);
CREATE INDEX IF NOT EXISTS idx_ideas_tags        ON ideas USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_ideas_title_trgm  ON ideas USING GIN(title gin_trgm_ops);

-- 正式库编号的年度序列
CREATE SEQUENCE IF NOT EXISTS idea_code_seq START 33;

-- ---------- 投票 ----------
-- 联合主键就是防重复投票的闸门。不要在应用层做「先查后写」，并发时必漏。
CREATE TABLE IF NOT EXISTS idea_votes (
  idea_id    BIGINT NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  user_id    BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (idea_id, user_id)
);

-- ---------- 讨论 ----------
CREATE TABLE IF NOT EXISTS idea_comments (
  id           BIGSERIAL PRIMARY KEY,
  idea_id      BIGINT NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  user_id      BIGINT NOT NULL REFERENCES users(id),
  parent_id    BIGINT REFERENCES idea_comments(id) ON DELETE CASCADE,
  body         TEXT NOT NULL,
  -- 每条评论各自决定匿不匿名，和灵感本身的匿名是两回事：
  -- 匿名提了灵感的人，回到自己帖子下讨论时通常是愿意署名的。
  is_anonymous BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 已经建过表的库靠这行补列（schema.sql 是可以重复执行的）
ALTER TABLE idea_comments ADD COLUMN IF NOT EXISTS is_anonymous BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_comments_idea ON idea_comments(idea_id, created_at);

-- ---------- 审计流水 ----------
-- 这张表让「为什么这条灵感被否决了」变成半年后还能查到的事实
CREATE TABLE IF NOT EXISTS idea_activities (
  id          BIGSERIAL PRIMARY KEY,
  idea_id     BIGINT NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  actor_id    BIGINT REFERENCES users(id),
  action      TEXT NOT NULL,          -- created / voted / commented / status_changed
  from_status idea_status,
  to_status   idea_status,
  reason      TEXT,                   -- 否决时必填
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_activities_idea ON idea_activities(idea_id, created_at);

-- ---------- 触发器：投票数同步 ----------
CREATE OR REPLACE FUNCTION sync_vote_count() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE ideas SET vote_count = vote_count + 1, updated_at = now() WHERE id = NEW.idea_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE ideas SET vote_count = GREATEST(vote_count - 1, 0), updated_at = now() WHERE id = OLD.idea_id;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_vote_count ON idea_votes;
CREATE TRIGGER trg_vote_count
  AFTER INSERT OR DELETE ON idea_votes
  FOR EACH ROW EXECUTE FUNCTION sync_vote_count();

-- ---------- 触发器：评论数同步 ----------
CREATE OR REPLACE FUNCTION sync_comment_count() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE ideas SET comment_count = comment_count + 1, updated_at = now() WHERE id = NEW.idea_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE ideas SET comment_count = GREATEST(comment_count - 1, 0), updated_at = now() WHERE id = OLD.idea_id;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_comment_count ON idea_comments;
CREATE TRIGGER trg_comment_count
  AFTER INSERT OR DELETE ON idea_comments
  FOR EACH ROW EXECUTE FUNCTION sync_comment_count();

-- ---------- 热度 ----------
-- 带时间衰减，避免「最早提的永远排第一」。
--
-- 分子里的那个 +1 很关键：没有它，刚提交、还没人投票的灵感 hot_score 恒等于 0，
-- 会直接沉到列表最底下 —— 提了就看不见，等于没提。加上基础分之后，
-- 新灵感开局 1/2^1.5 ≈ 0.35，稳稳排在前面，再随时间衰减下去。
--
-- 2026-08-21 调过两个参数，原因见下：
--
-- 1) 衰减单位从「小时」换成「天」。
--    原来照搬的是 Hacker News，那里一天上千条、内容小时级换血，按小时衰减是对的。
--    这里是内部灵感库，一周几条、90 天才归档 —— 按小时衰减的实际效果是
--    分数每 1.2 小时减半，一条发出 24 小时的灵感需要 47 个支持才追得上一条刚发的空帖。
--    结果就是「热度」排序和「最新」排序几乎完全重合，热度这个维度等于不存在。
--
-- 2) 支持 2 分、评论 1 分（原来反过来，评论 2 分）。
--    支持是明确的背书，评论可能是质疑甚至反对。让「热度」和大家对热度的直觉一致。
CREATE OR REPLACE FUNCTION hot_of(votes int, comments int, created timestamptz)
RETURNS real AS $$
  SELECT ((votes * 2 + comments + 1)::real
          / POWER(EXTRACT(EPOCH FROM (now() - created)) / 86400 + 2, 1.5)::real)::real;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION recalc_hot_scores() RETURNS void AS $$
  UPDATE ideas SET hot_score = hot_of(vote_count, comment_count, created_at)
  WHERE status IN ('pending', 'reviewing');
$$ LANGUAGE sql;

-- 插入和计数变化时立刻算一次，不必等定时任务那 15 分钟。
-- 定时任务仍然需要 —— 它负责的是「时间流逝导致的衰减」，那个没有任何写操作会触发。
CREATE OR REPLACE FUNCTION set_hot_score() RETURNS TRIGGER AS $$
BEGIN
  NEW.hot_score := hot_of(NEW.vote_count, NEW.comment_count, NEW.created_at);
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_hot_score ON ideas;
CREATE TRIGGER trg_hot_score
  BEFORE INSERT OR UPDATE OF vote_count, comment_count ON ideas
  FOR EACH ROW EXECUTE FUNCTION set_hot_score();

-- ---------- 中文相似度 ----------
-- 坑：pg_trgm 在 C locale 下对中文一个 trigram 都切不出来，similarity() 恒为 0。
-- 数据库的 locale 不该由应用来假设，所以这里自己实现一套按字切二元组的 Jaccard 相似度，
-- 与 locale 无关。英文仍然走 pg_trgm，两者取大值。
CREATE OR REPLACE FUNCTION cn_bigrams(t text) RETURNS text[] AS $$
  SELECT coalesce(array_agg(DISTINCT g), '{}')
  FROM (
    SELECT regexp_replace(lower(coalesce(t, '')), '[[:space:][:punct:]「」【】（），。、；：？！…—]', '', 'g') AS s
  ) x,
  LATERAL (
    SELECT substring(x.s FROM i FOR 2) AS g
    FROM generate_series(1, GREATEST(length(x.s) - 1, 1)) AS i
    WHERE length(x.s) > 0
  ) y;
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION cn_similarity(a text, b text) RETURNS real AS $$
  SELECT CASE WHEN u = 0 THEN 0::real ELSE i::real / u::real END
  FROM (
    SELECT
      cardinality(ARRAY(SELECT unnest(cn_bigrams(a)) INTERSECT SELECT unnest(cn_bigrams(b)))) AS i,
      cardinality(ARRAY(SELECT unnest(cn_bigrams(a)) UNION     SELECT unnest(cn_bigrams(b)))) AS u
  ) t;
$$ LANGUAGE sql IMMUTABLE;

-- 对外统一入口：中英文都能用
CREATE OR REPLACE FUNCTION title_similarity(a text, b text) RETURNS real AS $$
  SELECT GREATEST(similarity(a, b), cn_similarity(a, b));
$$ LANGUAGE sql IMMUTABLE;

-- ============================================================
-- 账号与会话
-- ============================================================

-- 用户名和密码是后加的（早期版本从 X-User-Id 头认人）。
-- 用 ADD COLUMN IF NOT EXISTS 而不是改上面的建表语句，
-- 这样已经有数据的库直接跑一次 db:init 就能升级，不用重建。
ALTER TABLE users ADD COLUMN IF NOT EXISTS username      TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

-- 唯一索引建在 lower(username) 上：不能出现 Chen 和 chen 两个账号，
-- 否则登录时用户自己都分不清是哪一个。
-- 种子数据里那 90 个虚拟同事没有用户名（NULL），NULL 不参与唯一约束，正好。
CREATE UNIQUE INDEX IF NOT EXISTS users_username_uniq ON users (lower(username));

-- ============================================================
--  业务板块台账（真人作品 / 矩阵作品 / 真人直播 / 销售转化 / 后端交付）
--  依据《情感赛道全链路业务 1.0》，见 docs/新增板块-实现任务.md
-- ============================================================

-- 前端三个板块（真人/矩阵/直播）字段几乎完全一样，共用同一组表，
-- 靠 channel 区分板块、side 区分「自己的」和「对标的」。
-- 拆成三套表只会变成三份互相抄的代码。
DO $$ BEGIN
  CREATE TYPE work_channel AS ENUM ('persona', 'matrix', 'live');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE work_side AS ENUM ('own', 'benchmark');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- 账号台账 ----------
CREATE TABLE IF NOT EXISTS channel_accounts (
  id          BIGSERIAL PRIMARY KEY,
  channel     work_channel NOT NULL,
  side        work_side    NOT NULL,
  platform    TEXT NOT NULL DEFAULT '小红书',
  handle      TEXT NOT NULL,                -- 账号名
  url         TEXT,                         -- 主页链接
  followers   INT  NOT NULL DEFAULT 0,
  positioning TEXT,                         -- 定位 / 人设
  note        TEXT,                         -- 对标账号写「为什么值得对标」
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_accounts_channel ON channel_accounts(channel, side);

-- ---------- 作品与直播场次 ----------
-- metrics 用 JSONB 而不是固定列：内容层和直播层看的指标不是一套
-- （schema 里写死会让一半字段永远是空的），指标键在 web/src/boards.js 里集中定义。
CREATE TABLE IF NOT EXISTS works (
  id           BIGSERIAL PRIMARY KEY,
  channel      work_channel NOT NULL,
  side         work_side    NOT NULL,
  account_id   BIGINT REFERENCES channel_accounts(id) ON DELETE SET NULL,
  title        TEXT NOT NULL,
  url          TEXT,
  pillar       TEXT,                         -- 内容支柱 / 选题方向
  published_at DATE,
  metrics      JSONB NOT NULL DEFAULT '{}'::jsonb,
  note         TEXT,
  created_by   BIGINT REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_works_channel ON works(channel, side, published_at DESC);

-- ---------- 销售转化 / 后端交付 ----------
-- 这两块都是「分类 + 标题 + 正文 + 排序」的结构化文档，没必要各建一张表。
CREATE TABLE IF NOT EXISTS playbook_items (
  id         BIGSERIAL PRIMARY KEY,
  board      TEXT NOT NULL,                  -- sales | delivery
  section    TEXT NOT NULL,                  -- 小板块：tier/filter/intake/script | product/flow
  label      TEXT,                           -- 小分类：话术场景 / 客资等级 / 产品类型 / 流程节点
  title      TEXT NOT NULL,
  body       TEXT,
  meta       JSONB NOT NULL DEFAULT '{}'::jsonb,   -- 负责人角色、核心指标、层级、适用等级…
  sort       INT NOT NULL DEFAULT 0,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_playbook ON playbook_items(board, section, sort);

-- ---------- 客户档案（PDF 05） ----------
-- stage 就是漏斗的位置：看板的每一层直接数这张表，不用另建一张手工填数的表。
DO $$ BEGIN
  CREATE TYPE client_stage AS ENUM
    ('lead', 'wechat', 'profiled', 'consulted', 'coaching', 'renewed', 'lost');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS clients (
  id         BIGSERIAL PRIMARY KEY,
  alias      TEXT NOT NULL,                 -- 化名。PDF 09 的 SOP 就是「脱敏、标签、录入」
  tier       TEXT,                          -- S / A / B / C（PDF 04 客资分级）
  stage      client_stage NOT NULL DEFAULT 'lead',
  source     TEXT,                          -- 来源：私信 / 直播连麦 / 转介绍
  owner_id   BIGINT REFERENCES users(id),   -- 跟进人
  -- PDF 05 的五类信息。字段清单在 web/src/boards.js 里定义，
  -- 用 JSONB 是因为不同客户能收集到的字段差很多，写死成列会有一半永远是空的。
  female     JSONB NOT NULL DEFAULT '{}'::jsonb,
  male       JSONB NOT NULL DEFAULT '{}'::jsonb,
  relation   JSONB NOT NULL DEFAULT '{}'::jsonb,
  timeline   TEXT,                          -- 认识→升温→关键事件→矛盾→变化→现在
  evidence   TEXT,                          -- 证据材料「有哪些」的清单，不存文件本身
  note       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_clients_stage ON clients(stage, tier);

-- ---------- 案例库（PDF 09） ----------
-- 七个模块对应 PDF 09 的表格：客户标签 / 男方标签 / 初始问题 / 判断结论 /
-- 策略动作 / 执行反馈 / 最终结果。
CREATE TABLE IF NOT EXISTS cases (
  id          BIGSERIAL PRIMARY KEY,
  client_id   BIGINT REFERENCES clients(id) ON DELETE SET NULL,
  code        TEXT,                         -- 案例编号
  title       TEXT NOT NULL,
  client_tags TEXT,                         -- 年龄、职业、城市、关系阶段、需求类型
  male_tags   TEXT,                         -- 职业、家庭、性格、依恋、社交特征
  problem     TEXT,                         -- 初始问题：暧昧不推进/降温/挽回/冲突
  judgement   TEXT,                         -- 判断结论：核心卡点、风险、概率判断
  strategy    TEXT,                         -- 策略动作：沟通、见面、边界、验证、退出条件
  feedback    TEXT,                         -- 执行反馈：对方反应、关系变化、执行偏差
  outcome     TEXT,                         -- 最终结果：推进成功/退出/复合/长期稳定
  reusable    BOOLEAN NOT NULL DEFAULT false, -- 能否反哺内容（PDF 09 增长飞轮）
  created_by  BIGINT REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cases_outcome ON cases(outcome, id DESC);

-- ---------- 客户档案的附件 ----------
-- 聊天记录分析报告之类的文件。文件本身落在磁盘上（/data/uploads），
-- 这张表只存元信息 —— 把二进制塞进 Postgres 会让备份和内存都很难受。
--
-- stored_name 是系统生成的随机名，orig_name 才是用户看到的原始文件名。
-- 分开存是必须的：直接拿用户给的文件名当路径，一个 ../../ 就能写到别处去。
CREATE TABLE IF NOT EXISTS client_files (
  id          BIGSERIAL PRIMARY KEY,
  client_id   BIGINT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  orig_name   TEXT NOT NULL,
  stored_name TEXT NOT NULL UNIQUE,
  mime        TEXT NOT NULL,
  size        BIGINT NOT NULL,
  note        TEXT,
  uploaded_by BIGINT REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_client_files ON client_files(client_id, created_at DESC);

-- ---------- 工作提交 ----------
-- 同事把当天的工作成果（Excel / 其他文件）提交给自己选定的审核人。
-- 审核人可以写反馈，也可以传文件回去 —— 所以附件是双向的，见 attachments.side。
CREATE TABLE IF NOT EXISTS work_reports (
  id          BIGSERIAL PRIMARY KEY,
  author_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reviewer_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  report_date DATE NOT NULL DEFAULT current_date,
  title       TEXT NOT NULL,
  summary     TEXT,                      -- 提交人的说明
  feedback    TEXT,                      -- 审核人的反馈
  reviewed_at TIMESTAMPTZ,
  reviewed_by BIGINT REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_work_author   ON work_reports(author_id, report_date DESC);
CREATE INDEX IF NOT EXISTS idx_work_reviewer ON work_reports(reviewer_id, report_date DESC);

-- ---------- 通用附件 ----------
-- 客户档案和工作提交都要传文件，字段完全一样，所以合成一张表，
-- 用 scope + ref_id 指向具体是谁的附件。分两张表就是两份互相抄的上传/下载/删除代码。
--   scope='client' → ref_id 是 clients.id
--   scope='report' → ref_id 是 work_reports.id，side 区分提交人传的还是审核人传的
CREATE TABLE IF NOT EXISTS attachments (
  id          BIGSERIAL PRIMARY KEY,
  scope       TEXT NOT NULL,
  ref_id      BIGINT NOT NULL,
  side        TEXT NOT NULL DEFAULT 'submit',   -- submit | review
  orig_name   TEXT NOT NULL,
  stored_name TEXT NOT NULL UNIQUE,
  mime        TEXT NOT NULL,
  size        BIGINT NOT NULL,
  note        TEXT,
  uploaded_by BIGINT REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_attachments ON attachments(scope, ref_id, created_at DESC);

-- 把已经传上来的客户档案附件搬过来（幂等：搬过就不再搬）
INSERT INTO attachments(scope, ref_id, side, orig_name, stored_name, mime, size, note, uploaded_by, created_at)
SELECT 'client', client_id, 'submit', orig_name, stored_name, mime, size, note, uploaded_by, created_at
FROM client_files f
WHERE NOT EXISTS (SELECT 1 FROM attachments a WHERE a.stored_name = f.stored_name);

-- ---------- 站内消息 ----------
-- 目前只有一个来源：审核人写了反馈，通知提交人。
-- 做成通用表而不是写死「反馈通知」，是因为下一个要通知的场景（被指派为审核人、
-- 灵感被采纳…）随时会来，到时候只加一行调用，不用再改表。
CREATE TABLE IF NOT EXISTS notifications (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- 收件人
  actor_id   BIGINT REFERENCES users(id) ON DELETE SET NULL,          -- 谁触发的
  kind       TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT,
  board      TEXT,      -- 点开之后跳到哪个板块
  ref_id     BIGINT,    -- 跳过去之后打开哪一条
  read_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 未读优先、按时间倒序，这个索引正好覆盖列表和红点计数两个查询
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read_at NULLS FIRST, created_at DESC);

-- ---------- 一对一聊天 ----------
-- 不建 conversations 表：「和谁聊过」由这张表里涉及自己的记录推导即可。
-- 单独建一张会话表意味着每次发消息要维护两处，早晚不一致。
-- 附件复用 attachments（scope='chat'，ref_id = 消息 id）。
CREATE TABLE IF NOT EXISTS chat_messages (
  id         BIGSERIAL PRIMARY KEY,
  from_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT,
  read_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 拉某一对的聊天记录、数未读，这两个查询都走这两个索引
CREATE INDEX IF NOT EXISTS idx_chat_pair ON chat_messages(from_id, to_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_chat_unread ON chat_messages(to_id, read_at NULLS FIRST, id DESC);

-- ---------- 群聊 ----------
CREATE TABLE IF NOT EXISTS chat_groups (
  id         BIGSERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS chat_group_members (
  group_id  BIGINT NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
  user_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, user_id)
);

-- 群里的已读用「读到哪条了」而不是每条一行：
-- 每条消息 × 每个成员一行，几千条消息就是几万行，而这里真正要回答的问题
-- 只有两个 —— 有多少条没看、这条有几个人看过 —— 一个游标就够。
CREATE TABLE IF NOT EXISTS chat_group_reads (
  group_id     BIGINT NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_id BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (group_id, user_id)
);

-- 消息表扩展：群聊、@、撤回、编辑
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS group_id    BIGINT REFERENCES chat_groups(id) ON DELETE CASCADE;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS mentions    BIGINT[];
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS edited_at   TIMESTAMPTZ;
-- 撤回是软删：内容清空但保留一行「XX 撤回了一条消息」。
-- 硬删（删除）不留痕，两者是不同的动作，见 routes/chat.mjs。
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS recalled_at TIMESTAMPTZ;
-- 群消息没有单一收件人，to_id 必须可空
ALTER TABLE chat_messages ALTER COLUMN to_id DROP NOT NULL;
CREATE INDEX IF NOT EXISTS idx_chat_group ON chat_messages(group_id, id DESC);

-- 「删除」是「我自己不看了」，不是「谁都看不到」——后者叫撤回。
-- 所以删除记在这张表里（谁把哪条从自己视野里删了），消息本体一动不动，
-- 对方那边照常显示。合并成 chat_messages 上的一个字段做不到这件事。
CREATE TABLE IF NOT EXISTS chat_deletes (
  message_id BIGINT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, user_id)
);

-- ---------- 会话 ----------
-- 会话存在数据库里而不是签名 cookie 里，因为要能「踢下线」：
-- 同事离职或密码泄露时，删一行就立刻失效。签名 cookie 做不到这件事。
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,                       -- 32 字节随机数的十六进制
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  user_agent  TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user_idx    ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at);

-- ============================================================
--  第一版团队资料库（《技术3｜IdeaHub团队资料库｜第一版任务表》）
--
--  这一段解决任务表里互相卡住的四件事：
--    · 标签字典        —— 各页面各写一套下拉，跨模块叫法对不上（任务 3）
--    · 来源三件套      —— 资料追溯不到出处，技术1/2 也无法幂等写入（任务 4）
--    · 通用关联        —— 需求↔视频↔案例↔客户只能靠人脑记（任务 8）
--    · 用户需求        —— 整块缺失（任务 2）
--  全部写成可重复执行的形式，跟这个文件其余部分一样，db:init 跑几次都一样。
-- ============================================================

-- ---------- 标签字典（任务 3） ----------
-- 第一版只开四类。不做成自由文本是整件事的关键：
-- 「分手」和「已分手」在两个模块里各写一次，筛选就永远对不上。
CREATE TABLE IF NOT EXISTS tags (
  id      BIGSERIAL PRIMARY KEY,
  kind    TEXT NOT NULL,          -- relation_stage 关系阶段 | problem_type 问题类型
                                  -- demand 用户需求 | content_type 内容类型
  name    TEXT NOT NULL,
  sort    INT  NOT NULL DEFAULT 0,
  active  BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (kind, name)
);
CREATE INDEX IF NOT EXISTS idx_tags_kind ON tags(kind, sort, id);

-- 打标关系：一张表服务所有模块。
-- 每张业务表各加一个 tag_ids 列的话，加一个模块就要改一次查询逻辑，
-- 而「按标签跨模块筛选」会退化成对每张表分别写一遍 SQL。
CREATE TABLE IF NOT EXISTS entity_tags (
  entity     TEXT   NOT NULL,     -- idea | demand | client | case | work
  entity_id  BIGINT NOT NULL,
  tag_id     BIGINT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (entity, entity_id, tag_id)
);
-- 反向查（这个标签下都有什么）走这个索引
CREATE INDEX IF NOT EXISTS idx_entity_tags_tag ON entity_tags(tag_id, entity, entity_id);

-- 第一版的基础标签。ON CONFLICT DO NOTHING：管理员改过名字的不会被这里覆盖回去。
INSERT INTO tags(kind, name, sort) VALUES
  ('relation_stage','暧昧期',10),('relation_stage','热恋期',20),('relation_stage','冷淡期',30),
  ('relation_stage','冷战中',40),('relation_stage','已分手',50),('relation_stage','挽回中',60),
  ('relation_stage','复合后',70),('relation_stage','婚姻中',80),
  ('problem_type','判断对方态度',10),('problem_type','断联',20),('problem_type','冷暴力',30),
  ('problem_type','异地',40),('problem_type','第三者',50),('problem_type','家庭反对',60),
  ('problem_type','沟通冲突',70),('problem_type','推进不动',80),
  ('demand','想复合',10),('demand','想判断要不要继续',20),('demand','想让关系升温',30),
  ('demand','想被重视',40),('demand','想体面退出',50),('demand','想识别对方真实想法',60),
  ('content_type','强判断内容',10),('content_type','识人内容',20),('content_type','案例拆解',30),
  ('content_type','方法论内容',40),('content_type','情绪共鸣',50),('content_type','答疑',60)
ON CONFLICT (kind, name) DO NOTHING;

-- ---------- 来源三件套（任务 4） ----------
-- source_type 回答「这条资料哪来的」，source_url 保住原始链接，
-- source_ref 存上游系统里的 id —— 技术1/技术2 重复推送时靠它幂等，不会建出两条。
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ideas','clients','cases','works'] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT ''manual''', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS source_url  TEXT', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS source_ref  TEXT', t);
  END LOOP;
END $$;
-- 同一个上游 id 只能对应一条记录 —— 这是「不重复建档」的硬保证，
-- 光在应用层判断，两个请求同时到就还是会建出两条。
CREATE UNIQUE INDEX IF NOT EXISTS idx_ideas_source_ref  ON ideas(source_type, source_ref) WHERE source_ref IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_cases_source_ref  ON cases(source_type, source_ref) WHERE source_ref IS NOT NULL;

-- ---------- 通用关联（任务 8） ----------
-- 不做关系图，就是一张「谁和谁有关」的表。
-- 存双向还是单向：只存一条，查询时两头都查（见 routes/links.mjs），
-- 存两条的代价是删除时要记得删两条，早晚漏一条变成单向的幽灵关联。
CREATE TABLE IF NOT EXISTS links (
  id          BIGSERIAL PRIMARY KEY,
  from_entity TEXT   NOT NULL,
  from_id     BIGINT NOT NULL,
  to_entity   TEXT   NOT NULL,
  to_id       BIGINT NOT NULL,
  note        TEXT,
  created_by  BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (from_entity, from_id, to_entity, to_id)
);
CREATE INDEX IF NOT EXISTS idx_links_from ON links(from_entity, from_id);
CREATE INDEX IF NOT EXISTS idx_links_to   ON links(to_entity, to_id);

-- ---------- 用户需求（任务 2） ----------
-- 字段严格照任务表原文，一个不多：
-- 需求名称、用户原话/证据、发生场景、用户真正想解决什么、来源、相关标签、备注。
-- 标签走 entity_tags，来源走上面的三件套。
CREATE TABLE IF NOT EXISTS demands (
  id          BIGSERIAL PRIMARY KEY,
  title       TEXT NOT NULL,               -- 需求名称
  quote       TEXT,                        -- 用户原话 / 证据
  scene       TEXT,                        -- 发生场景
  real_goal   TEXT,                        -- 用户真正想解决什么
  note        TEXT,
  source_type TEXT NOT NULL DEFAULT 'manual',
  source_url  TEXT,
  source_ref  TEXT,
  created_by  BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_demands_time ON demands(created_at DESC) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_demands_source_ref ON demands(source_type, source_ref) WHERE source_ref IS NOT NULL;

-- ---------- 客户档案补齐（任务 9 / 10） ----------
-- AI 情况分析和 AI 用户分析必须分开存：任务表明确要求「分别显示」，
-- 合成一个字段之后就再也拆不开了。
ALTER TABLE clients ADD COLUMN IF NOT EXISTS ai_situation TEXT;      -- 技术2 写入
ALTER TABLE clients ADD COLUMN IF NOT EXISTS ai_user      TEXT;      -- 技术2 写入
ALTER TABLE clients ADD COLUMN IF NOT EXISTS ai_updated_at TIMESTAMPTZ;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS deal         JSONB NOT NULL DEFAULT '{}'::jsonb;  -- 消费 / 成交
ALTER TABLE clients ADD COLUMN IF NOT EXISTS external_id  TEXT;      -- 技术2 那边的客户 id
CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_external ON clients(external_id) WHERE external_id IS NOT NULL;

-- 交付记录：客户详情页的一个区。写成表而不是 JSONB 数组，
-- 因为它是一条条追加的流水，JSONB 数组每次追加都要读出整份再写回。
CREATE TABLE IF NOT EXISTS client_deliveries (
  id          BIGSERIAL PRIMARY KEY,
  client_id   BIGINT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  happened_at DATE NOT NULL DEFAULT current_date,
  kind        TEXT,                        -- 咨询 / 陪跑 / 复盘 / 其他
  summary     TEXT NOT NULL,
  created_by  BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_client_deliveries ON client_deliveries(client_id, happened_at DESC);

-- ---------- 机器身份（任务 10 / 11） ----------
-- 技术1 和技术2 是两个独立系统，不能让它们拿着某个同事的登录 cookie 来写数据 ——
-- 那个人一改密码对接就断了，而且日志里查不出到底是谁写的。
-- 只存 key 的 sha256，明文只在创建那一刻返回一次。
CREATE TABLE IF NOT EXISTS api_keys (
  id           BIGSERIAL PRIMARY KEY,
  name         TEXT NOT NULL,              -- 技术1 / 技术2
  key_hash     TEXT NOT NULL UNIQUE,
  scopes       TEXT[] NOT NULL DEFAULT '{}',   -- tech1 | tech2
  created_by   BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);

-- ---------- 灵感软删（任务 14） ----------
-- 软删而不是真删：业务人员误删一条能捞回来，
-- 而且 idea_activities / links 里指向它的记录不会变成断头指针。
ALTER TABLE ideas ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_ideas_alive ON ideas(status, created_at DESC) WHERE deleted_at IS NULL;

-- 转正式之后原灵感要留在池子里显示「已转正式」（任务 7），
-- 靠这一列记住它是从哪条灵感转过去的 —— 同一行改 status 的做法下，
-- 这列指向自己，前端据此在灵感池里保留一张标着「已转正式」的卡片。
ALTER TABLE ideas ADD COLUMN IF NOT EXISTS promoted_at TIMESTAMPTZ;

-- 技术1 推对标作品也要幂等（放在这里而不是上面那个循环里，
-- 是因为 works 的唯一性还要带上 channel —— 同一个视频可能同时是矩阵和真人的对标）
CREATE UNIQUE INDEX IF NOT EXISTS idx_works_source_ref
  ON works(source_type, source_ref) WHERE source_ref IS NOT NULL;

-- ---------- 工作提交补三个字段（任务 13） ----------
-- 任务表原文：「内容只保留做了什么、结果链接/产物、遇到的问题、需要协助什么。
-- 不要再堆大量字段。」—— 前一项已有（title + summary），补后三项，到此为止。
ALTER TABLE work_reports ADD COLUMN IF NOT EXISTS result_url TEXT;   -- 结果链接 / 产物
ALTER TABLE work_reports ADD COLUMN IF NOT EXISTS blockers   TEXT;   -- 遇到的问题
ALTER TABLE work_reports ADD COLUMN IF NOT EXISTS need_help  TEXT;   -- 需要协助什么

-- 历史已采纳的灵感补一个 promoted_at，否则「已转正式」这个视角对老数据是空的
UPDATE ideas SET promoted_at = adopted_at
 WHERE status = 'adopted' AND promoted_at IS NULL AND adopted_at IS NOT NULL;

-- ---------- 客户 / 案例 / 作品 / 话术 改为软删（任务 14） ----------
-- 任务表的细节栏要求「客户、案例等核心页面都要能删除无用记录」，
-- 原来这几张表是管理员限定的硬删。放开给所有人之后必须配软删 ——
-- 硬删 + 人人可删 = 迟早有人手滑删掉一条谁也说不清内容的客户档案。
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['clients','cases','works','playbook_items','channel_accounts'] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ', t);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%s_alive ON %I(id) WHERE deleted_at IS NULL', t, t);
  END LOOP;
END $$;

-- ============================================================
--  技术1 推过来的完整采集分析结果（对标作品）
-- ============================================================
-- 技术1 的一份分析结果（schema_version 13）大约 30KB：带时间码的逐字稿、
-- 评论原文、AI 的视频七问和评论五问。这些东西挂在 works 上会有一个具体的后果 ——
-- /api/works 是列表接口，翻一次对标列表要吐几十条，每条都捎着一份逐字稿，
-- 一屏就是几百 KB。所以拆成一张一对一的附属表：
--   列表只查 works（和以前一样快），点开某一条才去拉这张表。
--
-- payload 原样收下整份 JSON，一个字段都不丢 —— 技术1 以后往里加字段，
-- 后端不用改也不会丢数据，前端想显示新字段时它已经在库里了。
-- digest 是从 payload 里摘出来的一小块（账号、互动数、一句话主题），
-- 专门给列表卡片用：卡片要显示这些，但不该为此把整份 payload 传下来。
CREATE TABLE IF NOT EXISTS work_analyses (
  work_id     BIGINT PRIMARY KEY REFERENCES works(id) ON DELETE CASCADE,
  task_id     TEXT,                                  -- 技术1 那边的 task_id，排查时两边对得上
  platform    TEXT,                                  -- 原始平台标识（xiaohongshu / douyin …）
  schema_ver  INT,                                   -- 技术1 的 schema_version，格式换代时认得出来
  -- 刻意是 JSON 而不是 JSONB：jsonb 会把对象的键重新排序，
  -- 而技术1 那份 ai_analysis.items 的**键顺序就是该显示的顺序**
  -- （「这条主要讲什么」在最前、「还能延伸做什么」在最后）。
  -- 存成 jsonb 之后七问会变成乱序，读的人根本不知道少了什么逻辑。
  -- 这一列只整份读写、从不按键查询，用 json 没有任何损失。
  payload     JSON NOT NULL,                         -- 原样的整份 JSON，键顺序也原样
  digest      JSONB NOT NULL DEFAULT '{}'::jsonb,    -- 卡片要用的摘要
  -- 封面图落到本地之后的文件名。
  -- 平台的封面地址是带时间签名的（路径里就写着 /202608251136/），过几天就 404 ——
  -- 直接存那个 URL 的话，今天推进来的对标卡片明天就变成一块空白色块。
  -- 所以收到时立刻把图下下来，之后一律走 GET /api/works/:id/cover。
  cover_file  TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_work_analyses_task ON work_analyses(task_id);
