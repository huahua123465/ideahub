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
  source_url  TEXT,
  uploaded_by BIGINT REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- CREATE TABLE IF NOT EXISTS 不会给旧表补字段，现有库也要幂等补上。
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS source_url TEXT;
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

-- ============================================================
--  内容样本研究库（阶段一：原始档案）
--
--  samples 是规范化后的唯一作品；每次采集/手录都追加一条 capture，原始证据不覆盖。
--  大媒体只在仓库外目录保存，数据库仅记录不可猜测的 storage_key 和完整性摘要。
-- ============================================================

CREATE TABLE IF NOT EXISTS samples (
  id                    BIGSERIAL PRIMARY KEY,
  canonical_key         TEXT NOT NULL,
  platform              TEXT NOT NULL DEFAULT 'manual',
  platform_content_id   TEXT,
  source_url            TEXT,
  title                 TEXT,
  body_text             TEXT,
  content_type          TEXT,
  account_name          TEXT,
  account_handle        TEXT,
  published_at          TIMESTAMPTZ,
  metrics               JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_ingest_method   TEXT NOT NULL DEFAULT 'manual',
  last_ingest_method    TEXT NOT NULL DEFAULT 'manual',
  completeness_score    SMALLINT NOT NULL DEFAULT 0,
  missing_fields        TEXT[] NOT NULL DEFAULT '{}',
  archive_status        TEXT NOT NULL DEFAULT 'partial',
  created_by            BIGINT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at            TIMESTAMPTZ,
  CONSTRAINT samples_completeness_score_chk CHECK (completeness_score BETWEEN 0 AND 100),
  CONSTRAINT samples_archive_status_chk CHECK (archive_status IN ('partial','usable','complete')),
  CONSTRAINT samples_ingest_method_chk CHECK (
    first_ingest_method IN ('manual','link','upload','collector','legacy') AND
    last_ingest_method IN ('manual','link','upload','collector','legacy')
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS samples_canonical_key_uidx ON samples(canonical_key);
CREATE INDEX IF NOT EXISTS samples_alive_time_idx
  ON samples(COALESCE(published_at,created_at) DESC,id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS samples_platform_alive_idx
  ON samples(platform,COALESCE(published_at,created_at) DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS samples_archive_status_idx
  ON samples(archive_status,completeness_score DESC) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS sample_captures (
  id                    BIGSERIAL PRIMARY KEY,
  sample_id             BIGINT NOT NULL REFERENCES samples(id) ON DELETE RESTRICT,
  capture_key           TEXT,
  capture_type          TEXT NOT NULL,
  captured_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_url            TEXT,
  raw_payload           JSON NOT NULL DEFAULT '{}'::json,
  normalized_payload    JSONB NOT NULL DEFAULT '{}'::jsonb,
  payload_sha256        TEXT NOT NULL,
  completeness_score    SMALLINT NOT NULL DEFAULT 0,
  missing_fields        TEXT[] NOT NULL DEFAULT '{}',
  created_by            BIGINT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sample_captures_type_chk CHECK (capture_type IN ('manual','link','upload','collector','legacy')),
  CONSTRAINT sample_captures_score_chk CHECK (completeness_score BETWEEN 0 AND 100),
  CONSTRAINT sample_captures_sha256_chk CHECK (payload_sha256 ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS sample_captures_key_uidx
  ON sample_captures(sample_id,capture_key) WHERE capture_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS sample_captures_sample_time_idx
  ON sample_captures(sample_id,captured_at DESC,id DESC);

CREATE TABLE IF NOT EXISTS sample_assets (
  id                BIGSERIAL PRIMARY KEY,
  sample_id         BIGINT NOT NULL REFERENCES samples(id) ON DELETE RESTRICT,
  capture_id        BIGINT REFERENCES sample_captures(id) ON DELETE SET NULL,
  kind              TEXT NOT NULL,
  storage_key       TEXT NOT NULL,
  original_name     TEXT,
  mime_type         TEXT NOT NULL DEFAULT 'application/octet-stream',
  byte_size         BIGINT NOT NULL,
  sha256            TEXT NOT NULL,
  width             INT,
  height            INT,
  duration_ms       BIGINT,
  source_url        TEXT,
  archive_quality   TEXT NOT NULL DEFAULT 'unknown',
  uploaded_by       BIGINT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ,
  CONSTRAINT sample_assets_kind_chk CHECK (kind IN ('cover','image','video','audio','other')),
  CONSTRAINT sample_assets_quality_chk CHECK (archive_quality IN (
    'original','original_images','platform_available','platform_archive','bounded_720p',
    'preview','user_upload','unavailable','unknown'
  )),
  CONSTRAINT sample_assets_size_chk CHECK (byte_size >= 0),
  CONSTRAINT sample_assets_dimensions_chk CHECK (
    (width IS NULL OR width >= 0) AND (height IS NULL OR height >= 0) AND
    (duration_ms IS NULL OR duration_ms >= 0)
  ),
  CONSTRAINT sample_assets_sha256_chk CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT sample_assets_storage_key_chk CHECK (storage_key ~ '^[0-9a-f]{48}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS sample_assets_storage_key_uidx ON sample_assets(storage_key);
CREATE INDEX IF NOT EXISTS sample_assets_sample_kind_idx
  ON sample_assets(sample_id,kind,created_at,id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS sample_assets_capture_idx
  ON sample_assets(capture_id) WHERE capture_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS sample_assets_sha256_idx ON sample_assets(sha256);

-- 用户表可能由单独的基础 schema 创建；用命名约束和目录检查保证重复执行安全。
DO $$ BEGIN
  IF to_regclass('public.users') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='samples_created_by_fk'
  ) THEN
    ALTER TABLE samples ADD CONSTRAINT samples_created_by_fk
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
  IF to_regclass('public.users') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='sample_captures_created_by_fk'
  ) THEN
    ALTER TABLE sample_captures ADD CONSTRAINT sample_captures_created_by_fk
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
  IF to_regclass('public.users') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='sample_assets_uploaded_by_fk'
  ) THEN
    ALTER TABLE sample_assets ADD CONSTRAINT sample_assets_uploaded_by_fk
      FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

ALTER TABLE works ADD COLUMN IF NOT EXISTS sample_id BIGINT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='works_sample_id_fk') THEN
    ALTER TABLE works ADD CONSTRAINT works_sample_id_fk
      FOREIGN KEY (sample_id) REFERENCES samples(id) ON DELETE SET NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS works_sample_id_idx ON works(sample_id) WHERE sample_id IS NOT NULL;

-- ============================================================
--  内容样本研究库（阶段二：结构化拆解、标签、评价与趋势）
--
--  分析版本与原始 capture 一样只追加、不覆盖。一个 complete 版本固定包含
--  下面字典中的 15 个维度；AI 原值、证据和人工决定分别保存。
-- ============================================================

-- ---------- 固定的 15 维研究字典 ----------
CREATE TABLE IF NOT EXISTS sample_analysis_dimensions (
  dimension_key TEXT PRIMARY KEY,
  ordinal       SMALLINT NOT NULL UNIQUE,
  label         TEXT NOT NULL,
  description   TEXT NOT NULL,
  CONSTRAINT sample_analysis_dimensions_key_chk CHECK (dimension_key IN (
    'audience','user_need','topic','core_viewpoint','breakout_point',
    'title_mechanism','opening_method','content_structure','argumentation_method',
    'language_style','length','layout','visual_style','bgm','cta'
  )),
  CONSTRAINT sample_analysis_dimensions_ordinal_chk CHECK (ordinal BETWEEN 1 AND 15),
  CONSTRAINT sample_analysis_dimensions_label_chk CHECK (char_length(label) BETWEEN 1 AND 40)
);

INSERT INTO sample_analysis_dimensions(dimension_key,ordinal,label,description) VALUES
  ('audience',1,'用户对象','作品主要面向的用户群体与所处情境'),
  ('user_need',2,'用户需求','用户希望被解决的显性或隐性需求'),
  ('topic',3,'选题','作品讨论的核心议题与内容边界'),
  ('core_viewpoint',4,'核心观点','作者希望受众接受的核心判断'),
  ('breakout_point',5,'爆点','最容易引发停留、传播或讨论的机制'),
  ('title_mechanism',6,'标题机制','标题吸引点击所使用的结构与承诺'),
  ('opening_method',7,'开头方式','内容建立注意力和进入主题的方式'),
  ('content_structure',8,'内容结构','信息与段落的组织顺序'),
  ('argumentation_method',9,'论证方式','支撑观点所使用的证据和推理方式'),
  ('language_style',10,'语言风格','措辞、语气、节奏与表达姿态'),
  ('length',11,'篇幅','内容长度及信息密度特征'),
  ('layout',12,'排版','文字、段落、字幕和版面组织'),
  ('visual_style',13,'视觉风格','画面、人物、色彩、构图和视觉模板'),
  ('bgm',14,'BGM','背景音乐的存在、类型与功能'),
  ('cta',15,'CTA','引导评论、关注、私信或转化的动作')
ON CONFLICT (dimension_key) DO NOTHING;

-- 复合外键用于保证 capture / asset / version 确实属于同一篇 sample。
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='sample_captures_sample_id_id_uk') THEN
    ALTER TABLE sample_captures ADD CONSTRAINT sample_captures_sample_id_id_uk UNIQUE(sample_id,id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='sample_assets_sample_id_id_uk') THEN
    ALTER TABLE sample_assets ADD CONSTRAINT sample_assets_sample_id_id_uk UNIQUE(sample_id,id);
  END IF;
END $$;

-- ---------- AI / 人工分析任务 ----------
CREATE TABLE IF NOT EXISTS sample_analysis_jobs (
  id                  BIGSERIAL PRIMARY KEY,
  sample_id           BIGINT NOT NULL REFERENCES samples(id) ON DELETE RESTRICT,
  source_capture_id   BIGINT NOT NULL,
  idempotency_key     TEXT NOT NULL,
  input_sha256        TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'queued',
  attempts            SMALLINT NOT NULL DEFAULT 0,
  max_attempts        SMALLINT NOT NULL DEFAULT 3,
  select_on_success   BOOLEAN NOT NULL DEFAULT true,
  provider            TEXT,
  model_name          TEXT,
  requested_by        BIGINT REFERENCES users(id) ON DELETE SET NULL,
  started_at          TIMESTAMPTZ,
  finished_at         TIMESTAMPTZ,
  error_code          TEXT,
  error_message       TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sample_analysis_jobs_capture_fk FOREIGN KEY(sample_id,source_capture_id)
    REFERENCES sample_captures(sample_id,id) ON DELETE RESTRICT,
  CONSTRAINT sample_analysis_jobs_status_chk CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  CONSTRAINT sample_analysis_jobs_attempts_chk CHECK (
    attempts BETWEEN 0 AND 20 AND max_attempts BETWEEN 1 AND 20 AND attempts <= max_attempts
  ),
  CONSTRAINT sample_analysis_jobs_idempotency_chk CHECK (char_length(idempotency_key) BETWEEN 1 AND 160),
  CONSTRAINT sample_analysis_jobs_input_sha256_chk CHECK (input_sha256 ~ '^[0-9a-f]{64}$')
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='sample_analysis_jobs_sample_capture_id_uk') THEN
    ALTER TABLE sample_analysis_jobs ADD CONSTRAINT sample_analysis_jobs_sample_capture_id_uk
      UNIQUE(sample_id,source_capture_id,id);
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS sample_analysis_jobs_idempotency_uidx
  ON sample_analysis_jobs(sample_id,idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS sample_analysis_jobs_one_active_uidx
  ON sample_analysis_jobs(sample_id) WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS sample_analysis_jobs_status_time_idx
  ON sample_analysis_jobs(status,created_at,id);
CREATE INDEX IF NOT EXISTS sample_analysis_jobs_capture_idx
  ON sample_analysis_jobs(source_capture_id);

-- ---------- 不可变分析版本 ----------
CREATE TABLE IF NOT EXISTS sample_analysis_versions (
  id                  BIGSERIAL PRIMARY KEY,
  sample_id           BIGINT NOT NULL REFERENCES samples(id) ON DELETE RESTRICT,
  job_id              BIGINT REFERENCES sample_analysis_jobs(id) ON DELETE RESTRICT,
  source_capture_id   BIGINT NOT NULL,
  revision            INT NOT NULL,
  source              TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'building',
  input_sha256        TEXT NOT NULL,
  schema_version      TEXT NOT NULL,
  prompt_version      TEXT,
  model_provider      TEXT,
  model_name          TEXT,
  model_version       TEXT,
  manifest_sha256     TEXT NOT NULL,
  created_by          BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at        TIMESTAMPTZ,
  CONSTRAINT sample_analysis_versions_capture_fk FOREIGN KEY(sample_id,source_capture_id)
    REFERENCES sample_captures(sample_id,id) ON DELETE RESTRICT,
  CONSTRAINT sample_analysis_versions_job_fk FOREIGN KEY(sample_id,source_capture_id,job_id)
    REFERENCES sample_analysis_jobs(sample_id,source_capture_id,id) ON DELETE RESTRICT,
  CONSTRAINT sample_analysis_versions_source_chk CHECK (source IN ('ai','manual','legacy')),
  CONSTRAINT sample_analysis_versions_source_job_chk CHECK (
    (source='ai' AND job_id IS NOT NULL) OR (source IN ('manual','legacy') AND job_id IS NULL)
  ),
  CONSTRAINT sample_analysis_versions_status_chk CHECK (status IN ('building','complete')),
  CONSTRAINT sample_analysis_versions_revision_chk CHECK (revision > 0),
  CONSTRAINT sample_analysis_versions_input_sha256_chk CHECK (input_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT sample_analysis_versions_manifest_sha256_chk CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT sample_analysis_versions_ai_metadata_chk CHECK (
    source <> 'ai' OR (prompt_version IS NOT NULL AND model_provider IS NOT NULL AND model_name IS NOT NULL AND model_version IS NOT NULL)
  ),
  CONSTRAINT sample_analysis_versions_completion_chk CHECK (
    (status='building' AND completed_at IS NULL) OR (status='complete' AND completed_at IS NOT NULL)
  ),
  CONSTRAINT sample_analysis_versions_sample_revision_uk UNIQUE(sample_id,revision),
  CONSTRAINT sample_analysis_versions_sample_id_id_uk UNIQUE(sample_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS sample_analysis_versions_job_uidx
  ON sample_analysis_versions(job_id) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS sample_analysis_versions_sample_time_idx
  ON sample_analysis_versions(sample_id,revision DESC,id DESC);
CREATE INDEX IF NOT EXISTS sample_analysis_versions_capture_idx
  ON sample_analysis_versions(source_capture_id);

-- ---------- 每版固定 15 行元素 ----------
CREATE TABLE IF NOT EXISTS sample_analysis_elements (
  id                  BIGSERIAL PRIMARY KEY,
  version_id          BIGINT NOT NULL REFERENCES sample_analysis_versions(id) ON DELETE RESTRICT,
  dimension_key       TEXT NOT NULL REFERENCES sample_analysis_dimensions(dimension_key) ON DELETE RESTRICT,
  state               TEXT NOT NULL DEFAULT 'insufficient',
  value_json          JSONB,
  function_text       TEXT,
  confidence          NUMERIC(4,3),
  evidence_strength   TEXT NOT NULL DEFAULT 'none',
  applicability       TEXT,
  limitations         TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sample_analysis_elements_state_chk CHECK (state IN ('value','insufficient','not_applicable')),
  CONSTRAINT sample_analysis_elements_value_chk CHECK (
    (state='value' AND value_json IS NOT NULL AND value_json <> 'null'::jsonb) OR
    (state IN ('insufficient','not_applicable') AND value_json IS NULL)
  ),
  CONSTRAINT sample_analysis_elements_confidence_chk CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  CONSTRAINT sample_analysis_elements_evidence_strength_chk CHECK (
    evidence_strength IN ('none','weak','medium','strong')
  ),
  CONSTRAINT sample_analysis_elements_version_dimension_uk UNIQUE(version_id,dimension_key),
  CONSTRAINT sample_analysis_elements_version_id_id_dimension_uk UNIQUE(version_id,id,dimension_key),
  CONSTRAINT sample_analysis_elements_version_id_id_uk UNIQUE(version_id,id)
);
CREATE INDEX IF NOT EXISTS sample_analysis_elements_dimension_idx
  ON sample_analysis_elements(dimension_key,version_id);
CREATE INDEX IF NOT EXISTS sample_analysis_elements_value_gin_idx
  ON sample_analysis_elements USING GIN(value_json jsonb_path_ops);

-- ---------- Evidence Manifest ----------
CREATE TABLE IF NOT EXISTS sample_evidence_sources (
  id                  BIGSERIAL PRIMARY KEY,
  version_id          BIGINT NOT NULL REFERENCES sample_analysis_versions(id) ON DELETE RESTRICT,
  sample_id           BIGINT NOT NULL,
  source_capture_id   BIGINT NOT NULL,
  asset_id            BIGINT,
  source_id           TEXT NOT NULL,
  source_kind         TEXT NOT NULL,
  locator             JSONB NOT NULL,
  content_sha256      TEXT NOT NULL,
  content_length      BIGINT,
  display_label       TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sample_evidence_sources_version_fk FOREIGN KEY(sample_id,version_id)
    REFERENCES sample_analysis_versions(sample_id,id) ON DELETE RESTRICT,
  CONSTRAINT sample_evidence_sources_capture_fk FOREIGN KEY(sample_id,source_capture_id)
    REFERENCES sample_captures(sample_id,id) ON DELETE RESTRICT,
  CONSTRAINT sample_evidence_sources_asset_fk FOREIGN KEY(sample_id,asset_id)
    REFERENCES sample_assets(sample_id,id) ON DELETE RESTRICT,
  CONSTRAINT sample_evidence_sources_kind_chk CHECK (
    source_kind IN ('body','ocr','transcript','comment','metadata','asset')
  ),
  CONSTRAINT sample_evidence_sources_source_id_chk CHECK (char_length(source_id) BETWEEN 1 AND 120),
  CONSTRAINT sample_evidence_sources_sha256_chk CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT sample_evidence_sources_length_chk CHECK (content_length IS NULL OR content_length >= 0),
  CONSTRAINT sample_evidence_sources_locator_chk CHECK (jsonb_typeof(locator)='object'),
  CONSTRAINT sample_evidence_sources_version_source_uk UNIQUE(version_id,source_id)
);
CREATE INDEX IF NOT EXISTS sample_evidence_sources_capture_idx
  ON sample_evidence_sources(source_capture_id,version_id);
CREATE INDEX IF NOT EXISTS sample_evidence_sources_asset_idx
  ON sample_evidence_sources(asset_id) WHERE asset_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS sample_evidence_sources_locator_gin_idx
  ON sample_evidence_sources USING GIN(locator jsonb_path_ops);

CREATE TABLE IF NOT EXISTS sample_element_evidence (
  id                    BIGSERIAL PRIMARY KEY,
  version_id            BIGINT NOT NULL,
  element_id            BIGINT NOT NULL,
  source_id             TEXT NOT NULL,
  verification_status   TEXT NOT NULL DEFAULT 'unresolved',
  quote_text            TEXT,
  quote_sha256          TEXT,
  start_offset          INT,
  end_offset            INT,
  time_start_ms         BIGINT,
  time_end_ms           BIGINT,
  json_path             TEXT,
  comment_ref           TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sample_element_evidence_element_fk FOREIGN KEY(version_id,element_id)
    REFERENCES sample_analysis_elements(version_id,id) ON DELETE RESTRICT,
  CONSTRAINT sample_element_evidence_source_fk FOREIGN KEY(version_id,source_id)
    REFERENCES sample_evidence_sources(version_id,source_id) ON DELETE RESTRICT,
  CONSTRAINT sample_element_evidence_status_chk CHECK (
    verification_status IN ('verified','unresolved','invalid')
  ),
  CONSTRAINT sample_element_evidence_quote_chk CHECK (
    verification_status <> 'verified' OR
    (quote_text IS NOT NULL AND char_length(quote_text) > 0 AND quote_sha256 ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT sample_element_evidence_quote_sha256_chk CHECK (
    quote_sha256 IS NULL OR quote_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT sample_element_evidence_offsets_chk CHECK (
    (start_offset IS NULL AND end_offset IS NULL) OR
    (start_offset IS NOT NULL AND end_offset IS NOT NULL AND start_offset >= 0 AND end_offset >= start_offset)
  ),
  CONSTRAINT sample_element_evidence_times_chk CHECK (
    (time_start_ms IS NULL AND time_end_ms IS NULL) OR
    (time_start_ms IS NOT NULL AND time_end_ms IS NOT NULL AND time_start_ms >= 0 AND time_end_ms >= time_start_ms)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS sample_element_evidence_identity_uidx
  ON sample_element_evidence(
    element_id,source_id,
    COALESCE(start_offset,-1),COALESCE(end_offset,-1),
    COALESCE(time_start_ms,-1),COALESCE(time_end_ms,-1),
    COALESCE(json_path,''),COALESCE(comment_ref,'')
  );
CREATE INDEX IF NOT EXISTS sample_element_evidence_element_idx
  ON sample_element_evidence(element_id,verification_status,id);

-- ---------- 人工确认 / 修订 / 驳回（只追加） ----------
CREATE TABLE IF NOT EXISTS sample_element_decisions (
  id                  BIGSERIAL PRIMARY KEY,
  element_id          BIGINT NOT NULL REFERENCES sample_analysis_elements(id) ON DELETE RESTRICT,
  decision            TEXT NOT NULL,
  value_json          JSONB,
  function_text       TEXT,
  applicability       TEXT,
  limitations         TEXT,
  note                TEXT,
  idempotency_key     TEXT,
  decided_by          BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sample_element_decisions_decision_chk CHECK (decision IN ('confirmed','edited','rejected')),
  CONSTRAINT sample_element_decisions_value_chk CHECK (
    (decision='edited' AND value_json IS NOT NULL AND value_json <> 'null'::jsonb) OR
    (decision IN ('confirmed','rejected') AND value_json IS NULL)
  ),
  CONSTRAINT sample_element_decisions_idempotency_chk CHECK (
    idempotency_key IS NULL OR char_length(idempotency_key) BETWEEN 1 AND 160
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS sample_element_decisions_idempotency_uidx
  ON sample_element_decisions(element_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS sample_element_decisions_latest_idx
  ON sample_element_decisions(element_id,created_at DESC,id DESC);

-- ---------- 版本化的元素标签 ----------
CREATE TABLE IF NOT EXISTS sample_element_tags (
  id                  BIGSERIAL PRIMARY KEY,
  version_id          BIGINT NOT NULL,
  element_id          BIGINT NOT NULL,
  dimension_key       TEXT NOT NULL,
  tag_id              BIGINT NOT NULL REFERENCES tags(id) ON DELETE RESTRICT,
  origin              TEXT NOT NULL,
  confidence          NUMERIC(4,3),
  idempotency_key     TEXT,
  created_by          BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sample_element_tags_element_fk FOREIGN KEY(version_id,element_id,dimension_key)
    REFERENCES sample_analysis_elements(version_id,id,dimension_key) ON DELETE RESTRICT,
  CONSTRAINT sample_element_tags_origin_chk CHECK (origin IN ('ai','manual','legacy')),
  CONSTRAINT sample_element_tags_confidence_chk CHECK (
    confidence IS NULL OR confidence BETWEEN 0 AND 1
  ),
  CONSTRAINT sample_element_tags_manual_confidence_chk CHECK (
    origin <> 'manual' OR confidence IS NULL
  ),
  CONSTRAINT sample_element_tags_ai_confidence_chk CHECK (
    origin <> 'ai' OR confidence IS NOT NULL
  ),
  CONSTRAINT sample_element_tags_idempotency_chk CHECK (
    idempotency_key IS NULL OR char_length(idempotency_key) BETWEEN 1 AND 160
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS sample_element_tags_identity_uidx
  ON sample_element_tags(element_id,tag_id,origin);
CREATE UNIQUE INDEX IF NOT EXISTS sample_element_tags_idempotency_uidx
  ON sample_element_tags(version_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS sample_element_tags_tag_idx
  ON sample_element_tags(tag_id,dimension_key,version_id);
CREATE INDEX IF NOT EXISTS sample_element_tags_element_idx
  ON sample_element_tags(element_id,id);

-- ---------- current 版本选择审计 ----------
ALTER TABLE samples ADD COLUMN IF NOT EXISTS current_analysis_version_id BIGINT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='samples_current_analysis_version_fk') THEN
    ALTER TABLE samples ADD CONSTRAINT samples_current_analysis_version_fk
      FOREIGN KEY(id,current_analysis_version_id)
      REFERENCES sample_analysis_versions(sample_id,id) ON DELETE RESTRICT;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS samples_current_analysis_version_idx
  ON samples(current_analysis_version_id) WHERE current_analysis_version_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS sample_analysis_selections (
  id                  BIGSERIAL PRIMARY KEY,
  sample_id           BIGINT NOT NULL REFERENCES samples(id) ON DELETE RESTRICT,
  version_id          BIGINT NOT NULL,
  reason              TEXT NOT NULL,
  selected_by         BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sample_analysis_selections_version_fk FOREIGN KEY(sample_id,version_id)
    REFERENCES sample_analysis_versions(sample_id,id) ON DELETE RESTRICT,
  CONSTRAINT sample_analysis_selections_reason_chk CHECK (reason IN ('run_success','explicit','migration'))
);
CREATE INDEX IF NOT EXISTS sample_analysis_selections_sample_time_idx
  ON sample_analysis_selections(sample_id,created_at DESC,id DESC);

-- ---------- 按四类目标独立追加的评价 ----------
CREATE TABLE IF NOT EXISTS sample_evaluations (
  id                  BIGSERIAL PRIMARY KEY,
  sample_id           BIGINT NOT NULL REFERENCES samples(id) ON DELETE RESTRICT,
  analysis_version_id BIGINT,
  target              TEXT NOT NULL,
  source              TEXT NOT NULL,
  revision            INT NOT NULL,
  summary             TEXT,
  strengths           JSONB NOT NULL DEFAULT '[]'::jsonb,
  weaknesses          JSONB NOT NULL DEFAULT '[]'::jsonb,
  worth_learning      JSONB NOT NULL DEFAULT '[]'::jsonb,
  avoid_copying       JSONB NOT NULL DEFAULT '[]'::jsonb,
  effect_hypotheses   JSONB NOT NULL DEFAULT '[]'::jsonb,
  evidence_source_ids TEXT[] NOT NULL DEFAULT '{}',
  confidence          NUMERIC(4,3),
  input_sha256        TEXT,
  prompt_version      TEXT,
  model_provider      TEXT,
  model_name          TEXT,
  created_by          BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sample_evaluations_version_fk FOREIGN KEY(sample_id,analysis_version_id)
    REFERENCES sample_analysis_versions(sample_id,id) ON DELETE RESTRICT,
  CONSTRAINT sample_evaluations_target_chk CHECK (target IN ('traffic','persona','expertise','conversion')),
  CONSTRAINT sample_evaluations_source_chk CHECK (source IN ('ai','manual')),
  CONSTRAINT sample_evaluations_revision_chk CHECK (revision > 0),
  CONSTRAINT sample_evaluations_arrays_chk CHECK (
    jsonb_typeof(strengths)='array' AND jsonb_typeof(weaknesses)='array' AND
    jsonb_typeof(worth_learning)='array' AND jsonb_typeof(avoid_copying)='array' AND
    jsonb_typeof(effect_hypotheses)='array'
  ),
  CONSTRAINT sample_evaluations_confidence_chk CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  CONSTRAINT sample_evaluations_input_sha256_chk CHECK (
    input_sha256 IS NULL OR input_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT sample_evaluations_source_metadata_chk CHECK (
    (source='manual' AND confidence IS NULL AND input_sha256 IS NULL AND prompt_version IS NULL
      AND model_provider IS NULL AND model_name IS NULL) OR
    (source='ai' AND confidence IS NOT NULL AND input_sha256 IS NOT NULL AND prompt_version IS NOT NULL
      AND model_provider IS NOT NULL AND model_name IS NOT NULL)
  ),
  CONSTRAINT sample_evaluations_sample_target_revision_uk UNIQUE(sample_id,target,revision)
);
CREATE INDEX IF NOT EXISTS sample_evaluations_sample_target_idx
  ON sample_evaluations(sample_id,target,revision DESC,id DESC);
CREATE INDEX IF NOT EXISTS sample_evaluations_analysis_version_idx
  ON sample_evaluations(analysis_version_id) WHERE analysis_version_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS sample_evaluations_hypotheses_gin_idx
  ON sample_evaluations USING GIN(effect_hypotheses jsonb_path_ops);

-- ---------- 每次 capture / 手工补录产生一个可空指标快照 ----------
CREATE TABLE IF NOT EXISTS sample_metric_snapshots (
  id                  BIGSERIAL PRIMARY KEY,
  sample_id           BIGINT NOT NULL REFERENCES samples(id) ON DELETE RESTRICT,
  capture_id          BIGINT,
  snapshot_key        TEXT,
  observed_at         TIMESTAMPTZ NOT NULL,
  likes               BIGINT,
  saves               BIGINT,
  comments            BIGINT,
  shares              BIGINT,
  views               BIGINT,
  raw_metrics         JSONB NOT NULL DEFAULT '{}'::jsonb,
  parse_warnings      TEXT[] NOT NULL DEFAULT '{}',
  created_by          BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sample_metric_snapshots_capture_fk FOREIGN KEY(sample_id,capture_id)
    REFERENCES sample_captures(sample_id,id) ON DELETE RESTRICT,
  CONSTRAINT sample_metric_snapshots_values_chk CHECK (
    (likes IS NULL OR likes >= 0) AND (saves IS NULL OR saves >= 0) AND
    (comments IS NULL OR comments >= 0) AND (shares IS NULL OR shares >= 0) AND
    (views IS NULL OR views >= 0)
  ),
  CONSTRAINT sample_metric_snapshots_identity_chk CHECK (capture_id IS NOT NULL OR snapshot_key IS NOT NULL),
  CONSTRAINT sample_metric_snapshots_key_chk CHECK (
    snapshot_key IS NULL OR char_length(snapshot_key) BETWEEN 1 AND 160
  ),
  CONSTRAINT sample_metric_snapshots_raw_chk CHECK (jsonb_typeof(raw_metrics)='object')
);
CREATE UNIQUE INDEX IF NOT EXISTS sample_metric_snapshots_capture_uidx
  ON sample_metric_snapshots(capture_id) WHERE capture_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS sample_metric_snapshots_key_uidx
  ON sample_metric_snapshots(sample_id,snapshot_key) WHERE snapshot_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS sample_metric_snapshots_sample_time_idx
  ON sample_metric_snapshots(sample_id,observed_at,id);
CREATE INDEX IF NOT EXISTS sample_metric_snapshots_raw_gin_idx
  ON sample_metric_snapshots USING GIN(raw_metrics jsonb_path_ops);

-- ---------- 数据库级不可变性和完整性门槛 ----------
CREATE OR REPLACE FUNCTION sample_analysis_guard_version_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status='complete' THEN
    RAISE EXCEPTION 'complete sample analysis versions are immutable';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
DROP TRIGGER IF EXISTS sample_analysis_versions_immutable_trg ON sample_analysis_versions;
CREATE TRIGGER sample_analysis_versions_immutable_trg
  BEFORE UPDATE OR DELETE ON sample_analysis_versions
  FOR EACH ROW EXECUTE FUNCTION sample_analysis_guard_version_immutable();

CREATE OR REPLACE FUNCTION sample_analysis_guard_version_child()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_version_id BIGINT; v_status TEXT; v_source TEXT; v_capture BIGINT; v_old_status TEXT;
BEGIN
  IF TG_OP='UPDATE' THEN
    SELECT status INTO v_old_status FROM sample_analysis_versions WHERE id=OLD.version_id;
    IF v_old_status='complete' THEN
      RAISE EXCEPTION 'children of complete sample analysis versions are immutable';
    END IF;
  END IF;
  v_version_id := CASE WHEN TG_OP='DELETE' THEN OLD.version_id ELSE NEW.version_id END;
  SELECT status,source,source_capture_id INTO v_status,v_source,v_capture
    FROM sample_analysis_versions WHERE id=v_version_id;
  IF v_status='complete' THEN
    RAISE EXCEPTION 'children of complete sample analysis versions are immutable';
  END IF;
  IF TG_OP<>'DELETE' AND TG_TABLE_NAME='sample_analysis_elements'
     AND v_source='manual' AND (to_jsonb(NEW)->>'confidence') IS NOT NULL THEN
    RAISE EXCEPTION 'manual analysis element confidence must be NULL';
  END IF;
  IF TG_OP<>'DELETE' AND TG_TABLE_NAME='sample_evidence_sources'
     AND (to_jsonb(NEW)->>'source_capture_id')::BIGINT <> v_capture THEN
    RAISE EXCEPTION 'evidence source capture must match analysis version capture';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
DROP TRIGGER IF EXISTS sample_analysis_elements_guard_trg ON sample_analysis_elements;
CREATE TRIGGER sample_analysis_elements_guard_trg
  BEFORE INSERT OR UPDATE OR DELETE ON sample_analysis_elements
  FOR EACH ROW EXECUTE FUNCTION sample_analysis_guard_version_child();
DROP TRIGGER IF EXISTS sample_evidence_sources_guard_trg ON sample_evidence_sources;
CREATE TRIGGER sample_evidence_sources_guard_trg
  BEFORE INSERT OR UPDATE OR DELETE ON sample_evidence_sources
  FOR EACH ROW EXECUTE FUNCTION sample_analysis_guard_version_child();
DROP TRIGGER IF EXISTS sample_element_evidence_guard_trg ON sample_element_evidence;
CREATE TRIGGER sample_element_evidence_guard_trg
  BEFORE INSERT OR UPDATE OR DELETE ON sample_element_evidence
  FOR EACH ROW EXECUTE FUNCTION sample_analysis_guard_version_child();

CREATE OR REPLACE FUNCTION sample_analysis_validate_completion()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_count INT; v_bad_ai INT;
BEGIN
  IF TG_OP='INSERT' AND NEW.status='complete' THEN
    RAISE EXCEPTION 'analysis versions must be created as building before completion';
  END IF;
  IF TG_OP='INSERT' AND NEW.source='ai' AND NOT EXISTS (
    SELECT 1 FROM sample_analysis_jobs j
     WHERE j.id=NEW.job_id AND j.sample_id=NEW.sample_id
       AND j.source_capture_id=NEW.source_capture_id AND j.input_sha256=NEW.input_sha256
  ) THEN
    RAISE EXCEPTION 'AI analysis version must preserve its job input and capture';
  END IF;
  IF TG_OP='UPDATE' AND NEW.status='complete' AND OLD.status IS DISTINCT FROM 'complete' THEN
    SELECT count(*) INTO v_count FROM sample_analysis_elements WHERE version_id=NEW.id;
    IF v_count <> 15 THEN
      RAISE EXCEPTION 'a complete analysis version must contain exactly 15 dimensions (got %)',v_count;
    END IF;
    IF NEW.source='ai' THEN
      SELECT count(*) INTO v_bad_ai
        FROM sample_analysis_elements e
       WHERE e.version_id=NEW.id AND e.confidence IS NULL;
      IF v_bad_ai > 0 THEN
        RAISE EXCEPTION 'AI analysis dimensions require confidence';
      END IF;
      SELECT count(*) INTO v_bad_ai
        FROM sample_analysis_elements e
       WHERE e.version_id=NEW.id
         AND NOT EXISTS (
           SELECT 1 FROM sample_element_evidence ee
            WHERE ee.version_id=NEW.id AND ee.element_id=e.id
              AND ee.verification_status='verified'
         )
         AND (e.state <> 'insufficient' OR e.confidence IS NULL OR e.confidence > 0.2);
      IF v_bad_ai > 0 THEN
        RAISE EXCEPTION 'AI dimensions without verified evidence must be insufficient with confidence <= 0.2';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS sample_analysis_versions_completion_trg ON sample_analysis_versions;
CREATE TRIGGER sample_analysis_versions_completion_trg
  BEFORE INSERT OR UPDATE ON sample_analysis_versions
  FOR EACH ROW EXECUTE FUNCTION sample_analysis_validate_completion();

CREATE OR REPLACE FUNCTION sample_analysis_guard_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are append-only',TG_TABLE_NAME;
END $$;
DROP TRIGGER IF EXISTS sample_analysis_dimensions_immutable_trg ON sample_analysis_dimensions;
CREATE TRIGGER sample_analysis_dimensions_immutable_trg
  BEFORE UPDATE OR DELETE ON sample_analysis_dimensions
  FOR EACH ROW EXECUTE FUNCTION sample_analysis_guard_append_only();
DROP TRIGGER IF EXISTS sample_element_decisions_append_only_trg ON sample_element_decisions;
CREATE TRIGGER sample_element_decisions_append_only_trg
  BEFORE UPDATE OR DELETE ON sample_element_decisions
  FOR EACH ROW EXECUTE FUNCTION sample_analysis_guard_append_only();
DROP TRIGGER IF EXISTS sample_element_tags_append_only_trg ON sample_element_tags;
CREATE TRIGGER sample_element_tags_append_only_trg
  BEFORE UPDATE OR DELETE ON sample_element_tags
  FOR EACH ROW EXECUTE FUNCTION sample_analysis_guard_append_only();
DROP TRIGGER IF EXISTS sample_analysis_selections_append_only_trg ON sample_analysis_selections;
CREATE TRIGGER sample_analysis_selections_append_only_trg
  BEFORE UPDATE OR DELETE ON sample_analysis_selections
  FOR EACH ROW EXECUTE FUNCTION sample_analysis_guard_append_only();
DROP TRIGGER IF EXISTS sample_evaluations_append_only_trg ON sample_evaluations;
CREATE TRIGGER sample_evaluations_append_only_trg
  BEFORE UPDATE OR DELETE ON sample_evaluations
  FOR EACH ROW EXECUTE FUNCTION sample_analysis_guard_append_only();
DROP TRIGGER IF EXISTS sample_metric_snapshots_append_only_trg ON sample_metric_snapshots;
CREATE TRIGGER sample_metric_snapshots_append_only_trg
  BEFORE UPDATE OR DELETE ON sample_metric_snapshots
  FOR EACH ROW EXECUTE FUNCTION sample_analysis_guard_append_only();

CREATE OR REPLACE FUNCTION sample_element_tags_validate()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_kind TEXT; v_active BOOLEAN; v_version_status TEXT;
BEGIN
  SELECT kind,active INTO v_kind,v_active FROM tags WHERE id=NEW.tag_id;
  IF v_kind IS DISTINCT FROM NEW.dimension_key THEN
    RAISE EXCEPTION 'element tag kind must equal its analysis dimension';
  END IF;
  IF NEW.origin='ai' AND NOT COALESCE(v_active,false) THEN
    RAISE EXCEPTION 'AI may only reference an existing active tag';
  END IF;
  SELECT status INTO v_version_status FROM sample_analysis_versions WHERE id=NEW.version_id;
  IF NEW.origin IN ('ai','legacy') AND v_version_status IS DISTINCT FROM 'building' THEN
    RAISE EXCEPTION 'AI and legacy element tags must be fixed before version completion';
  END IF;
  IF NEW.origin='manual' AND v_version_status IS DISTINCT FROM 'complete' THEN
    RAISE EXCEPTION 'manual element tags may only review complete versions';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS sample_element_tags_validate_trg ON sample_element_tags;
CREATE TRIGGER sample_element_tags_validate_trg
  BEFORE INSERT ON sample_element_tags
  FOR EACH ROW EXECUTE FUNCTION sample_element_tags_validate();

CREATE OR REPLACE FUNCTION sample_element_decisions_validate()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status TEXT;
BEGIN
  SELECT v.status INTO v_status
    FROM sample_analysis_elements e
    JOIN sample_analysis_versions v ON v.id=e.version_id
   WHERE e.id=NEW.element_id;
  IF v_status IS DISTINCT FROM 'complete' THEN
    RAISE EXCEPTION 'manual decisions may only review complete analysis versions';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS sample_element_decisions_validate_trg ON sample_element_decisions;
CREATE TRIGGER sample_element_decisions_validate_trg
  BEFORE INSERT ON sample_element_decisions
  FOR EACH ROW EXECUTE FUNCTION sample_element_decisions_validate();

CREATE OR REPLACE FUNCTION sample_analysis_apply_selection()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status TEXT; v_job_status TEXT; v_select BOOLEAN;
BEGIN
  SELECT v.status,j.status,j.select_on_success INTO v_status,v_job_status,v_select
    FROM sample_analysis_versions v
    LEFT JOIN sample_analysis_jobs j ON j.id=v.job_id
   WHERE v.sample_id=NEW.sample_id AND v.id=NEW.version_id;
  IF v_status IS DISTINCT FROM 'complete' THEN
    RAISE EXCEPTION 'only complete analysis versions can become current';
  END IF;
  IF NEW.reason='run_success' AND (v_job_status IS DISTINCT FROM 'succeeded' OR v_select IS DISTINCT FROM true) THEN
    RAISE EXCEPTION 'run_success selection requires a succeeded select-on-success job';
  END IF;
  UPDATE samples SET current_analysis_version_id=NEW.version_id,updated_at=now()
   WHERE id=NEW.sample_id;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS sample_analysis_apply_selection_trg ON sample_analysis_selections;
CREATE TRIGGER sample_analysis_apply_selection_trg
  AFTER INSERT ON sample_analysis_selections
  FOR EACH ROW EXECUTE FUNCTION sample_analysis_apply_selection();

CREATE OR REPLACE FUNCTION samples_validate_current_analysis_version()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status TEXT;
BEGIN
  IF NEW.current_analysis_version_id IS NULL THEN RETURN NEW; END IF;
  SELECT status INTO v_status FROM sample_analysis_versions
   WHERE sample_id=NEW.id AND id=NEW.current_analysis_version_id;
  IF v_status IS DISTINCT FROM 'complete' THEN
    RAISE EXCEPTION 'samples.current_analysis_version_id must reference a complete version';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS samples_validate_current_analysis_version_trg ON samples;
CREATE TRIGGER samples_validate_current_analysis_version_trg
  BEFORE INSERT OR UPDATE OF current_analysis_version_id ON samples
  FOR EACH ROW EXECUTE FUNCTION samples_validate_current_analysis_version();

-- 标签名扩到 80 字，并为 15 个元素开放与维度同名的标签类型。
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='tags_kind_length_chk') THEN
    ALTER TABLE tags ADD CONSTRAINT tags_kind_length_chk CHECK (char_length(kind) BETWEEN 1 AND 64) NOT VALID;
    ALTER TABLE tags VALIDATE CONSTRAINT tags_kind_length_chk;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='tags_name_length_chk') THEN
    ALTER TABLE tags ADD CONSTRAINT tags_name_length_chk CHECK (char_length(name) BETWEEN 1 AND 80) NOT VALID;
    ALTER TABLE tags VALIDATE CONSTRAINT tags_name_length_chk;
  END IF;
END $$;

INSERT INTO tags(kind,name,sort) VALUES
  ('audience','女性用户',10),('audience','关系困惑用户',20),
  ('user_need','关系判断需求',10),('user_need','情绪共鸣需求',20),('user_need','行动方案需求',30),
  ('topic','女性情感赛道',10),('topic','亲密关系',20),('topic','个人成长',30),
  ('core_viewpoint','强结论',10),('core_viewpoint','反常识',20),('core_viewpoint','方法论',30),
  ('breakout_point','痛点命中',10),('breakout_point','身份认同',20),('breakout_point','结果承诺',30),
  ('title_mechanism','强结论标题',10),('title_mechanism','反差标题',20),('title_mechanism','数字清单标题',30),
  ('opening_method','直接结论',10),('opening_method','问题切入',20),('opening_method','案例切入',30),
  ('content_structure','案例拆解结构',10),('content_structure','总分总结构',20),('content_structure','步骤清单结构',30),
  ('argumentation_method','案例论证',10),('argumentation_method','对比论证',20),('argumentation_method','因果论证',30),
  ('language_style','口语化',10),('language_style','专业解释',20),('language_style','情绪共鸣',30),
  ('length','短内容',10),('length','中等篇幅',20),('length','长内容',30),
  ('layout','短句分段',10),('layout','清单排版',20),('layout','小标题排版',30),
  ('visual_style','真人口播',10),('visual_style','图文卡片',20),('visual_style','知识板书',30),
  ('bgm','无BGM',10),('bgm','情绪氛围',20),('bgm','节奏型',30),
  ('cta','互动提问',10),('cta','关注引导',20),('cta','私信转化',30)
ON CONFLICT (kind,name) DO NOTHING;

-- ============================================================
--  内容样本研究库（阶段三：比较、关系、局部提取与组件）
--  同步来源：scripts/migrations/20260829-sample-library-stage3.sql
-- ============================================================
-- IdeaHub sample library, stage 3.
-- Additive and safe to run repeatedly. Run after Stage 1 and Stage 2 migrations.
-- Existing Stage 1/2 rows are not rewritten.

BEGIN;

-- Composite identities needed by the Stage 3 ownership graph.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='sample_element_decisions_element_id_id_uk'
    AND conrelid='sample_element_decisions'::regclass) THEN
    ALTER TABLE sample_element_decisions ADD CONSTRAINT sample_element_decisions_element_id_id_uk UNIQUE(element_id,id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='sample_element_evidence_version_id_id_uk'
    AND conrelid='sample_element_evidence'::regclass) THEN
    ALTER TABLE sample_element_evidence ADD CONSTRAINT sample_element_evidence_version_id_id_uk UNIQUE(version_id,id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='sample_metric_snapshots_sample_id_id_uk'
    AND conrelid='sample_metric_snapshots'::regclass) THEN
    ALTER TABLE sample_metric_snapshots ADD CONSTRAINT sample_metric_snapshots_sample_id_id_uk UNIQUE(sample_id,id);
  END IF;
END $$;

-- One retry contract for every Stage 3 mutating HTTP action.
CREATE TABLE IF NOT EXISTS sample_stage3_idempotency (
  id                BIGSERIAL PRIMARY KEY,
  aggregate_key     TEXT NOT NULL,
  action             TEXT NOT NULL,
  idempotency_key    TEXT NOT NULL,
  request_sha256     TEXT NOT NULL,
  response_kind      TEXT,
  response_id        BIGINT,
  response_status    SMALLINT,
  created_by         BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sample_stage3_idempotency_aggregate_chk CHECK (char_length(aggregate_key) BETWEEN 1 AND 160),
  CONSTRAINT sample_stage3_idempotency_action_chk CHECK (char_length(action) BETWEEN 1 AND 80),
  CONSTRAINT sample_stage3_idempotency_key_chk CHECK (char_length(idempotency_key) BETWEEN 1 AND 160),
  CONSTRAINT sample_stage3_idempotency_hash_chk CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT sample_stage3_idempotency_status_chk CHECK (response_status IS NULL OR response_status BETWEEN 200 AND 299),
  CONSTRAINT sample_stage3_idempotency_identity_uk UNIQUE(aggregate_key,action,idempotency_key)
);

CREATE TABLE IF NOT EXISTS sample_comparisons (
  id                BIGSERIAL PRIMARY KEY,
  title             TEXT NOT NULL,
  purpose           TEXT,
  created_by        BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ,
  deleted_by        BIGINT REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT sample_comparisons_title_chk CHECK (char_length(title) BETWEEN 1 AND 200),
  CONSTRAINT sample_comparisons_purpose_chk CHECK (purpose IS NULL OR char_length(purpose) <= 4000)
);
CREATE INDEX IF NOT EXISTS sample_comparisons_created_idx ON sample_comparisons(created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS sample_comparisons_active_created_idx
  ON sample_comparisons(created_at DESC,id DESC) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS sample_comparison_scopes (
  id                BIGSERIAL PRIMARY KEY,
  comparison_id     BIGINT NOT NULL REFERENCES sample_comparisons(id) ON DELETE RESTRICT,
  revision          INT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'building',
  topic_basis       TEXT NOT NULL,
  purpose           TEXT,
  input_sha256      TEXT NOT NULL,
  created_by        BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at      TIMESTAMPTZ,
  CONSTRAINT sample_comparison_scopes_revision_chk CHECK (revision > 0),
  CONSTRAINT sample_comparison_scopes_status_chk CHECK (status IN ('building','complete')),
  CONSTRAINT sample_comparison_scopes_topic_chk CHECK (char_length(topic_basis) BETWEEN 1 AND 160),
  CONSTRAINT sample_comparison_scopes_purpose_chk CHECK (purpose IS NULL OR char_length(purpose) <= 4000),
  CONSTRAINT sample_comparison_scopes_hash_chk CHECK (input_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT sample_comparison_scopes_completion_chk CHECK (
    (status='building' AND completed_at IS NULL) OR (status='complete' AND completed_at IS NOT NULL)
  ),
  CONSTRAINT sample_comparison_scopes_comparison_revision_uk UNIQUE(comparison_id,revision),
  CONSTRAINT sample_comparison_scopes_comparison_id_id_uk UNIQUE(comparison_id,id)
);
CREATE INDEX IF NOT EXISTS sample_comparison_scopes_project_idx
  ON sample_comparison_scopes(comparison_id,revision DESC,id DESC);

CREATE TABLE IF NOT EXISTS sample_comparison_scope_members (
  id                    BIGSERIAL PRIMARY KEY,
  comparison_id         BIGINT NOT NULL,
  scope_id              BIGINT NOT NULL,
  sample_id             BIGINT NOT NULL REFERENCES samples(id) ON DELETE RESTRICT,
  analysis_version_id   BIGINT NOT NULL,
  ordinal               SMALLINT NOT NULL,
  frozen_title          TEXT NOT NULL,
  frozen_account_name   TEXT,
  frozen_account_handle TEXT,
  frozen_platform       TEXT NOT NULL,
  frozen_published_at   TIMESTAMPTZ,
  metric_snapshot_id    BIGINT,
  frozen_metric_observed_at TIMESTAMPTZ,
  observation_window_seconds BIGINT,
  frozen_metrics        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sample_comparison_scope_members_scope_fk FOREIGN KEY(comparison_id,scope_id)
    REFERENCES sample_comparison_scopes(comparison_id,id) ON DELETE RESTRICT,
  CONSTRAINT sample_comparison_scope_members_analysis_fk FOREIGN KEY(sample_id,analysis_version_id)
    REFERENCES sample_analysis_versions(sample_id,id) ON DELETE RESTRICT,
  CONSTRAINT sample_comparison_scope_members_metric_fk FOREIGN KEY(sample_id,metric_snapshot_id)
    REFERENCES sample_metric_snapshots(sample_id,id) ON DELETE RESTRICT,
  CONSTRAINT sample_comparison_scope_members_ordinal_chk CHECK (ordinal BETWEEN 1 AND 6),
  CONSTRAINT sample_comparison_scope_members_title_chk CHECK (char_length(frozen_title) BETWEEN 1 AND 500),
  CONSTRAINT sample_comparison_scope_members_window_chk CHECK (observation_window_seconds IS NULL OR observation_window_seconds >= 0),
  CONSTRAINT sample_comparison_scope_members_metrics_chk CHECK (jsonb_typeof(frozen_metrics)='object'),
  CONSTRAINT sample_comparison_scope_members_scope_ordinal_uk UNIQUE(scope_id,ordinal),
  CONSTRAINT sample_comparison_scope_members_scope_sample_uk UNIQUE(scope_id,sample_id),
  CONSTRAINT sample_comparison_scope_members_owner_uk UNIQUE(comparison_id,scope_id,sample_id,analysis_version_id),
  CONSTRAINT sample_comparison_scope_members_scope_id_id_uk UNIQUE(scope_id,id)
);
CREATE INDEX IF NOT EXISTS sample_comparison_scope_members_sample_idx
  ON sample_comparison_scope_members(sample_id,scope_id);

CREATE TABLE IF NOT EXISTS sample_comparison_snapshots (
  id                    BIGSERIAL PRIMARY KEY,
  comparison_id         BIGINT NOT NULL,
  scope_id              BIGINT NOT NULL,
  sample_id             BIGINT NOT NULL,
  analysis_version_id   BIGINT NOT NULL,
  element_id            BIGINT NOT NULL,
  dimension_key         TEXT NOT NULL REFERENCES sample_analysis_dimensions(dimension_key) ON DELETE RESTRICT,
  latest_decision_id    BIGINT,
  effective_state       TEXT NOT NULL,
  effective_value       JSONB,
  function_text         TEXT,
  applicability         TEXT,
  limitations           TEXT,
  evidence_state        TEXT NOT NULL,
  evidence_tokens       JSONB NOT NULL DEFAULT '[]'::jsonb,
  value_sha256          TEXT NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sample_comparison_snapshots_member_fk FOREIGN KEY(comparison_id,scope_id,sample_id,analysis_version_id)
    REFERENCES sample_comparison_scope_members(comparison_id,scope_id,sample_id,analysis_version_id) ON DELETE RESTRICT,
  CONSTRAINT sample_comparison_snapshots_element_fk FOREIGN KEY(analysis_version_id,element_id,dimension_key)
    REFERENCES sample_analysis_elements(version_id,id,dimension_key) ON DELETE RESTRICT,
  CONSTRAINT sample_comparison_snapshots_decision_fk FOREIGN KEY(element_id,latest_decision_id)
    REFERENCES sample_element_decisions(element_id,id) ON DELETE RESTRICT,
  CONSTRAINT sample_comparison_snapshots_state_chk CHECK (effective_state IN ('value','insufficient','not_applicable','rejected')),
  CONSTRAINT sample_comparison_snapshots_value_chk CHECK (
    (effective_state='value' AND effective_value IS NOT NULL AND effective_value <> 'null'::jsonb) OR
    (effective_state<>'value' AND effective_value IS NULL)
  ),
  CONSTRAINT sample_comparison_snapshots_evidence_state_chk CHECK (evidence_state IN ('verified','manual_unverified','insufficient')),
  CONSTRAINT sample_comparison_snapshots_tokens_chk CHECK (jsonb_typeof(evidence_tokens)='array' AND jsonb_array_length(evidence_tokens) <= 20),
  CONSTRAINT sample_comparison_snapshots_hash_chk CHECK (value_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT sample_comparison_snapshots_scope_dimension_uk UNIQUE(scope_id,sample_id,dimension_key),
  CONSTRAINT sample_comparison_snapshots_owner_uk UNIQUE(comparison_id,scope_id,id,dimension_key),
  CONSTRAINT sample_comparison_snapshots_scope_id_id_uk UNIQUE(scope_id,id),
  CONSTRAINT sample_comparison_snapshots_scope_row_identity_uk UNIQUE(scope_id,id,sample_id,dimension_key)
);
CREATE INDEX IF NOT EXISTS sample_comparison_snapshots_dimension_idx
  ON sample_comparison_snapshots(scope_id,dimension_key,sample_id);

-- Four independent comparison targets and their append-only versions.
CREATE TABLE IF NOT EXISTS sample_comparison_assessment_jobs (
  id                BIGSERIAL PRIMARY KEY,
  comparison_id     BIGINT NOT NULL,
  scope_id          BIGINT NOT NULL,
  target            TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'queued',
  request_sha256    TEXT NOT NULL,
  attempts          SMALLINT NOT NULL DEFAULT 0,
  max_attempts      SMALLINT NOT NULL DEFAULT 3,
  provider          TEXT NOT NULL,
  model_name        TEXT NOT NULL,
  lease_owner       TEXT,
  lease_expires_at  TIMESTAMPTZ,
  heartbeat_at      TIMESTAMPTZ,
  error_code        TEXT,
  error_message     TEXT,
  requested_by      BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at        TIMESTAMPTZ,
  finished_at       TIMESTAMPTZ,
  CONSTRAINT sample_comparison_assessment_jobs_scope_fk FOREIGN KEY(comparison_id,scope_id)
    REFERENCES sample_comparison_scopes(comparison_id,id) ON DELETE RESTRICT,
  CONSTRAINT sample_comparison_assessment_jobs_target_chk CHECK (target IN ('traffic','persona','expertise','conversion')),
  CONSTRAINT sample_comparison_assessment_jobs_status_chk CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  CONSTRAINT sample_comparison_assessment_jobs_hash_chk CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT sample_comparison_assessment_jobs_attempts_chk CHECK (attempts BETWEEN 0 AND max_attempts AND max_attempts BETWEEN 1 AND 20),
  CONSTRAINT sample_comparison_assessment_jobs_error_chk CHECK (error_message IS NULL OR char_length(error_message) <= 400)
);
CREATE UNIQUE INDEX IF NOT EXISTS sample_comparison_assessment_jobs_one_scope_target_active_uidx
  ON sample_comparison_assessment_jobs(scope_id,target) WHERE status IN ('queued','running');
CREATE UNIQUE INDEX IF NOT EXISTS sample_comparison_assessment_jobs_one_running_uidx
  ON sample_comparison_assessment_jobs((true)) WHERE status='running';
CREATE INDEX IF NOT EXISTS sample_comparison_assessment_jobs_queue_idx
  ON sample_comparison_assessment_jobs(status,created_at,id);

CREATE TABLE IF NOT EXISTS sample_comparison_assessments (
  id                  BIGSERIAL PRIMARY KEY,
  comparison_id       BIGINT NOT NULL,
  scope_id            BIGINT NOT NULL,
  job_id              BIGINT REFERENCES sample_comparison_assessment_jobs(id) ON DELETE RESTRICT,
  target              TEXT NOT NULL,
  source              TEXT NOT NULL,
  revision            INT NOT NULL,
  common_points       JSONB NOT NULL DEFAULT '[]'::jsonb,
  key_differences     JSONB NOT NULL DEFAULT '[]'::jsonb,
  strengths           JSONB NOT NULL DEFAULT '[]'::jsonb,
  limitations         JSONB NOT NULL DEFAULT '[]'::jsonb,
  worth_learning      JSONB NOT NULL DEFAULT '[]'::jsonb,
  do_not_copy         JSONB NOT NULL DEFAULT '[]'::jsonb,
  hypotheses          JSONB NOT NULL DEFAULT '[]'::jsonb,
  open_questions      JSONB NOT NULL DEFAULT '[]'::jsonb,
  method_limitations  JSONB NOT NULL DEFAULT '[]'::jsonb,
  input_sha256        TEXT NOT NULL,
  schema_version      TEXT NOT NULL,
  prompt_version      TEXT,
  model_provider      TEXT,
  model_name          TEXT,
  created_by          BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sample_comparison_assessments_scope_fk FOREIGN KEY(comparison_id,scope_id)
    REFERENCES sample_comparison_scopes(comparison_id,id) ON DELETE RESTRICT,
  CONSTRAINT sample_comparison_assessments_job_scope_fk FOREIGN KEY(job_id)
    REFERENCES sample_comparison_assessment_jobs(id) ON DELETE RESTRICT,
  CONSTRAINT sample_comparison_assessments_target_chk CHECK (target IN ('traffic','persona','expertise','conversion')),
  CONSTRAINT sample_comparison_assessments_source_chk CHECK (source IN ('manual','ai')),
  CONSTRAINT sample_comparison_assessments_revision_chk CHECK (revision > 0),
  CONSTRAINT sample_comparison_assessments_arrays_chk CHECK (
    jsonb_typeof(common_points)='array' AND jsonb_typeof(key_differences)='array' AND
    jsonb_typeof(strengths)='array' AND jsonb_typeof(limitations)='array' AND
    jsonb_typeof(worth_learning)='array' AND jsonb_typeof(do_not_copy)='array' AND
    jsonb_typeof(hypotheses)='array' AND jsonb_typeof(open_questions)='array' AND
    jsonb_typeof(method_limitations)='array'
  ),
  CONSTRAINT sample_comparison_assessments_hash_chk CHECK (input_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT sample_comparison_assessments_ai_metadata_chk CHECK (
    (source='manual' AND job_id IS NULL AND prompt_version IS NULL AND model_provider IS NULL AND model_name IS NULL) OR
    (source='ai' AND job_id IS NOT NULL AND prompt_version IS NOT NULL AND model_provider IS NOT NULL AND model_name IS NOT NULL)
  ),
  CONSTRAINT sample_comparison_assessments_project_target_revision_uk UNIQUE(comparison_id,target,revision),
  CONSTRAINT sample_comparison_assessments_owner_uk UNIQUE(comparison_id,scope_id,id),
  CONSTRAINT sample_comparison_assessments_project_id_target_uk UNIQUE(comparison_id,id,target)
);
CREATE UNIQUE INDEX IF NOT EXISTS sample_comparison_assessments_job_uidx
  ON sample_comparison_assessments(job_id) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS sample_comparison_assessments_history_idx
  ON sample_comparison_assessments(comparison_id,target,revision DESC,id DESC);

CREATE TABLE IF NOT EXISTS sample_comparison_findings (
  id                BIGSERIAL PRIMARY KEY,
  comparison_id     BIGINT NOT NULL,
  scope_id          BIGINT NOT NULL,
  assessment_id     BIGINT NOT NULL,
  target            TEXT NOT NULL,
  member_sample_id  BIGINT,
  kind              TEXT NOT NULL,
  claim_text        TEXT NOT NULL,
  limitations       TEXT,
  evidence_state    TEXT NOT NULL,
  ordinal           SMALLINT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sample_comparison_findings_assessment_fk FOREIGN KEY(comparison_id,scope_id,assessment_id)
    REFERENCES sample_comparison_assessments(comparison_id,scope_id,id) ON DELETE RESTRICT,
  CONSTRAINT sample_comparison_findings_assessment_target_fk FOREIGN KEY(comparison_id,assessment_id,target)
    REFERENCES sample_comparison_assessments(comparison_id,id,target) ON DELETE RESTRICT,
  CONSTRAINT sample_comparison_findings_member_fk FOREIGN KEY(scope_id,member_sample_id)
    REFERENCES sample_comparison_scope_members(scope_id,sample_id) ON DELETE RESTRICT,
  CONSTRAINT sample_comparison_findings_kind_chk CHECK (kind IN ('observation','hypothesis','recommendation')),
  CONSTRAINT sample_comparison_findings_claim_chk CHECK (char_length(claim_text) BETWEEN 1 AND 4000),
  CONSTRAINT sample_comparison_findings_hypothesis_chk CHECK (kind<>'hypothesis' OR char_length(COALESCE(limitations,'')) BETWEEN 1 AND 12000),
  CONSTRAINT sample_comparison_findings_evidence_chk CHECK (evidence_state IN ('verified','manual_unverified','insufficient')),
  CONSTRAINT sample_comparison_findings_ordinal_chk CHECK (ordinal BETWEEN 1 AND 60),
  CONSTRAINT sample_comparison_findings_order_uk UNIQUE(assessment_id,ordinal),
  CONSTRAINT sample_comparison_findings_owner_uk UNIQUE(assessment_id,id,member_sample_id)
);

CREATE TABLE IF NOT EXISTS sample_comparison_finding_evidence (
  id                BIGSERIAL PRIMARY KEY,
  assessment_id     BIGINT NOT NULL,
  finding_id        BIGINT NOT NULL,
  member_sample_id  BIGINT NOT NULL,
  scope_id          BIGINT NOT NULL,
  snapshot_id       BIGINT NOT NULL,
  dimension_key     TEXT NOT NULL,
  evidence_token    TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sample_comparison_finding_evidence_finding_fk FOREIGN KEY(assessment_id,finding_id,member_sample_id)
    REFERENCES sample_comparison_findings(assessment_id,id,member_sample_id) ON DELETE RESTRICT,
  CONSTRAINT sample_comparison_finding_evidence_snapshot_fk FOREIGN KEY(scope_id,snapshot_id)
    REFERENCES sample_comparison_snapshots(scope_id,id) ON DELETE RESTRICT,
  CONSTRAINT sample_comparison_finding_evidence_snapshot_dimension_fk FOREIGN KEY(scope_id,member_sample_id,dimension_key)
    REFERENCES sample_comparison_snapshots(scope_id,sample_id,dimension_key) ON DELETE RESTRICT,
  CONSTRAINT sample_comparison_finding_evidence_snapshot_owner_fk FOREIGN KEY(scope_id,snapshot_id,member_sample_id,dimension_key)
    REFERENCES sample_comparison_snapshots(scope_id,id,sample_id,dimension_key) ON DELETE RESTRICT,
  CONSTRAINT sample_comparison_finding_evidence_token_chk CHECK (char_length(evidence_token) BETWEEN 1 AND 160),
  CONSTRAINT sample_comparison_finding_evidence_identity_uk UNIQUE(finding_id,snapshot_id,evidence_token)
);

CREATE TABLE IF NOT EXISTS sample_comparison_assessment_selections (
  id                BIGSERIAL PRIMARY KEY,
  comparison_id     BIGINT NOT NULL REFERENCES sample_comparisons(id) ON DELETE RESTRICT,
  target            TEXT NOT NULL,
  assessment_id     BIGINT NOT NULL,
  reason            TEXT,
  selected_by       BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sample_comparison_assessment_selections_assessment_fk FOREIGN KEY(comparison_id,assessment_id,target)
    REFERENCES sample_comparison_assessments(comparison_id,id,target) ON DELETE RESTRICT,
  CONSTRAINT sample_comparison_assessment_selections_target_chk CHECK (target IN ('traffic','persona','expertise','conversion')),
  CONSTRAINT sample_comparison_assessment_selections_reason_chk CHECK (reason IS NULL OR char_length(reason) <= 4000)
);
CREATE INDEX IF NOT EXISTS sample_comparison_assessment_selections_current_idx
  ON sample_comparison_assessment_selections(comparison_id,target,id DESC);

-- Pinned, reviewable sample relations.
CREATE TABLE IF NOT EXISTS sample_relations (
  id                    BIGSERIAL PRIMARY KEY,
  relation_type         TEXT NOT NULL,
  subject_sample_id     BIGINT NOT NULL REFERENCES samples(id) ON DELETE RESTRICT,
  subject_analysis_version_id BIGINT NOT NULL,
  object_sample_id      BIGINT NOT NULL REFERENCES samples(id) ON DELETE RESTRICT,
  object_analysis_version_id BIGINT NOT NULL,
  origin                TEXT NOT NULL,
  current_state         TEXT NOT NULL DEFAULT 'proposed',
  rationale             TEXT,
  proposed_by           BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sample_relations_subject_analysis_fk FOREIGN KEY(subject_sample_id,subject_analysis_version_id)
    REFERENCES sample_analysis_versions(sample_id,id) ON DELETE RESTRICT,
  CONSTRAINT sample_relations_object_analysis_fk FOREIGN KEY(object_sample_id,object_analysis_version_id)
    REFERENCES sample_analysis_versions(sample_id,id) ON DELETE RESTRICT,
  CONSTRAINT sample_relations_type_chk CHECK (relation_type IN ('citation','imitation','evolution','variant')),
  CONSTRAINT sample_relations_origin_chk CHECK (origin IN ('manual','ai')),
  CONSTRAINT sample_relations_state_chk CHECK (current_state IN ('proposed','confirmed','rejected','withdrawn','superseded')),
  CONSTRAINT sample_relations_self_chk CHECK (subject_sample_id <> object_sample_id),
  CONSTRAINT sample_relations_variant_canonical_chk CHECK (relation_type<>'variant' OR subject_sample_id<object_sample_id),
  CONSTRAINT sample_relations_rationale_chk CHECK (rationale IS NULL OR char_length(rationale) <= 12000),
  CONSTRAINT sample_relations_id_endpoints_uk UNIQUE(id,subject_sample_id,subject_analysis_version_id,object_sample_id,object_analysis_version_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS sample_relations_active_identity_uidx
  ON sample_relations(relation_type,subject_sample_id,subject_analysis_version_id,object_sample_id,object_analysis_version_id)
  WHERE current_state NOT IN ('rejected','superseded');
CREATE INDEX IF NOT EXISTS sample_relations_subject_idx ON sample_relations(subject_sample_id,current_state,id DESC);
CREATE INDEX IF NOT EXISTS sample_relations_object_idx ON sample_relations(object_sample_id,current_state,id DESC);

CREATE TABLE IF NOT EXISTS sample_relation_evidence (
  id                    BIGSERIAL PRIMARY KEY,
  relation_id           BIGINT NOT NULL,
  subject_sample_id     BIGINT NOT NULL,
  subject_analysis_version_id BIGINT NOT NULL,
  object_sample_id      BIGINT NOT NULL,
  object_analysis_version_id BIGINT NOT NULL,
  endpoint_sample_id    BIGINT NOT NULL,
  endpoint_analysis_version_id BIGINT NOT NULL,
  element_evidence_id   BIGINT NOT NULL,
  note                  TEXT,
  added_by              BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sample_relation_evidence_relation_fk FOREIGN KEY(
    relation_id,subject_sample_id,subject_analysis_version_id,object_sample_id,object_analysis_version_id)
    REFERENCES sample_relations(id,subject_sample_id,subject_analysis_version_id,object_sample_id,object_analysis_version_id) ON DELETE RESTRICT,
  CONSTRAINT sample_relation_evidence_endpoint_version_fk FOREIGN KEY(endpoint_sample_id,endpoint_analysis_version_id)
    REFERENCES sample_analysis_versions(sample_id,id) ON DELETE RESTRICT,
  CONSTRAINT sample_relation_evidence_verified_fk FOREIGN KEY(endpoint_analysis_version_id,element_evidence_id)
    REFERENCES sample_element_evidence(version_id,id) ON DELETE RESTRICT,
  CONSTRAINT sample_relation_evidence_note_chk CHECK (note IS NULL OR char_length(note) <= 4000),
  CONSTRAINT sample_relation_evidence_identity_uk UNIQUE(relation_id,element_evidence_id)
);

CREATE TABLE IF NOT EXISTS sample_relation_events (
  id                BIGSERIAL PRIMARY KEY,
  relation_id       BIGINT NOT NULL REFERENCES sample_relations(id) ON DELETE RESTRICT,
  event_type        TEXT NOT NULL,
  reason            TEXT,
  actor_id          BIGINT REFERENCES users(id) ON DELETE SET NULL,
  actor_role        TEXT NOT NULL,
  superseded_by_relation_id BIGINT REFERENCES sample_relations(id) ON DELETE RESTRICT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sample_relation_events_type_chk CHECK (event_type IN ('proposed','confirmed','rejected','withdrawn','superseded')),
  CONSTRAINT sample_relation_events_role_chk CHECK (actor_role IN ('member','reviewer','admin','system')),
  CONSTRAINT sample_relation_events_reason_chk CHECK (reason IS NULL OR char_length(reason) <= 4000),
  CONSTRAINT sample_relation_events_supersede_chk CHECK (
    (event_type='superseded' AND superseded_by_relation_id IS NOT NULL AND superseded_by_relation_id<>relation_id) OR
    (event_type<>'superseded' AND superseded_by_relation_id IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS sample_relation_events_history_idx ON sample_relation_events(relation_id,id);

-- Local high-value extracts.
CREATE TABLE IF NOT EXISTS sample_element_extractions (
  id                BIGSERIAL PRIMARY KEY,
  comparison_id     BIGINT NOT NULL,
  scope_id          BIGINT NOT NULL,
  assessment_id     BIGINT,
  dimension_key     TEXT NOT NULL REFERENCES sample_analysis_dimensions(dimension_key) ON DELETE RESTRICT,
  origin            TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'building',
  pattern_text      TEXT NOT NULL,
  function_text     TEXT NOT NULL,
  rationale         TEXT NOT NULL,
  applicability     TEXT NOT NULL,
  limitations       TEXT NOT NULL,
  do_not_copy       TEXT NOT NULL,
  created_by        BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at      TIMESTAMPTZ,
  CONSTRAINT sample_element_extractions_scope_fk FOREIGN KEY(comparison_id,scope_id)
    REFERENCES sample_comparison_scopes(comparison_id,id) ON DELETE RESTRICT,
  CONSTRAINT sample_element_extractions_assessment_fk FOREIGN KEY(comparison_id,scope_id,assessment_id)
    REFERENCES sample_comparison_assessments(comparison_id,scope_id,id) ON DELETE RESTRICT,
  CONSTRAINT sample_element_extractions_origin_chk CHECK (origin IN ('manual','ai')),
  CONSTRAINT sample_element_extractions_status_chk CHECK (status IN ('building','complete')),
  CONSTRAINT sample_element_extractions_completion_chk CHECK (
    (status='building' AND completed_at IS NULL) OR (status='complete' AND completed_at IS NOT NULL)
  ),
  CONSTRAINT sample_element_extractions_fields_chk CHECK (
    char_length(pattern_text) BETWEEN 1 AND 12000 AND char_length(function_text) BETWEEN 1 AND 12000 AND
    char_length(rationale) BETWEEN 1 AND 12000 AND char_length(applicability) BETWEEN 1 AND 12000 AND
    char_length(limitations) BETWEEN 1 AND 12000 AND char_length(do_not_copy) BETWEEN 1 AND 12000
  ),
  CONSTRAINT sample_element_extractions_owner_uk UNIQUE(comparison_id,scope_id,id),
  CONSTRAINT sample_element_extractions_id_dimension_uk UNIQUE(id,dimension_key)
);
CREATE INDEX IF NOT EXISTS sample_element_extractions_list_idx
  ON sample_element_extractions(dimension_key,comparison_id,id DESC) WHERE status='complete';

CREATE TABLE IF NOT EXISTS sample_element_extraction_sources (
  id                BIGSERIAL PRIMARY KEY,
  extraction_id     BIGINT NOT NULL,
  extraction_dimension_key TEXT NOT NULL,
  comparison_id     BIGINT NOT NULL,
  scope_id          BIGINT NOT NULL,
  sample_id         BIGINT NOT NULL,
  snapshot_id       BIGINT NOT NULL,
  snapshot_dimension_key TEXT NOT NULL,
  source_role       TEXT NOT NULL,
  note              TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sample_element_extraction_sources_extraction_fk FOREIGN KEY(extraction_id,extraction_dimension_key)
    REFERENCES sample_element_extractions(id,dimension_key) ON DELETE RESTRICT,
  CONSTRAINT sample_element_extraction_sources_scope_fk FOREIGN KEY(comparison_id,scope_id,extraction_id)
    REFERENCES sample_element_extractions(comparison_id,scope_id,id) ON DELETE RESTRICT,
  CONSTRAINT sample_element_extraction_sources_snapshot_fk FOREIGN KEY(scope_id,snapshot_id)
    REFERENCES sample_comparison_snapshots(scope_id,id) ON DELETE RESTRICT,
  CONSTRAINT sample_element_extraction_sources_snapshot_identity_fk FOREIGN KEY(scope_id,sample_id,snapshot_dimension_key)
    REFERENCES sample_comparison_snapshots(scope_id,sample_id,dimension_key) ON DELETE RESTRICT,
  CONSTRAINT sample_element_extraction_sources_snapshot_owner_fk FOREIGN KEY(scope_id,snapshot_id,sample_id,snapshot_dimension_key)
    REFERENCES sample_comparison_snapshots(scope_id,id,sample_id,dimension_key) ON DELETE RESTRICT,
  CONSTRAINT sample_element_extraction_sources_dimension_chk CHECK (extraction_dimension_key=snapshot_dimension_key),
  CONSTRAINT sample_element_extraction_sources_role_chk CHECK (source_role IN ('primary','supporting','counterexample')),
  CONSTRAINT sample_element_extraction_sources_note_chk CHECK (note IS NULL OR char_length(note) <= 4000),
  CONSTRAINT sample_element_extraction_sources_identity_uk UNIQUE(extraction_id,snapshot_id,source_role)
);

-- Stable component identity, immutable revisions and append-only review/current/lifecycle history.
CREATE TABLE IF NOT EXISTS content_components (
  id                BIGSERIAL PRIMARY KEY,
  name              TEXT NOT NULL,
  lifecycle_state   TEXT NOT NULL DEFAULT 'active',
  created_by        BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT content_components_name_chk CHECK (char_length(name) BETWEEN 1 AND 200),
  CONSTRAINT content_components_lifecycle_chk CHECK (lifecycle_state IN ('active','retired'))
);
CREATE INDEX IF NOT EXISTS content_components_name_idx ON content_components(lower(name),id DESC);

CREATE TABLE IF NOT EXISTS content_component_revisions (
  id                BIGSERIAL PRIMARY KEY,
  component_id      BIGINT NOT NULL REFERENCES content_components(id) ON DELETE RESTRICT,
  revision          INT NOT NULL,
  dimension_key     TEXT NOT NULL REFERENCES sample_analysis_dimensions(dimension_key) ON DELETE RESTRICT,
  origin            TEXT NOT NULL,
  state             TEXT NOT NULL DEFAULT 'draft',
  name              TEXT NOT NULL,
  pattern_text      TEXT NOT NULL,
  function_text     TEXT NOT NULL,
  applicability     TEXT NOT NULL,
  limitations       TEXT NOT NULL,
  do_not_copy       TEXT NOT NULL,
  content_sha256    TEXT NOT NULL,
  created_by        BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT content_component_revisions_revision_chk CHECK (revision > 0),
  CONSTRAINT content_component_revisions_origin_chk CHECK (origin IN ('manual','ai')),
  CONSTRAINT content_component_revisions_state_chk CHECK (state IN ('draft','submitted','approved','changes_requested')),
  CONSTRAINT content_component_revisions_fields_chk CHECK (
    char_length(name) BETWEEN 1 AND 200 AND char_length(pattern_text) BETWEEN 1 AND 12000 AND
    char_length(function_text) BETWEEN 1 AND 12000 AND char_length(applicability) BETWEEN 1 AND 12000 AND
    char_length(limitations) BETWEEN 1 AND 12000 AND char_length(do_not_copy) BETWEEN 1 AND 12000
  ),
  CONSTRAINT content_component_revisions_hash_chk CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT content_component_revisions_component_revision_uk UNIQUE(component_id,revision),
  CONSTRAINT content_component_revisions_component_id_id_uk UNIQUE(component_id,id),
  CONSTRAINT content_component_revisions_id_dimension_uk UNIQUE(id,dimension_key)
);
CREATE INDEX IF NOT EXISTS content_component_revisions_history_idx
  ON content_component_revisions(component_id,revision DESC,id DESC);

CREATE TABLE IF NOT EXISTS content_component_revision_sources (
  id                BIGSERIAL PRIMARY KEY,
  component_id      BIGINT NOT NULL,
  revision_id       BIGINT NOT NULL,
  revision_dimension_key TEXT NOT NULL,
  extraction_id     BIGINT NOT NULL,
  extraction_dimension_key TEXT NOT NULL,
  source_role       TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT content_component_revision_sources_revision_fk FOREIGN KEY(component_id,revision_id)
    REFERENCES content_component_revisions(component_id,id) ON DELETE RESTRICT,
  CONSTRAINT content_component_revision_sources_revision_dimension_fk FOREIGN KEY(revision_id,revision_dimension_key)
    REFERENCES content_component_revisions(id,dimension_key) ON DELETE RESTRICT,
  CONSTRAINT content_component_revision_sources_extraction_fk FOREIGN KEY(extraction_id,extraction_dimension_key)
    REFERENCES sample_element_extractions(id,dimension_key) ON DELETE RESTRICT,
  CONSTRAINT content_component_revision_sources_dimension_chk CHECK (revision_dimension_key=extraction_dimension_key),
  CONSTRAINT content_component_revision_sources_role_chk CHECK (source_role IN ('primary','supporting')),
  CONSTRAINT content_component_revision_sources_identity_uk UNIQUE(revision_id,extraction_id)
);

CREATE TABLE IF NOT EXISTS content_component_revision_tags (
  id                BIGSERIAL PRIMARY KEY,
  component_id      BIGINT NOT NULL,
  revision_id       BIGINT NOT NULL,
  tag_id            BIGINT NOT NULL REFERENCES tags(id) ON DELETE RESTRICT,
  origin            TEXT NOT NULL,
  created_by        BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT content_component_revision_tags_revision_fk FOREIGN KEY(component_id,revision_id)
    REFERENCES content_component_revisions(component_id,id) ON DELETE RESTRICT,
  CONSTRAINT content_component_revision_tags_origin_chk CHECK (origin IN ('manual','ai')),
  CONSTRAINT content_component_revision_tags_identity_uk UNIQUE(revision_id,tag_id)
);
CREATE INDEX IF NOT EXISTS content_component_revision_tags_tag_idx ON content_component_revision_tags(tag_id,revision_id);

CREATE TABLE IF NOT EXISTS content_component_revision_decisions (
  id                BIGSERIAL PRIMARY KEY,
  component_id      BIGINT NOT NULL,
  revision_id       BIGINT NOT NULL,
  decision          TEXT NOT NULL,
  note              TEXT,
  actor_id          BIGINT REFERENCES users(id) ON DELETE SET NULL,
  actor_role        TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT content_component_revision_decisions_revision_fk FOREIGN KEY(component_id,revision_id)
    REFERENCES content_component_revisions(component_id,id) ON DELETE RESTRICT,
  CONSTRAINT content_component_revision_decisions_decision_chk CHECK (decision IN ('submitted','approved','changes_requested')),
  CONSTRAINT content_component_revision_decisions_role_chk CHECK (actor_role IN ('member','reviewer','admin')),
  CONSTRAINT content_component_revision_decisions_note_chk CHECK (note IS NULL OR char_length(note) <= 4000)
);
CREATE INDEX IF NOT EXISTS content_component_revision_decisions_history_idx
  ON content_component_revision_decisions(revision_id,id);

CREATE TABLE IF NOT EXISTS content_component_selections (
  id                BIGSERIAL PRIMARY KEY,
  component_id      BIGINT NOT NULL,
  revision_id       BIGINT NOT NULL,
  decision_id       BIGINT NOT NULL REFERENCES content_component_revision_decisions(id) ON DELETE RESTRICT,
  selected_by       BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT content_component_selections_revision_fk FOREIGN KEY(component_id,revision_id)
    REFERENCES content_component_revisions(component_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS content_component_selections_current_idx
  ON content_component_selections(component_id,id DESC);

CREATE TABLE IF NOT EXISTS content_component_lifecycle_events (
  id                BIGSERIAL PRIMARY KEY,
  component_id      BIGINT NOT NULL REFERENCES content_components(id) ON DELETE RESTRICT,
  event_type        TEXT NOT NULL,
  reason            TEXT,
  actor_id          BIGINT REFERENCES users(id) ON DELETE SET NULL,
  actor_role        TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT content_component_lifecycle_events_type_chk CHECK (event_type IN ('retired','reactivated')),
  CONSTRAINT content_component_lifecycle_events_role_chk CHECK (actor_role='admin'),
  CONSTRAINT content_component_lifecycle_events_reason_chk CHECK (reason IS NULL OR char_length(reason) <= 4000)
);
CREATE INDEX IF NOT EXISTS content_component_lifecycle_events_history_idx
  ON content_component_lifecycle_events(component_id,id);

-- ---------- Database guards ----------
CREATE OR REPLACE FUNCTION sample_stage3_append_only_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are append-only',TG_TABLE_NAME USING ERRCODE='55000';
END $$;

CREATE OR REPLACE FUNCTION sample_comparison_scope_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_member_count INT; v_bad INT;
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.status='complete' THEN RAISE EXCEPTION 'complete comparison scopes are immutable' USING ERRCODE='55000'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='INSERT' AND NEW.status<>'building' THEN
    RAISE EXCEPTION 'comparison scopes must be created as building' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND OLD.status='complete' THEN
    RAISE EXCEPTION 'complete comparison scopes are immutable' USING ERRCODE='55000';
  END IF;
  IF TG_OP='UPDATE' AND NEW.status='complete' AND OLD.status='building' THEN
    SELECT count(*) INTO v_member_count FROM sample_comparison_scope_members WHERE scope_id=NEW.id;
    IF v_member_count NOT BETWEEN 2 AND 6 THEN
      RAISE EXCEPTION 'a complete comparison scope requires 2-6 members (got %)',v_member_count USING ERRCODE='23514';
    END IF;
    SELECT count(*) INTO v_bad FROM sample_comparison_scope_members m
     WHERE m.scope_id=NEW.id AND (
       m.ordinal NOT BETWEEN 1 AND v_member_count OR
       NOT EXISTS (SELECT 1 FROM sample_analysis_versions v WHERE v.id=m.analysis_version_id AND v.sample_id=m.sample_id AND v.status='complete') OR
       NOT EXISTS (SELECT 1 FROM samples s WHERE s.id=m.sample_id AND s.current_analysis_version_id=m.analysis_version_id) OR
       m.metric_snapshot_id IS DISTINCT FROM (
         SELECT ms.id FROM sample_metric_snapshots ms WHERE ms.sample_id=m.sample_id ORDER BY ms.observed_at DESC,ms.id DESC LIMIT 1
       ) OR
       15 <> (SELECT count(*) FROM sample_comparison_snapshots x WHERE x.scope_id=NEW.id AND x.sample_id=m.sample_id) OR
       15 <> (SELECT count(DISTINCT x.dimension_key) FROM sample_comparison_snapshots x WHERE x.scope_id=NEW.id AND x.sample_id=m.sample_id)
     );
    IF v_bad>0 THEN RAISE EXCEPTION 'comparison scope members must freeze current complete analyses, latest metric and exactly 15 dimensions' USING ERRCODE='23514'; END IF;
    SELECT count(*) INTO v_bad FROM sample_comparison_snapshots x
     WHERE x.scope_id=NEW.id AND x.latest_decision_id IS DISTINCT FROM (
       SELECT d.id FROM sample_element_decisions d WHERE d.element_id=x.element_id ORDER BY d.id DESC LIMIT 1
     );
    IF v_bad>0 THEN RAISE EXCEPTION 'comparison snapshots must freeze the latest element decision' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS sample_comparison_scopes_guard_trg ON sample_comparison_scopes;
CREATE TRIGGER sample_comparison_scopes_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON sample_comparison_scopes
  FOR EACH ROW EXECUTE FUNCTION sample_comparison_scope_guard();

CREATE OR REPLACE FUNCTION sample_comparison_scope_child_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_scope BIGINT; v_status TEXT; v_old_status TEXT;
BEGIN
  IF TG_OP='UPDATE' THEN
    SELECT status INTO v_old_status FROM sample_comparison_scopes WHERE id=OLD.scope_id;
    IF v_old_status='complete' THEN RAISE EXCEPTION 'children of complete comparison scopes are immutable' USING ERRCODE='55000'; END IF;
  END IF;
  v_scope := CASE WHEN TG_OP='DELETE' THEN OLD.scope_id ELSE NEW.scope_id END;
  SELECT status INTO v_status FROM sample_comparison_scopes WHERE id=v_scope;
  IF v_status='complete' THEN RAISE EXCEPTION 'children of complete comparison scopes are immutable' USING ERRCODE='55000'; END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
DROP TRIGGER IF EXISTS sample_comparison_scope_members_guard_trg ON sample_comparison_scope_members;
CREATE TRIGGER sample_comparison_scope_members_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON sample_comparison_scope_members
  FOR EACH ROW EXECUTE FUNCTION sample_comparison_scope_child_guard();
DROP TRIGGER IF EXISTS sample_comparison_snapshots_guard_trg ON sample_comparison_snapshots;
CREATE TRIGGER sample_comparison_snapshots_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON sample_comparison_snapshots
  FOR EACH ROW EXECUTE FUNCTION sample_comparison_scope_child_guard();

CREATE OR REPLACE FUNCTION sample_comparison_job_transition_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'queued' OR NEW.attempts<>0 THEN
      RAISE EXCEPTION 'assessment jobs must start queued with zero attempts' USING ERRCODE='23514';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM sample_comparison_scopes WHERE id=NEW.scope_id AND comparison_id=NEW.comparison_id AND status='complete') THEN
      RAISE EXCEPTION 'assessment jobs require a complete scope' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (OLD.comparison_id,OLD.scope_id,OLD.target,OLD.request_sha256,OLD.provider,OLD.model_name,OLD.requested_by)
     IS DISTINCT FROM
     (NEW.comparison_id,NEW.scope_id,NEW.target,NEW.request_sha256,NEW.provider,NEW.model_name,NEW.requested_by) THEN
    RAISE EXCEPTION 'assessment job identity is immutable' USING ERRCODE='55000';
  END IF;
  IF OLD.status IN ('succeeded','failed','cancelled') THEN
    RAISE EXCEPTION 'terminal assessment jobs are immutable' USING ERRCODE='55000';
  END IF;
  IF NOT ((OLD.status='queued' AND NEW.status IN ('queued','running','cancelled')) OR
          (OLD.status='running' AND NEW.status IN ('running','queued','succeeded','failed','cancelled'))) THEN
    RAISE EXCEPTION 'illegal assessment job transition % -> %',OLD.status,NEW.status USING ERRCODE='23514';
  END IF;
  IF OLD.status='queued' AND NEW.status='running' AND NEW.attempts<>OLD.attempts+1 THEN
    RAISE EXCEPTION 'starting an assessment job must increment attempts once' USING ERRCODE='23514';
  END IF;
  IF NEW.status IN ('succeeded','failed','cancelled') AND NEW.finished_at IS NULL THEN
    RAISE EXCEPTION 'terminal assessment jobs require finished_at' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS sample_comparison_assessment_jobs_transition_trg ON sample_comparison_assessment_jobs;
CREATE TRIGGER sample_comparison_assessment_jobs_transition_trg BEFORE INSERT OR UPDATE ON sample_comparison_assessment_jobs
  FOR EACH ROW EXECUTE FUNCTION sample_comparison_job_transition_guard();

CREATE OR REPLACE FUNCTION sample_comparison_assessment_validate()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status TEXT; v_target TEXT; v_scope BIGINT; v_comparison BIGINT;
BEGIN
  SELECT status INTO v_status FROM sample_comparison_scopes WHERE id=NEW.scope_id AND comparison_id=NEW.comparison_id;
  IF v_status IS DISTINCT FROM 'complete' THEN RAISE EXCEPTION 'assessments require a complete scope' USING ERRCODE='23514'; END IF;
  IF NEW.job_id IS NOT NULL THEN
    SELECT target,scope_id,comparison_id INTO v_target,v_scope,v_comparison FROM sample_comparison_assessment_jobs WHERE id=NEW.job_id;
    IF (v_target,v_scope,v_comparison) IS DISTINCT FROM (NEW.target,NEW.scope_id,NEW.comparison_id) THEN
      RAISE EXCEPTION 'AI assessment job ownership mismatch' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS sample_comparison_assessments_validate_trg ON sample_comparison_assessments;
CREATE TRIGGER sample_comparison_assessments_validate_trg BEFORE INSERT ON sample_comparison_assessments
  FOR EACH ROW EXECUTE FUNCTION sample_comparison_assessment_validate();

CREATE OR REPLACE FUNCTION sample_comparison_selection_validate()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM sample_comparisons WHERE id=NEW.comparison_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'comparison does not exist' USING ERRCODE='23503'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS sample_comparison_assessment_selections_validate_trg ON sample_comparison_assessment_selections;
CREATE TRIGGER sample_comparison_assessment_selections_validate_trg BEFORE INSERT ON sample_comparison_assessment_selections
  FOR EACH ROW EXECUTE FUNCTION sample_comparison_selection_validate();

CREATE OR REPLACE FUNCTION sample_relation_evidence_validate()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status TEXT;
BEGIN
  IF NOT ((NEW.endpoint_sample_id=NEW.subject_sample_id AND NEW.endpoint_analysis_version_id=NEW.subject_analysis_version_id) OR
          (NEW.endpoint_sample_id=NEW.object_sample_id AND NEW.endpoint_analysis_version_id=NEW.object_analysis_version_id)) THEN
    RAISE EXCEPTION 'relation evidence must belong to a pinned endpoint analysis' USING ERRCODE='23514';
  END IF;
  SELECT verification_status INTO v_status FROM sample_element_evidence
    WHERE id=NEW.element_evidence_id AND version_id=NEW.endpoint_analysis_version_id;
  IF v_status IS DISTINCT FROM 'verified' THEN RAISE EXCEPTION 'relation evidence must be verified' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS sample_relation_evidence_validate_trg ON sample_relation_evidence;
CREATE TRIGGER sample_relation_evidence_validate_trg BEFORE INSERT ON sample_relation_evidence
  FOR EACH ROW EXECUTE FUNCTION sample_relation_evidence_validate();

CREATE OR REPLACE FUNCTION sample_relation_insert_validate()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM sample_analysis_versions WHERE id=NEW.subject_analysis_version_id AND sample_id=NEW.subject_sample_id AND status='complete') OR
     NOT EXISTS(SELECT 1 FROM sample_analysis_versions WHERE id=NEW.object_analysis_version_id AND sample_id=NEW.object_sample_id AND status='complete') THEN
    RAISE EXCEPTION 'relation endpoints require complete pinned analyses' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS sample_relations_insert_validate_trg ON sample_relations;
CREATE TRIGGER sample_relations_insert_validate_trg BEFORE INSERT ON sample_relations
  FOR EACH ROW EXECUTE FUNCTION sample_relation_insert_validate();

CREATE OR REPLACE FUNCTION sample_relation_row_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'sample relations are immutable' USING ERRCODE='55000'; END IF;
  IF pg_trigger_depth()<2 OR to_jsonb(NEW)-'current_state' IS DISTINCT FROM to_jsonb(OLD)-'current_state' THEN
    RAISE EXCEPTION 'sample relation structure is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS sample_relations_guard_trg ON sample_relations;
CREATE TRIGGER sample_relations_guard_trg BEFORE UPDATE OR DELETE ON sample_relations
  FOR EACH ROW EXECUTE FUNCTION sample_relation_row_guard();

CREATE OR REPLACE FUNCTION sample_relation_event_apply()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r sample_relations%ROWTYPE; v_next TEXT; v_has_cycle BOOLEAN;
BEGIN
  SELECT * INTO r FROM sample_relations WHERE id=NEW.relation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'relation does not exist' USING ERRCODE='23503'; END IF;
  IF NEW.event_type='proposed' THEN
    IF EXISTS(SELECT 1 FROM sample_relation_events WHERE relation_id=NEW.relation_id) OR r.current_state<>'proposed' THEN
      RAISE EXCEPTION 'proposed may only be the first relation event' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  v_next := NEW.event_type;
  IF NOT (
    (r.current_state='proposed' AND v_next IN ('confirmed','rejected','withdrawn','superseded')) OR
    (r.current_state='confirmed' AND v_next IN ('withdrawn','superseded')) OR
    (r.current_state='withdrawn' AND v_next IN ('confirmed','superseded'))
  ) THEN RAISE EXCEPTION 'illegal relation state transition % -> %',r.current_state,v_next USING ERRCODE='23514'; END IF;
  IF v_next='confirmed' THEN
    IF NOT EXISTS(SELECT 1 FROM sample_relation_evidence WHERE relation_id=r.id) THEN
      RAISE EXCEPTION 'confirmed relations require verified endpoint evidence' USING ERRCODE='23514';
    END IF;
    IF r.relation_type IN ('imitation','evolution') THEN
      PERFORM pg_advisory_xact_lock(730082913);
      WITH RECURSIVE reachable(node) AS (
        SELECT x.object_sample_id FROM sample_relations x
         WHERE x.current_state='confirmed' AND x.relation_type IN ('imitation','evolution')
           AND x.subject_sample_id=r.object_sample_id
        UNION
        SELECT x.object_sample_id FROM sample_relations x JOIN reachable p ON x.subject_sample_id=p.node
         WHERE x.current_state='confirmed' AND x.relation_type IN ('imitation','evolution')
      ) SELECT EXISTS(SELECT 1 FROM reachable WHERE node=r.subject_sample_id) INTO v_has_cycle;
      IF v_has_cycle THEN RAISE EXCEPTION 'confirmed lineage relation would create a cycle' USING ERRCODE='23514'; END IF;
    END IF;
  END IF;
  UPDATE sample_relations SET current_state=v_next WHERE id=r.id;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS sample_relation_events_apply_trg ON sample_relation_events;
CREATE TRIGGER sample_relation_events_apply_trg BEFORE INSERT ON sample_relation_events
  FOR EACH ROW EXECUTE FUNCTION sample_relation_event_apply();

CREATE OR REPLACE FUNCTION sample_element_extraction_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_count INT; v_primary INT;
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.status='complete' THEN RAISE EXCEPTION 'complete extractions are immutable' USING ERRCODE='55000'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='INSERT' AND NEW.status<>'building' THEN RAISE EXCEPTION 'extractions must start building' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' AND NOT EXISTS(SELECT 1 FROM sample_comparison_scopes WHERE id=NEW.scope_id AND comparison_id=NEW.comparison_id AND status='complete') THEN
    RAISE EXCEPTION 'extractions require a complete scope' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND OLD.status='complete' THEN RAISE EXCEPTION 'complete extractions are immutable' USING ERRCODE='55000'; END IF;
  IF TG_OP='UPDATE' AND OLD.status='building' AND NEW.status='complete' THEN
    SELECT count(*),count(*) FILTER(WHERE source_role='primary') INTO v_count,v_primary
      FROM sample_element_extraction_sources WHERE extraction_id=NEW.id;
    IF v_count NOT BETWEEN 1 AND 18 OR v_primary<1 THEN
      RAISE EXCEPTION 'complete extraction requires 1-18 sources and at least one primary' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS sample_element_extractions_guard_trg ON sample_element_extractions;
CREATE TRIGGER sample_element_extractions_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON sample_element_extractions
  FOR EACH ROW EXECUTE FUNCTION sample_element_extraction_guard();

CREATE OR REPLACE FUNCTION sample_element_extraction_source_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status TEXT; v_old_status TEXT;
BEGIN
  IF TG_OP='UPDATE' THEN
    SELECT status INTO v_old_status FROM sample_element_extractions WHERE id=OLD.extraction_id;
    IF v_old_status='complete' THEN RAISE EXCEPTION 'sources of complete extractions are immutable' USING ERRCODE='55000'; END IF;
  END IF;
  SELECT status INTO v_status FROM sample_element_extractions WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.extraction_id ELSE NEW.extraction_id END;
  IF v_status='complete' THEN RAISE EXCEPTION 'sources of complete extractions are immutable' USING ERRCODE='55000'; END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
DROP TRIGGER IF EXISTS sample_element_extraction_sources_guard_trg ON sample_element_extraction_sources;
CREATE TRIGGER sample_element_extraction_sources_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON sample_element_extraction_sources
  FOR EACH ROW EXECUTE FUNCTION sample_element_extraction_source_guard();

CREATE OR REPLACE FUNCTION content_component_revision_row_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'component revisions are immutable' USING ERRCODE='55000'; END IF;
  IF pg_trigger_depth()<2 OR to_jsonb(NEW)-'state' IS DISTINCT FROM to_jsonb(OLD)-'state' THEN
    RAISE EXCEPTION 'component revision content is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS content_component_revisions_guard_trg ON content_component_revisions;
CREATE TRIGGER content_component_revisions_guard_trg BEFORE UPDATE OR DELETE ON content_component_revisions
  FOR EACH ROW EXECUTE FUNCTION content_component_revision_row_guard();

CREATE OR REPLACE FUNCTION content_component_revision_child_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_state TEXT; v_revision BIGINT; v_count INT;
BEGIN
  v_revision := CASE WHEN TG_OP='DELETE' THEN OLD.revision_id ELSE NEW.revision_id END;
  SELECT state INTO v_state FROM content_component_revisions WHERE id=v_revision;
  IF v_state<>'draft' THEN RAISE EXCEPTION 'component revision sources and tags are immutable after submit' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' AND TG_TABLE_NAME='content_component_revision_sources' THEN
    SELECT count(*) INTO v_count FROM content_component_revision_sources WHERE revision_id=v_revision;
    IF v_count>=20 THEN RAISE EXCEPTION 'component revision source limit exceeded' USING ERRCODE='23514'; END IF;
  END IF;
  IF TG_OP='INSERT' AND TG_TABLE_NAME='content_component_revision_tags' THEN
    SELECT count(*) INTO v_count FROM content_component_revision_tags WHERE revision_id=v_revision;
    IF v_count>=30 THEN RAISE EXCEPTION 'component revision tag limit exceeded' USING ERRCODE='23514'; END IF;
    IF NOT EXISTS(SELECT 1 FROM tags WHERE id=NEW.tag_id AND active) THEN
      RAISE EXCEPTION 'component revision tags must be active' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
DROP TRIGGER IF EXISTS content_component_revision_sources_guard_trg ON content_component_revision_sources;
CREATE TRIGGER content_component_revision_sources_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON content_component_revision_sources
  FOR EACH ROW EXECUTE FUNCTION content_component_revision_child_guard();
DROP TRIGGER IF EXISTS content_component_revision_tags_guard_trg ON content_component_revision_tags;
CREATE TRIGGER content_component_revision_tags_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON content_component_revision_tags
  FOR EACH ROW EXECUTE FUNCTION content_component_revision_child_guard();

CREATE OR REPLACE FUNCTION content_component_revision_decision_apply()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r content_component_revisions%ROWTYPE;
BEGIN
  SELECT * INTO r FROM content_component_revisions WHERE id=NEW.revision_id AND component_id=NEW.component_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'component revision does not exist' USING ERRCODE='23503'; END IF;
  IF NEW.decision='submitted' THEN
    IF r.state<>'draft' THEN RAISE EXCEPTION 'only draft revisions may be submitted' USING ERRCODE='23514'; END IF;
    IF NOT EXISTS(
      SELECT 1 FROM content_component_revision_sources s
      JOIN sample_element_extractions e ON e.id=s.extraction_id AND e.status='complete'
      JOIN sample_element_extraction_sources es ON es.extraction_id=e.id AND es.source_role='primary'
      JOIN sample_comparison_snapshots x ON x.id=es.snapshot_id AND x.evidence_state='verified'
      WHERE s.revision_id=r.id AND s.source_role='primary'
    ) THEN RAISE EXCEPTION 'submit requires a verified primary extraction chain' USING ERRCODE='23514'; END IF;
    UPDATE content_component_revisions SET state='submitted' WHERE id=r.id;
  ELSIF NEW.decision IN ('approved','changes_requested') THEN
    IF r.state<>'submitted' THEN RAISE EXCEPTION 'review requires a submitted revision' USING ERRCODE='23514'; END IF;
    IF NEW.actor_role NOT IN ('reviewer','admin') THEN RAISE EXCEPTION 'reviewer role required' USING ERRCODE='42501'; END IF;
    UPDATE content_component_revisions SET state=NEW.decision WHERE id=r.id;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS content_component_revision_decisions_apply_trg ON content_component_revision_decisions;
CREATE TRIGGER content_component_revision_decisions_apply_trg BEFORE INSERT ON content_component_revision_decisions
  FOR EACH ROW EXECUTE FUNCTION content_component_revision_decision_apply();

CREATE OR REPLACE FUNCTION content_component_selection_validate()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_state TEXT; v_decision TEXT; v_revision BIGINT;
BEGIN
  PERFORM 1 FROM content_components WHERE id=NEW.component_id FOR UPDATE;
  SELECT state INTO v_state FROM content_component_revisions WHERE id=NEW.revision_id AND component_id=NEW.component_id;
  SELECT decision,revision_id INTO v_decision,v_revision FROM content_component_revision_decisions WHERE id=NEW.decision_id;
  IF v_state IS DISTINCT FROM 'approved' OR v_decision IS DISTINCT FROM 'approved' OR v_revision IS DISTINCT FROM NEW.revision_id THEN
    RAISE EXCEPTION 'component selection requires its approving decision' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS content_component_selections_validate_trg ON content_component_selections;
CREATE TRIGGER content_component_selections_validate_trg BEFORE INSERT ON content_component_selections
  FOR EACH ROW EXECUTE FUNCTION content_component_selection_validate();

CREATE OR REPLACE FUNCTION content_component_row_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'content components are immutable' USING ERRCODE='55000'; END IF;
  IF pg_trigger_depth()<2 OR to_jsonb(NEW)-'lifecycle_state' IS DISTINCT FROM to_jsonb(OLD)-'lifecycle_state' THEN
    RAISE EXCEPTION 'stable component identity is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS content_components_guard_trg ON content_components;
CREATE TRIGGER content_components_guard_trg BEFORE UPDATE OR DELETE ON content_components
  FOR EACH ROW EXECUTE FUNCTION content_component_row_guard();

CREATE OR REPLACE FUNCTION content_component_lifecycle_apply()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_state TEXT;
BEGIN
  SELECT lifecycle_state INTO v_state FROM content_components WHERE id=NEW.component_id FOR UPDATE;
  IF (NEW.event_type='retired' AND v_state<>'active') OR (NEW.event_type='reactivated' AND v_state<>'retired') THEN
    RAISE EXCEPTION 'illegal component lifecycle transition' USING ERRCODE='23514';
  END IF;
  UPDATE content_components SET lifecycle_state=CASE WHEN NEW.event_type='retired' THEN 'retired' ELSE 'active' END
   WHERE id=NEW.component_id;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS content_component_lifecycle_events_apply_trg ON content_component_lifecycle_events;
CREATE TRIGGER content_component_lifecycle_events_apply_trg BEFORE INSERT ON content_component_lifecycle_events
  FOR EACH ROW EXECUTE FUNCTION content_component_lifecycle_apply();

-- Append-only histories and frozen products.
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY[
    'sample_comparison_assessments','sample_comparison_findings',
    'sample_comparison_finding_evidence','sample_comparison_assessment_selections',
    'sample_relation_evidence','sample_relation_events','content_component_revision_decisions',
    'content_component_selections','content_component_lifecycle_events'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I',t||'_append_only_trg',t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION sample_stage3_append_only_guard()',t||'_append_only_trg',t);
  END LOOP;
END $$;

COMMIT;

-- Verification examples (read-only):
-- SELECT count(*) FROM sample_analysis_dimensions; -- exactly 15
-- SELECT tablename FROM pg_tables WHERE tablename LIKE 'sample_comparison%' ORDER BY 1;
-- SELECT conname FROM pg_constraint WHERE conname LIKE 'sample_%_fk' ORDER BY 1;
-- IdeaHub sample library, stage 4 (contract v2).
-- Additive, idempotent, PostgreSQL 16/17. Run after Stage 1-3 migrations.
BEGIN;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='content_component_revision_decisions_identity_uk' AND conrelid='content_component_revision_decisions'::regclass) THEN
    ALTER TABLE content_component_revision_decisions ADD CONSTRAINT content_component_revision_decisions_identity_uk UNIQUE(component_id,revision_id,id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='content_component_selections_identity_uk' AND conrelid='content_component_selections'::regclass) THEN
    ALTER TABLE content_component_selections ADD CONSTRAINT content_component_selections_identity_uk UNIQUE(component_id,id,revision_id,decision_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='sample_element_tags_stage4_identity_uk' AND conrelid='sample_element_tags'::regclass) THEN
    ALTER TABLE sample_element_tags ADD CONSTRAINT sample_element_tags_stage4_identity_uk UNIQUE(id,version_id,element_id,dimension_key,tag_id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS sample_retrieval_algorithms (
  id BIGSERIAL PRIMARY KEY, algorithm_version TEXT NOT NULL, tokenizer_version TEXT NOT NULL,
  mapping_version TEXT NOT NULL, vector_size SMALLINT NOT NULL DEFAULT 256, config JSONB NOT NULL,
  config_sha256 TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sample_retrieval_algorithms_versions_uk UNIQUE(algorithm_version,tokenizer_version,mapping_version,config_sha256),
  CONSTRAINT sample_retrieval_algorithms_size_chk CHECK(vector_size=256),
  CONSTRAINT sample_retrieval_algorithms_hash_chk CHECK(config_sha256~'^[0-9a-f]{64}$')
);

CREATE TABLE IF NOT EXISTS sample_retrieval_builds (
  id BIGSERIAL PRIMARY KEY, algorithm_id BIGINT NOT NULL REFERENCES sample_retrieval_algorithms(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'queued', idempotency_key TEXT NOT NULL, request_sha256 TEXT NOT NULL,
  requested_by BIGINT REFERENCES users(id) ON DELETE SET NULL, attempts SMALLINT NOT NULL DEFAULT 0,
  max_attempts SMALLINT NOT NULL DEFAULT 3, lease_owner TEXT, lease_expires_at TIMESTAMPTZ, heartbeat_at TIMESTAMPTZ,
  eligible_count INT, succeeded_count INT NOT NULL DEFAULT 0, excluded_count INT NOT NULL DEFAULT 0, failed_count INT NOT NULL DEFAULT 0,
  error_code TEXT,error_message TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),started_at TIMESTAMPTZ,finished_at TIMESTAMPTZ,
  CONSTRAINT sample_retrieval_builds_status_chk CHECK(status IN('queued','running','succeeded','failed','cancelled')),
  CONSTRAINT sample_retrieval_builds_attempts_chk CHECK(attempts BETWEEN 0 AND max_attempts AND max_attempts=3),
  CONSTRAINT sample_retrieval_builds_idempotency_chk CHECK(char_length(idempotency_key) BETWEEN 1 AND 160),
  CONSTRAINT sample_retrieval_builds_hash_chk CHECK(request_sha256~'^[0-9a-f]{64}$'),
  CONSTRAINT sample_retrieval_builds_counts_chk CHECK(succeeded_count>=0 AND excluded_count>=0 AND failed_count>=0),
  CONSTRAINT sample_retrieval_builds_terminal_chk CHECK((status IN('succeeded','failed','cancelled'))=(finished_at IS NOT NULL)),
  CONSTRAINT sample_retrieval_builds_idempotency_uk UNIQUE(idempotency_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS sample_retrieval_builds_one_active_uidx ON sample_retrieval_builds((1)) WHERE status IN('queued','running');
CREATE INDEX IF NOT EXISTS sample_retrieval_builds_status_idx ON sample_retrieval_builds(status,created_at,id);

CREATE TABLE IF NOT EXISTS sample_retrieval_build_items (
  id BIGSERIAL PRIMARY KEY, build_id BIGINT NOT NULL REFERENCES sample_retrieval_builds(id) ON DELETE RESTRICT,
  subject_kind TEXT NOT NULL, sample_id BIGINT REFERENCES samples(id) ON DELETE RESTRICT,
  component_id BIGINT REFERENCES content_components(id) ON DELETE RESTRICT, status TEXT NOT NULL,
  profile_id BIGINT, exclusion_code TEXT,error_code TEXT,error_message TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),finished_at TIMESTAMPTZ,
  CONSTRAINT sample_retrieval_build_items_kind_chk CHECK(subject_kind IN('sample','component')),
  CONSTRAINT sample_retrieval_build_items_subject_chk CHECK((subject_kind='sample' AND sample_id IS NOT NULL AND component_id IS NULL) OR(subject_kind='component' AND component_id IS NOT NULL AND sample_id IS NULL)),
  CONSTRAINT sample_retrieval_build_items_status_chk CHECK(status IN('queued','succeeded','excluded','failed','cancelled')),
  CONSTRAINT sample_retrieval_build_items_subject_uk UNIQUE(build_id,subject_kind,sample_id,component_id)
);

CREATE TABLE IF NOT EXISTS sample_retrieval_profiles (
  id BIGSERIAL PRIMARY KEY, build_id BIGINT NOT NULL REFERENCES sample_retrieval_builds(id) ON DELETE RESTRICT,
  algorithm_id BIGINT NOT NULL REFERENCES sample_retrieval_algorithms(id) ON DELETE RESTRICT,
  sample_id BIGINT NOT NULL, analysis_version_id BIGINT NOT NULL, status TEXT NOT NULL DEFAULT 'building',
  input_sha256 TEXT NOT NULL, frozen_title TEXT NOT NULL, frozen_platform TEXT NOT NULL,
  frozen_account_name TEXT,frozen_account_handle TEXT,frozen_archive_status TEXT NOT NULL,
  frozen_content_type TEXT,frozen_tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),completed_at TIMESTAMPTZ,
  CONSTRAINT sample_retrieval_profiles_version_fk FOREIGN KEY(sample_id,analysis_version_id) REFERENCES sample_analysis_versions(sample_id,id) ON DELETE RESTRICT,
  CONSTRAINT sample_retrieval_profiles_identity_uk UNIQUE(id,sample_id,analysis_version_id),
  CONSTRAINT sample_retrieval_profiles_id_sample_uk UNIQUE(id,sample_id),
  CONSTRAINT sample_retrieval_profiles_build_subject_uk UNIQUE(build_id,sample_id),
  CONSTRAINT sample_retrieval_profiles_status_chk CHECK(status IN('building','complete')),
  CONSTRAINT sample_retrieval_profiles_hash_chk CHECK(input_sha256~'^[0-9a-f]{64}$'),
  CONSTRAINT sample_retrieval_profiles_completion_chk CHECK((status='complete')=(completed_at IS NOT NULL)),
  CONSTRAINT sample_retrieval_profiles_tags_chk CHECK(jsonb_typeof(frozen_tags)='array')
);
CREATE INDEX IF NOT EXISTS sample_retrieval_profiles_algorithm_idx ON sample_retrieval_profiles(algorithm_id,id) WHERE status='complete';

CREATE TABLE IF NOT EXISTS sample_retrieval_dimension_vectors (
  id BIGSERIAL PRIMARY KEY, profile_id BIGINT NOT NULL,sample_id BIGINT NOT NULL,analysis_version_id BIGINT NOT NULL,
  element_id BIGINT NOT NULL,dimension_key TEXT NOT NULL,decision_id BIGINT,
  vector SMALLINT[] NOT NULL,norm_sq BIGINT NOT NULL,nonzero_count SMALLINT NOT NULL,simhash BIT(64) NOT NULL,
  band_0 SMALLINT NOT NULL,band_1 SMALLINT NOT NULL,band_2 SMALLINT NOT NULL,band_3 SMALLINT NOT NULL,
  band_4 SMALLINT NOT NULL,band_5 SMALLINT NOT NULL,band_6 SMALLINT NOT NULL,band_7 SMALLINT NOT NULL,
  source TEXT NOT NULL,decision_state TEXT,confidence NUMERIC(4,3),evidence_strength TEXT NOT NULL,effective_summary TEXT,
  applicability TEXT,limitations TEXT,frozen_tags JSONB NOT NULL DEFAULT '[]'::jsonb,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sample_retrieval_vectors_profile_fk FOREIGN KEY(profile_id,sample_id,analysis_version_id) REFERENCES sample_retrieval_profiles(id,sample_id,analysis_version_id) ON DELETE RESTRICT,
  CONSTRAINT sample_retrieval_vectors_element_fk FOREIGN KEY(analysis_version_id,element_id,dimension_key) REFERENCES sample_analysis_elements(version_id,id,dimension_key) ON DELETE RESTRICT,
  CONSTRAINT sample_retrieval_vectors_decision_fk FOREIGN KEY(element_id,decision_id) REFERENCES sample_element_decisions(element_id,id) ON DELETE RESTRICT,
  CONSTRAINT sample_retrieval_vectors_dimension_uk UNIQUE(profile_id,dimension_key),
  CONSTRAINT sample_retrieval_vectors_shape_chk CHECK(array_ndims(vector)=1 AND array_lower(vector,1)=1 AND array_length(vector,1)=256),
  CONSTRAINT sample_retrieval_vectors_norm_chk CHECK(norm_sq>=0 AND nonzero_count BETWEEN 0 AND 256),
  CONSTRAINT sample_retrieval_vectors_bands_chk CHECK(band_0 BETWEEN 0 AND 255 AND band_1 BETWEEN 0 AND 255 AND band_2 BETWEEN 0 AND 255 AND band_3 BETWEEN 0 AND 255 AND band_4 BETWEEN 0 AND 255 AND band_5 BETWEEN 0 AND 255 AND band_6 BETWEEN 0 AND 255 AND band_7 BETWEEN 0 AND 255),
  CONSTRAINT sample_retrieval_vectors_source_chk CHECK(source IN('ai','manual','legacy')),
  CONSTRAINT sample_retrieval_vectors_decision_state_chk CHECK((decision_id IS NULL AND decision_state IS NULL)OR(decision_id IS NOT NULL AND decision_state IN('confirmed','edited','rejected'))),
  CONSTRAINT sample_retrieval_vectors_evidence_chk CHECK(evidence_strength IN('none','weak','medium','strong')),
  CONSTRAINT sample_retrieval_vectors_tags_chk CHECK(jsonb_typeof(frozen_tags)='array')
);
CREATE INDEX IF NOT EXISTS sample_retrieval_vectors_band0_idx ON sample_retrieval_dimension_vectors(dimension_key,band_0,profile_id) WHERE norm_sq>0;
CREATE INDEX IF NOT EXISTS sample_retrieval_vectors_band1_idx ON sample_retrieval_dimension_vectors(dimension_key,band_1,profile_id) WHERE norm_sq>0;
CREATE INDEX IF NOT EXISTS sample_retrieval_vectors_band2_idx ON sample_retrieval_dimension_vectors(dimension_key,band_2,profile_id) WHERE norm_sq>0;
CREATE INDEX IF NOT EXISTS sample_retrieval_vectors_band3_idx ON sample_retrieval_dimension_vectors(dimension_key,band_3,profile_id) WHERE norm_sq>0;
CREATE INDEX IF NOT EXISTS sample_retrieval_vectors_band4_idx ON sample_retrieval_dimension_vectors(dimension_key,band_4,profile_id) WHERE norm_sq>0;
CREATE INDEX IF NOT EXISTS sample_retrieval_vectors_band5_idx ON sample_retrieval_dimension_vectors(dimension_key,band_5,profile_id) WHERE norm_sq>0;
CREATE INDEX IF NOT EXISTS sample_retrieval_vectors_band6_idx ON sample_retrieval_dimension_vectors(dimension_key,band_6,profile_id) WHERE norm_sq>0;
CREATE INDEX IF NOT EXISTS sample_retrieval_vectors_band7_idx ON sample_retrieval_dimension_vectors(dimension_key,band_7,profile_id) WHERE norm_sq>0;

CREATE TABLE IF NOT EXISTS sample_retrieval_states (
  sample_id BIGINT PRIMARY KEY REFERENCES samples(id) ON DELETE RESTRICT,dirty BOOLEAN NOT NULL DEFAULT true,
  dirty_generation BIGINT NOT NULL DEFAULT 1,current_fingerprint TEXT,last_profile_id BIGINT REFERENCES sample_retrieval_profiles(id) ON DELETE RESTRICT,
  last_build_id BIGINT REFERENCES sample_retrieval_builds(id) ON DELETE RESTRICT,last_error_code TEXT,last_error_message TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),CONSTRAINT sample_retrieval_states_generation_chk CHECK(dirty_generation>=1),
  CONSTRAINT sample_retrieval_states_hash_chk CHECK(current_fingerprint IS NULL OR current_fingerprint~'^[0-9a-f]{64}$')
);

CREATE TABLE IF NOT EXISTS component_retrieval_profiles (
  id BIGSERIAL PRIMARY KEY,build_id BIGINT NOT NULL REFERENCES sample_retrieval_builds(id) ON DELETE RESTRICT,
  algorithm_id BIGINT NOT NULL REFERENCES sample_retrieval_algorithms(id) ON DELETE RESTRICT,component_id BIGINT NOT NULL,
  selection_id BIGINT NOT NULL,revision_id BIGINT NOT NULL,approving_decision_id BIGINT NOT NULL,dimension_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'building',input_sha256 TEXT NOT NULL,frozen_name TEXT NOT NULL,frozen_summary TEXT NOT NULL,
  frozen_applicability TEXT,frozen_limitations TEXT,frozen_source_count INT NOT NULL,frozen_tags JSONB NOT NULL DEFAULT'[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),completed_at TIMESTAMPTZ,
  CONSTRAINT component_retrieval_profiles_selection_fk FOREIGN KEY(component_id,selection_id,revision_id,approving_decision_id) REFERENCES content_component_selections(component_id,id,revision_id,decision_id) ON DELETE RESTRICT,
  CONSTRAINT component_retrieval_profiles_revision_dimension_fk FOREIGN KEY(revision_id,dimension_key) REFERENCES content_component_revisions(id,dimension_key) ON DELETE RESTRICT,
  CONSTRAINT component_retrieval_profiles_identity_uk UNIQUE(id,component_id,selection_id,revision_id,approving_decision_id,dimension_key),
  CONSTRAINT component_retrieval_profiles_build_subject_uk UNIQUE(build_id,component_id),
  CONSTRAINT component_retrieval_profiles_status_chk CHECK(status IN('building','complete')),
  CONSTRAINT component_retrieval_profiles_hash_chk CHECK(input_sha256~'^[0-9a-f]{64}$'),
  CONSTRAINT component_retrieval_profiles_completion_chk CHECK((status='complete')=(completed_at IS NOT NULL)),
  CONSTRAINT component_retrieval_profiles_source_count_chk CHECK(frozen_source_count>=0)
);

CREATE TABLE IF NOT EXISTS component_retrieval_vectors (
  id BIGSERIAL PRIMARY KEY,profile_id BIGINT NOT NULL,component_id BIGINT NOT NULL,selection_id BIGINT NOT NULL,
  revision_id BIGINT NOT NULL,approving_decision_id BIGINT NOT NULL,dimension_key TEXT NOT NULL,
  vector SMALLINT[] NOT NULL,norm_sq BIGINT NOT NULL,nonzero_count SMALLINT NOT NULL,simhash BIT(64) NOT NULL,
  band_0 SMALLINT NOT NULL,band_1 SMALLINT NOT NULL,band_2 SMALLINT NOT NULL,band_3 SMALLINT NOT NULL,
  band_4 SMALLINT NOT NULL,band_5 SMALLINT NOT NULL,band_6 SMALLINT NOT NULL,band_7 SMALLINT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT component_retrieval_vectors_profile_fk FOREIGN KEY(profile_id,component_id,selection_id,revision_id,approving_decision_id,dimension_key) REFERENCES component_retrieval_profiles(id,component_id,selection_id,revision_id,approving_decision_id,dimension_key) ON DELETE RESTRICT,
  CONSTRAINT component_retrieval_vectors_one_uk UNIQUE(profile_id),
  CONSTRAINT component_retrieval_vectors_shape_chk CHECK(array_ndims(vector)=1 AND array_lower(vector,1)=1 AND array_length(vector,1)=256),
  CONSTRAINT component_retrieval_vectors_norm_chk CHECK(norm_sq>=0 AND nonzero_count BETWEEN 0 AND 256),
  CONSTRAINT component_retrieval_vectors_bands_chk CHECK(band_0 BETWEEN 0 AND 255 AND band_1 BETWEEN 0 AND 255 AND band_2 BETWEEN 0 AND 255 AND band_3 BETWEEN 0 AND 255 AND band_4 BETWEEN 0 AND 255 AND band_5 BETWEEN 0 AND 255 AND band_6 BETWEEN 0 AND 255 AND band_7 BETWEEN 0 AND 255)
);
CREATE INDEX IF NOT EXISTS component_retrieval_vectors_band0_idx ON component_retrieval_vectors(dimension_key,band_0,profile_id) WHERE norm_sq>0;
CREATE INDEX IF NOT EXISTS component_retrieval_vectors_band1_idx ON component_retrieval_vectors(dimension_key,band_1,profile_id) WHERE norm_sq>0;
CREATE INDEX IF NOT EXISTS component_retrieval_vectors_band2_idx ON component_retrieval_vectors(dimension_key,band_2,profile_id) WHERE norm_sq>0;
CREATE INDEX IF NOT EXISTS component_retrieval_vectors_band3_idx ON component_retrieval_vectors(dimension_key,band_3,profile_id) WHERE norm_sq>0;
CREATE INDEX IF NOT EXISTS component_retrieval_vectors_band4_idx ON component_retrieval_vectors(dimension_key,band_4,profile_id) WHERE norm_sq>0;
CREATE INDEX IF NOT EXISTS component_retrieval_vectors_band5_idx ON component_retrieval_vectors(dimension_key,band_5,profile_id) WHERE norm_sq>0;
CREATE INDEX IF NOT EXISTS component_retrieval_vectors_band6_idx ON component_retrieval_vectors(dimension_key,band_6,profile_id) WHERE norm_sq>0;
CREATE INDEX IF NOT EXISTS component_retrieval_vectors_band7_idx ON component_retrieval_vectors(dimension_key,band_7,profile_id) WHERE norm_sq>0;

CREATE TABLE IF NOT EXISTS component_retrieval_states (
  component_id BIGINT PRIMARY KEY REFERENCES content_components(id) ON DELETE RESTRICT,dirty BOOLEAN NOT NULL DEFAULT true,
  dirty_generation BIGINT NOT NULL DEFAULT 1,current_fingerprint TEXT,last_profile_id BIGINT REFERENCES component_retrieval_profiles(id) ON DELETE RESTRICT,
  last_build_id BIGINT REFERENCES sample_retrieval_builds(id) ON DELETE RESTRICT,last_error_code TEXT,last_error_message TEXT,updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT component_retrieval_states_generation_chk CHECK(dirty_generation>=1)
);

CREATE TABLE IF NOT EXISTS sample_retrieval_algorithm_selections (
  id BIGSERIAL PRIMARY KEY,algorithm_id BIGINT NOT NULL REFERENCES sample_retrieval_algorithms(id) ON DELETE RESTRICT,
  build_id BIGINT NOT NULL REFERENCES sample_retrieval_builds(id) ON DELETE RESTRICT,reason TEXT NOT NULL,
  selected_by BIGINT REFERENCES users(id) ON DELETE SET NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sample_retrieval_algorithm_selections_reason_chk CHECK(reason IN('build_success','explicit','rollback')),
  CONSTRAINT sample_retrieval_algorithm_selections_identity_uk UNIQUE(id,algorithm_id)
);

CREATE TABLE IF NOT EXISTS sample_cluster_jobs (
 id BIGSERIAL PRIMARY KEY,algorithm_selection_id BIGINT NOT NULL REFERENCES sample_retrieval_algorithm_selections(id) ON DELETE RESTRICT,
 status TEXT NOT NULL DEFAULT'queued',idempotency_key TEXT NOT NULL UNIQUE,request_sha256 TEXT NOT NULL,requested_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
 attempts SMALLINT NOT NULL DEFAULT 0,max_attempts SMALLINT NOT NULL DEFAULT 3,lease_owner TEXT,lease_expires_at TIMESTAMPTZ,heartbeat_at TIMESTAMPTZ,
 error_code TEXT,error_message TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),started_at TIMESTAMPTZ,finished_at TIMESTAMPTZ,
 CONSTRAINT sample_cluster_jobs_status_chk CHECK(status IN('queued','running','succeeded','failed','cancelled')),
 CONSTRAINT sample_cluster_jobs_hash_chk CHECK(request_sha256~'^[0-9a-f]{64}$'),CONSTRAINT sample_cluster_jobs_attempts_chk CHECK(attempts BETWEEN 0 AND max_attempts AND max_attempts=3),
 CONSTRAINT sample_cluster_jobs_terminal_chk CHECK((status IN('succeeded','failed','cancelled'))=(finished_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS sample_cluster_jobs_one_active_uidx ON sample_cluster_jobs((1)) WHERE status IN('queued','running');

CREATE TABLE IF NOT EXISTS sample_cluster_runs (
 id BIGSERIAL PRIMARY KEY,job_id BIGINT NOT NULL UNIQUE REFERENCES sample_cluster_jobs(id) ON DELETE RESTRICT,
 algorithm_selection_id BIGINT NOT NULL REFERENCES sample_retrieval_algorithm_selections(id) ON DELETE RESTRICT,
 status TEXT NOT NULL DEFAULT'building',algorithm_version TEXT NOT NULL,input_sha256 TEXT NOT NULL,profile_count INT NOT NULL DEFAULT 0,
 limitation TEXT NOT NULL DEFAULT'聚类仅描述结构相似性，不代表内容价值或表现因果。',created_at TIMESTAMPTZ NOT NULL DEFAULT now(),completed_at TIMESTAMPTZ,
 CONSTRAINT sample_cluster_runs_status_chk CHECK(status IN('building','complete','failed')),CONSTRAINT sample_cluster_runs_hash_chk CHECK(input_sha256~'^[0-9a-f]{64}$'),
 CONSTRAINT sample_cluster_runs_completion_chk CHECK((status IN('complete','failed'))=(completed_at IS NOT NULL)),CONSTRAINT sample_cluster_runs_identity_uk UNIQUE(id,algorithm_selection_id)
);

CREATE TABLE IF NOT EXISTS sample_cluster_run_profiles (
 run_id BIGINT NOT NULL,algorithm_selection_id BIGINT NOT NULL,sample_id BIGINT NOT NULL,profile_id BIGINT NOT NULL,ordinal INT NOT NULL,
 PRIMARY KEY(run_id,sample_id),CONSTRAINT sample_cluster_run_profiles_run_fk FOREIGN KEY(run_id,algorithm_selection_id) REFERENCES sample_cluster_runs(id,algorithm_selection_id) ON DELETE RESTRICT,
 CONSTRAINT sample_cluster_run_profiles_profile_fk FOREIGN KEY(profile_id,sample_id) REFERENCES sample_retrieval_profiles(id,sample_id) ON DELETE RESTRICT,
 CONSTRAINT sample_cluster_run_profiles_profile_uk UNIQUE(run_id,profile_id),CONSTRAINT sample_cluster_run_profiles_member_fk_uk UNIQUE(run_id,sample_id,profile_id),CONSTRAINT sample_cluster_run_profiles_ordinal_uk UNIQUE(run_id,ordinal),CONSTRAINT sample_cluster_run_profiles_ordinal_chk CHECK(ordinal>0)
);

CREATE TABLE IF NOT EXISTS sample_clusters (
 id BIGSERIAL PRIMARY KEY,run_id BIGINT NOT NULL REFERENCES sample_cluster_runs(id) ON DELETE RESTRICT,ordinal INT NOT NULL,cluster_key TEXT NOT NULL,
 representative_sample_id BIGINT NOT NULL,label TEXT NOT NULL,summary TEXT NOT NULL,cohesion NUMERIC(8,7),common_tags JSONB NOT NULL DEFAULT'[]'::jsonb,
 distinguishing_tags JSONB NOT NULL DEFAULT'[]'::jsonb,dimension_contributions JSONB NOT NULL DEFAULT'[]'::jsonb,limitation TEXT NOT NULL,
 CONSTRAINT sample_clusters_run_ordinal_uk UNIQUE(run_id,ordinal),CONSTRAINT sample_clusters_run_id_id_uk UNIQUE(run_id,id),
 CONSTRAINT sample_clusters_key_uk UNIQUE(run_id,cluster_key),CONSTRAINT sample_clusters_key_chk CHECK(cluster_key~'^[0-9a-f]{64}$'),
 CONSTRAINT sample_clusters_cohesion_chk CHECK(cohesion IS NULL OR cohesion BETWEEN -1 AND 1),CONSTRAINT sample_clusters_ordinal_chk CHECK(ordinal>0)
);

CREATE TABLE IF NOT EXISTS sample_cluster_members (
 run_id BIGINT NOT NULL,sample_id BIGINT NOT NULL,profile_id BIGINT NOT NULL,cluster_id BIGINT,is_outlier BOOLEAN NOT NULL,
 representative BOOLEAN NOT NULL DEFAULT false,pair_mean NUMERIC(8,7),PRIMARY KEY(run_id,sample_id),
 CONSTRAINT sample_cluster_members_input_fk FOREIGN KEY(run_id,sample_id,profile_id) REFERENCES sample_cluster_run_profiles(run_id,sample_id,profile_id) ON DELETE RESTRICT,
 CONSTRAINT sample_cluster_members_cluster_fk FOREIGN KEY(run_id,cluster_id) REFERENCES sample_clusters(run_id,id) ON DELETE RESTRICT,
 CONSTRAINT sample_cluster_members_assignment_chk CHECK((is_outlier AND cluster_id IS NULL AND NOT representative)OR(NOT is_outlier AND cluster_id IS NOT NULL)),
 CONSTRAINT sample_cluster_members_pair_mean_chk CHECK(pair_mean IS NULL OR pair_mean BETWEEN -1 AND 1)
);

CREATE TABLE IF NOT EXISTS sample_cluster_selections (
 id BIGSERIAL PRIMARY KEY,run_id BIGINT NOT NULL REFERENCES sample_cluster_runs(id) ON DELETE RESTRICT,
 algorithm_selection_id BIGINT NOT NULL,selected_by BIGINT REFERENCES users(id) ON DELETE SET NULL,reason TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),CONSTRAINT sample_cluster_selections_run_fk FOREIGN KEY(run_id,algorithm_selection_id) REFERENCES sample_cluster_runs(id,algorithm_selection_id) ON DELETE RESTRICT,
 CONSTRAINT sample_cluster_selections_reason_chk CHECK(reason IN('job_success','explicit','rollback'))
);

-- Existing Stage1-3 subjects start explicitly dirty; no source row is silently
-- treated as indexed merely because Stage4 was installed.
INSERT INTO sample_retrieval_states(sample_id,dirty,dirty_generation)
SELECT id,true,1 FROM samples WHERE deleted_at IS NULL AND current_analysis_version_id IS NOT NULL
ON CONFLICT(sample_id)DO NOTHING;
INSERT INTO component_retrieval_states(component_id,dirty,dirty_generation)
SELECT id,true,1 FROM content_components
ON CONFLICT(component_id)DO NOTHING;

CREATE TABLE IF NOT EXISTS sample_element_tag_observations (
 id BIGSERIAL PRIMARY KEY,sample_id BIGINT NOT NULL,analysis_version_id BIGINT NOT NULL,element_id BIGINT NOT NULL,dimension_key TEXT NOT NULL,
 tag_id BIGINT NOT NULL REFERENCES tags(id) ON DELETE RESTRICT,state TEXT NOT NULL,note TEXT,idempotency_key TEXT NOT NULL,request_sha256 TEXT NOT NULL,
 observed_by BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,observer_role TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CONSTRAINT sample_element_tag_observations_version_fk FOREIGN KEY(sample_id,analysis_version_id) REFERENCES sample_analysis_versions(sample_id,id) ON DELETE RESTRICT,
 CONSTRAINT sample_element_tag_observations_element_fk FOREIGN KEY(analysis_version_id,element_id,dimension_key) REFERENCES sample_analysis_elements(version_id,id,dimension_key) ON DELETE RESTRICT,
 CONSTRAINT sample_element_tag_observations_state_chk CHECK(state IN('present','absent')),CONSTRAINT sample_element_tag_observations_role_chk CHECK(observer_role IN('reviewer','admin')),
 CONSTRAINT sample_element_tag_observations_hash_chk CHECK(request_sha256~'^[0-9a-f]{64}$'),CONSTRAINT sample_element_tag_observations_note_chk CHECK(note IS NULL OR char_length(note)<=2000),
 CONSTRAINT sample_element_tag_observations_idempotency_uk UNIQUE(sample_id,analysis_version_id,element_id,tag_id,idempotency_key),
 CONSTRAINT sample_element_tag_observations_identity_uk UNIQUE(id,sample_id,analysis_version_id,element_id,dimension_key,tag_id),
 CONSTRAINT sample_element_tag_observations_fk_identity_uk UNIQUE(id,sample_id,analysis_version_id,element_id,dimension_key)
);
CREATE INDEX IF NOT EXISTS sample_element_tag_observations_latest_idx ON sample_element_tag_observations(element_id,tag_id,created_at DESC,id DESC);

CREATE TABLE IF NOT EXISTS sample_insight_runs (
 id BIGSERIAL PRIMARY KEY,name TEXT NOT NULL,status TEXT NOT NULL DEFAULT'queued',idempotency_key TEXT NOT NULL UNIQUE,request_sha256 TEXT NOT NULL,
 manifest_sha256 TEXT,normalized_request JSONB NOT NULL,platform TEXT NOT NULL,goal TEXT NOT NULL,outcome_metric TEXT NOT NULL,outcome_transform TEXT NOT NULL,
 analysis_trust TEXT NOT NULL,cutoff_at TIMESTAMPTZ NOT NULL,requested_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
 attempts SMALLINT NOT NULL DEFAULT 0,max_attempts SMALLINT NOT NULL DEFAULT 3,lease_owner TEXT,lease_expires_at TIMESTAMPTZ,heartbeat_at TIMESTAMPTZ,
 eligible_count INT,outcome_observed_count INT,feature_observed_count INT,warnings JSONB NOT NULL DEFAULT'[]'::jsonb,exclusion_counts JSONB NOT NULL DEFAULT'{}'::jsonb,
 error_code TEXT,error_message TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),started_at TIMESTAMPTZ,completed_at TIMESTAMPTZ,
 CONSTRAINT sample_insight_runs_name_chk CHECK(char_length(name) BETWEEN 1 AND 200),CONSTRAINT sample_insight_runs_status_chk CHECK(status IN('queued','running','complete','failed','cancelled')),
 CONSTRAINT sample_insight_runs_platform_chk CHECK(platform IN('xiaohongshu','douyin','manual')),CONSTRAINT sample_insight_runs_goal_chk CHECK(goal IN('traffic','persona','expertise','conversion')),
 CONSTRAINT sample_insight_runs_metric_chk CHECK(outcome_metric IN('likes','saves','comments','shares','views','likes_per_view','saves_per_view','comments_per_view','shares_per_view')),
 CONSTRAINT sample_insight_runs_trust_chk CHECK(analysis_trust IN('human_confirmed','reviewed_or_manual_tag','all_effective')),
 CONSTRAINT sample_insight_runs_hash_chk CHECK(request_sha256~'^[0-9a-f]{64}$' AND(manifest_sha256 IS NULL OR manifest_sha256~'^[0-9a-f]{64}$')),
 CONSTRAINT sample_insight_runs_attempts_chk CHECK(attempts BETWEEN 0 AND max_attempts AND max_attempts=3),
 CONSTRAINT sample_insight_runs_terminal_chk CHECK((status IN('complete','failed','cancelled'))=(completed_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS sample_insight_runs_one_active_uidx ON sample_insight_runs((1)) WHERE status IN('queued','running');
CREATE INDEX IF NOT EXISTS sample_insight_runs_history_idx ON sample_insight_runs(created_at DESC,id DESC);

CREATE TABLE IF NOT EXISTS sample_insight_run_members (
 id BIGSERIAL PRIMARY KEY,run_id BIGINT NOT NULL REFERENCES sample_insight_runs(id) ON DELETE RESTRICT,sample_id BIGINT NOT NULL,
 analysis_version_id BIGINT NOT NULL,metric_snapshot_id BIGINT,account_key TEXT NOT NULL,account_key_quality TEXT NOT NULL,
 frozen_title TEXT NOT NULL,frozen_platform TEXT NOT NULL,frozen_published_at TIMESTAMPTZ,frozen_metric_observed_at TIMESTAMPTZ,
 observation_seconds BIGINT,outcome_state TEXT NOT NULL,outcome_value NUMERIC,exclusion_reason TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CONSTRAINT sample_insight_run_members_version_fk FOREIGN KEY(sample_id,analysis_version_id) REFERENCES sample_analysis_versions(sample_id,id) ON DELETE RESTRICT,
 CONSTRAINT sample_insight_run_members_metric_fk FOREIGN KEY(sample_id,metric_snapshot_id) REFERENCES sample_metric_snapshots(sample_id,id) ON DELETE RESTRICT,
 CONSTRAINT sample_insight_run_members_run_sample_uk UNIQUE(run_id,sample_id),CONSTRAINT sample_insight_run_members_identity_uk UNIQUE(run_id,id,sample_id,analysis_version_id),
 CONSTRAINT sample_insight_run_members_state_chk CHECK(outcome_state IN('observed','missing_metric','parse_warning','missing_published_at','outside_window')),
 CONSTRAINT sample_insight_run_members_quality_chk CHECK(account_key_quality IN('verified_handle','name_fallback','missing_singleton')),
 CONSTRAINT sample_insight_run_members_outcome_chk CHECK((outcome_state='observed' AND metric_snapshot_id IS NOT NULL AND outcome_value IS NOT NULL AND exclusion_reason IS NULL)OR(outcome_state<>'observed' AND outcome_value IS NULL AND exclusion_reason IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS sample_insight_run_features (
 id BIGSERIAL PRIMARY KEY,run_id BIGINT NOT NULL,member_id BIGINT NOT NULL,sample_id BIGINT NOT NULL,analysis_version_id BIGINT NOT NULL,
 feature_key TEXT NOT NULL,feature_type TEXT NOT NULL,dimension_key TEXT,tag_ids BIGINT[] NOT NULL,tag_id BIGINT REFERENCES tags(id) ON DELETE RESTRICT,state TEXT NOT NULL,
 element_id BIGINT,observation_id BIGINT,element_tag_id BIGINT,source TEXT NOT NULL,frozen_label TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CONSTRAINT sample_insight_run_features_member_fk FOREIGN KEY(run_id,member_id,sample_id,analysis_version_id) REFERENCES sample_insight_run_members(run_id,id,sample_id,analysis_version_id) ON DELETE RESTRICT,
 CONSTRAINT sample_insight_run_features_element_fk FOREIGN KEY(analysis_version_id,element_id,dimension_key) REFERENCES sample_analysis_elements(version_id,id,dimension_key) ON DELETE RESTRICT,
 CONSTRAINT sample_insight_run_features_observation_fk FOREIGN KEY(observation_id,sample_id,analysis_version_id,element_id,dimension_key,tag_id) REFERENCES sample_element_tag_observations(id,sample_id,analysis_version_id,element_id,dimension_key,tag_id) ON DELETE RESTRICT,
 CONSTRAINT sample_insight_run_features_element_tag_fk FOREIGN KEY(element_tag_id,analysis_version_id,element_id,dimension_key,tag_id) REFERENCES sample_element_tags(id,version_id,element_id,dimension_key,tag_id) ON DELETE RESTRICT,
 CONSTRAINT sample_insight_run_features_key_uk UNIQUE(run_id,member_id,feature_key),
 CONSTRAINT sample_insight_run_features_type_chk CHECK(feature_type IN('single','combination')),CONSTRAINT sample_insight_run_features_state_chk CHECK(state IN('present','absent','unknown')),
 CONSTRAINT sample_insight_run_features_source_chk CHECK(source IN('explicit_observation','manual_tag','effective_tag','combination','unknown')),
 CONSTRAINT sample_insight_run_features_tags_chk CHECK(array_ndims(tag_ids)=1 AND array_lower(tag_ids,1)=1 AND array_length(tag_ids,1) BETWEEN 1 AND 3 AND(feature_type='single')=(array_length(tag_ids,1)=1)),
 CONSTRAINT sample_insight_run_features_provenance_chk CHECK(
   (feature_type='single' AND tag_id=tag_ids[1] AND dimension_key IS NOT NULL AND(
     (source='explicit_observation' AND state IN('present','absent') AND observation_id IS NOT NULL AND element_id IS NOT NULL AND element_tag_id IS NULL)OR
     (source IN('manual_tag','effective_tag')AND state='present'AND observation_id IS NULL AND element_id IS NOT NULL AND element_tag_id IS NOT NULL)OR
     (source='unknown'AND state='unknown'AND observation_id IS NULL AND element_id IS NULL AND element_tag_id IS NULL)
   ))OR(feature_type='combination'AND source='combination'AND tag_id IS NULL AND dimension_key IS NULL AND observation_id IS NULL AND element_id IS NULL AND element_tag_id IS NULL)
 )
);

CREATE TABLE IF NOT EXISTS sample_insight_statistics (
 id BIGSERIAL PRIMARY KEY,run_id BIGINT NOT NULL REFERENCES sample_insight_runs(id) ON DELETE RESTRICT,feature_key TEXT NOT NULL,
 feature_type TEXT NOT NULL,dimension_key TEXT,frozen_label TEXT NOT NULL,reliability TEXT NOT NULL,
 n_eligible INT NOT NULL,n_outcome_observed INT NOT NULL,n_feature_observed INT NOT NULL,n_observed INT NOT NULL,n_present INT NOT NULL,n_absent INT NOT NULL,
 unique_accounts INT NOT NULL,outcome_coverage NUMERIC(8,7) NOT NULL,feature_coverage NUMERIC(8,7) NOT NULL,
 present_median NUMERIC,present_q1 NUMERIC,present_q3 NUMERIC,absent_median NUMERIC,absent_q1 NUMERIC,absent_q3 NUMERIC,
 median_difference NUMERIC,cliffs_delta NUMERIC,median_difference_ci_low NUMERIC,median_difference_ci_high NUMERIC,cliffs_delta_ci_low NUMERIC,cliffs_delta_ci_high NUMERIC,
 direction TEXT,limitation TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CONSTRAINT sample_insight_statistics_key_uk UNIQUE(run_id,feature_key),CONSTRAINT sample_insight_statistics_type_chk CHECK(feature_type IN('single','combination')),
 CONSTRAINT sample_insight_statistics_reliability_chk CHECK(reliability IN('insufficient','exploratory','directional','stronger_descriptive')),
 CONSTRAINT sample_insight_statistics_counts_chk CHECK(n_eligible>=0 AND n_outcome_observed>=0 AND n_feature_observed>=0 AND n_observed>=0 AND n_present>=0 AND n_absent>=0 AND n_present+n_absent=n_observed),
 CONSTRAINT sample_insight_statistics_coverage_chk CHECK(outcome_coverage BETWEEN 0 AND 1 AND feature_coverage BETWEEN 0 AND 1),
 CONSTRAINT sample_insight_statistics_small_n_chk CHECK(reliability<>'insufficient' OR(present_median IS NULL AND present_q1 IS NULL AND present_q3 IS NULL AND absent_median IS NULL AND absent_q1 IS NULL AND absent_q3 IS NULL AND median_difference IS NULL AND cliffs_delta IS NULL AND median_difference_ci_low IS NULL AND median_difference_ci_high IS NULL AND cliffs_delta_ci_low IS NULL AND cliffs_delta_ci_high IS NULL AND direction IS NULL))
);

CREATE OR REPLACE FUNCTION sample_stage4_append_only_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 RAISE EXCEPTION '% rows are append-only',TG_TABLE_NAME USING ERRCODE='55000'; END $$;

CREATE OR REPLACE FUNCTION sample_stage4_job_state_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE final_success TEXT;BEGIN IF TG_OP='DELETE'THEN RAISE EXCEPTION 'job audit rows cannot be deleted' USING ERRCODE='55000';END IF;final_success:=CASE WHEN TG_TABLE_NAME='sample_insight_runs'THEN'complete'ELSE'succeeded'END;
 IF OLD.status IN(final_success,'failed','cancelled')THEN RAISE EXCEPTION 'terminal jobs are immutable' USING ERRCODE='55000';END IF;
 IF NEW.status=OLD.status THEN RETURN NEW;END IF;
 IF OLD.status='queued'AND NEW.status NOT IN('running','cancelled')THEN RAISE EXCEPTION 'invalid queued job transition' USING ERRCODE='23514';END IF;
 IF OLD.status='running'AND NEW.status NOT IN('queued',final_success,'failed','cancelled')THEN RAISE EXCEPTION 'invalid running job transition' USING ERRCODE='23514';END IF;
 IF OLD.status='running'AND NEW.status='queued'AND(OLD.lease_expires_at IS NULL OR OLD.lease_expires_at>=now()OR OLD.attempts>=OLD.max_attempts)THEN RAISE EXCEPTION 'only an expired retryable lease may requeue' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
DROP TRIGGER IF EXISTS sample_retrieval_builds_state_trg ON sample_retrieval_builds;CREATE TRIGGER sample_retrieval_builds_state_trg BEFORE UPDATE OR DELETE ON sample_retrieval_builds FOR EACH ROW EXECUTE FUNCTION sample_stage4_job_state_guard();
DROP TRIGGER IF EXISTS sample_cluster_jobs_state_trg ON sample_cluster_jobs;CREATE TRIGGER sample_cluster_jobs_state_trg BEFORE UPDATE OR DELETE ON sample_cluster_jobs FOR EACH ROW EXECUTE FUNCTION sample_stage4_job_state_guard();
DROP TRIGGER IF EXISTS sample_insight_runs_state_trg ON sample_insight_runs;CREATE TRIGGER sample_insight_runs_state_trg BEFORE UPDATE OR DELETE ON sample_insight_runs FOR EACH ROW EXECUTE FUNCTION sample_stage4_job_state_guard();

CREATE OR REPLACE FUNCTION sample_stage4_selection_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF TG_TABLE_NAME='sample_retrieval_algorithm_selections'THEN
  IF NOT EXISTS(SELECT 1 FROM sample_retrieval_builds b WHERE b.id=NEW.build_id AND b.algorithm_id=NEW.algorithm_id AND b.status='succeeded'AND b.failed_count=0 AND b.eligible_count=b.succeeded_count+b.excluded_count AND b.succeeded_count=(SELECT count(*)FROM sample_retrieval_build_items i WHERE i.build_id=b.id AND i.status='succeeded')AND b.excluded_count=(SELECT count(*)FROM sample_retrieval_build_items i WHERE i.build_id=b.id AND i.status='excluded')AND NOT EXISTS(SELECT 1 FROM sample_retrieval_build_items i WHERE i.build_id=b.id AND i.status='failed'))THEN RAISE EXCEPTION 'algorithm selection requires complete successful coverage' USING ERRCODE='23514';END IF;
 ELSE IF NOT EXISTS(SELECT 1 FROM sample_cluster_runs r WHERE r.id=NEW.run_id AND r.algorithm_selection_id=NEW.algorithm_selection_id AND r.status='complete')THEN RAISE EXCEPTION 'cluster selection requires a complete matching run' USING ERRCODE='23514';END IF;END IF;RETURN NEW;END $$;
DROP TRIGGER IF EXISTS sample_retrieval_algorithm_selections_validate_trg ON sample_retrieval_algorithm_selections;CREATE TRIGGER sample_retrieval_algorithm_selections_validate_trg BEFORE INSERT ON sample_retrieval_algorithm_selections FOR EACH ROW EXECUTE FUNCTION sample_stage4_selection_guard();
DROP TRIGGER IF EXISTS sample_cluster_selections_validate_trg ON sample_cluster_selections;CREATE TRIGGER sample_cluster_selections_validate_trg BEFORE INSERT ON sample_cluster_selections FOR EACH ROW EXECUTE FUNCTION sample_stage4_selection_guard();

CREATE OR REPLACE FUNCTION sample_stage4_profile_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n INT;bad INT;BEGIN
 IF TG_OP='DELETE' AND OLD.status='complete' THEN RAISE EXCEPTION 'complete profile is immutable' USING ERRCODE='55000';END IF;
 IF TG_OP='UPDATE' AND OLD.status='complete' THEN RAISE EXCEPTION 'complete profile is immutable' USING ERRCODE='55000';END IF;
 IF TG_OP='INSERT' AND NEW.status<>'building' THEN RAISE EXCEPTION 'profile starts building' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT'AND NOT EXISTS(SELECT 1 FROM sample_retrieval_builds b WHERE b.id=NEW.build_id AND b.algorithm_id=NEW.algorithm_id AND b.status='running')THEN RAISE EXCEPTION 'profile requires its running algorithm build' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' AND NEW.status='complete' THEN SELECT count(*),count(*)FILTER(WHERE v.dimension_key IS NULL) INTO n,bad FROM sample_analysis_dimensions d LEFT JOIN sample_retrieval_dimension_vectors v ON v.profile_id=NEW.id AND v.dimension_key=d.dimension_key;
   IF n<>15 OR bad<>0 THEN RAISE EXCEPTION 'complete sample profile requires exactly 15 canonical vectors' USING ERRCODE='23514';END IF;
   IF NOT EXISTS(SELECT 1 FROM sample_analysis_versions av WHERE av.id=NEW.analysis_version_id AND av.sample_id=NEW.sample_id AND av.status='complete')THEN RAISE EXCEPTION 'profile analysis must be complete' USING ERRCODE='23514';END IF;
 END IF;RETURN CASE WHEN TG_OP='DELETE'THEN OLD ELSE NEW END;END $$;
DROP TRIGGER IF EXISTS sample_retrieval_profiles_guard_trg ON sample_retrieval_profiles;
CREATE TRIGGER sample_retrieval_profiles_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON sample_retrieval_profiles FOR EACH ROW EXECUTE FUNCTION sample_stage4_profile_guard();

CREATE OR REPLACE FUNCTION sample_stage4_build_item_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF TG_OP<>'INSERT'THEN RAISE EXCEPTION 'build items are append-only' USING ERRCODE='55000';END IF;IF NOT EXISTS(SELECT 1 FROM sample_retrieval_builds b WHERE b.id=NEW.build_id AND b.status='running')THEN RAISE EXCEPTION 'build items require a running build' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
DROP TRIGGER IF EXISTS sample_retrieval_build_items_guard_trg ON sample_retrieval_build_items;CREATE TRIGGER sample_retrieval_build_items_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON sample_retrieval_build_items FOR EACH ROW EXECUTE FUNCTION sample_stage4_build_item_guard();

CREATE OR REPLACE FUNCTION sample_stage4_profile_child_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s TEXT;pid BIGINT;BEGIN pid:=CASE WHEN TG_OP='DELETE'THEN OLD.profile_id ELSE NEW.profile_id END;SELECT status INTO s FROM sample_retrieval_profiles WHERE id=pid;
 IF s='complete'THEN RAISE EXCEPTION 'complete profile children are immutable' USING ERRCODE='55000';END IF;RETURN CASE WHEN TG_OP='DELETE'THEN OLD ELSE NEW END;END $$;
DROP TRIGGER IF EXISTS sample_retrieval_vectors_guard_trg ON sample_retrieval_dimension_vectors;
CREATE TRIGGER sample_retrieval_vectors_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON sample_retrieval_dimension_vectors FOR EACH ROW EXECUTE FUNCTION sample_stage4_profile_child_guard();

CREATE OR REPLACE FUNCTION sample_stage4_vector_numeric_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE calculated_norm BIGINT;calculated_nonzero INT;BEGIN SELECT COALESCE(sum(x::bigint*x::bigint),0),count(*)FILTER(WHERE x<>0)INTO calculated_norm,calculated_nonzero FROM unnest(NEW.vector)x;
 IF EXISTS(SELECT 1 FROM unnest(NEW.vector)x WHERE x=-32768)THEN RAISE EXCEPTION 'Q15 vectors may not contain -32768' USING ERRCODE='23514';END IF;
 IF calculated_norm<>NEW.norm_sq OR calculated_nonzero<>NEW.nonzero_count THEN RAISE EXCEPTION 'vector norm_sq/nonzero_count must equal its Q15 array' USING ERRCODE='23514';END IF;
 IF NEW.band_0<>(substring(NEW.simhash FROM 1 FOR 8)::bit(8)::int)OR NEW.band_1<>(substring(NEW.simhash FROM 9 FOR 8)::bit(8)::int)OR NEW.band_2<>(substring(NEW.simhash FROM 17 FOR 8)::bit(8)::int)OR NEW.band_3<>(substring(NEW.simhash FROM 25 FOR 8)::bit(8)::int)OR NEW.band_4<>(substring(NEW.simhash FROM 33 FOR 8)::bit(8)::int)OR NEW.band_5<>(substring(NEW.simhash FROM 41 FOR 8)::bit(8)::int)OR NEW.band_6<>(substring(NEW.simhash FROM 49 FOR 8)::bit(8)::int)OR NEW.band_7<>(substring(NEW.simhash FROM 57 FOR 8)::bit(8)::int)THEN RAISE EXCEPTION 'LSH bands must match simhash big-endian bit order' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
DROP TRIGGER IF EXISTS sample_retrieval_vectors_numeric_trg ON sample_retrieval_dimension_vectors;CREATE TRIGGER sample_retrieval_vectors_numeric_trg BEFORE INSERT OR UPDATE ON sample_retrieval_dimension_vectors FOR EACH ROW EXECUTE FUNCTION sample_stage4_vector_numeric_guard();
DROP TRIGGER IF EXISTS component_retrieval_vectors_numeric_trg ON component_retrieval_vectors;CREATE TRIGGER component_retrieval_vectors_numeric_trg BEFORE INSERT OR UPDATE ON component_retrieval_vectors FOR EACH ROW EXECUTE FUNCTION sample_stage4_vector_numeric_guard();

CREATE OR REPLACE FUNCTION sample_stage4_component_profile_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n INT;BEGIN IF TG_OP='DELETE'AND OLD.status='complete'THEN RAISE EXCEPTION 'complete component profile immutable' USING ERRCODE='55000';END IF;
 IF TG_OP='UPDATE'AND OLD.status='complete'THEN RAISE EXCEPTION 'complete component profile immutable' USING ERRCODE='55000';END IF;
 IF TG_OP='INSERT'AND NEW.status<>'building'THEN RAISE EXCEPTION 'profile starts building' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT'AND NOT EXISTS(SELECT 1 FROM sample_retrieval_builds b WHERE b.id=NEW.build_id AND b.algorithm_id=NEW.algorithm_id AND b.status='running')THEN RAISE EXCEPTION 'component profile requires its running algorithm build' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE'AND NEW.status='complete'THEN SELECT count(*)INTO n FROM component_retrieval_vectors WHERE profile_id=NEW.id;IF n<>1 THEN RAISE EXCEPTION 'complete component profile requires one vector' USING ERRCODE='23514';END IF;
  IF NOT EXISTS(SELECT 1 FROM content_components c JOIN content_component_revisions r ON r.id=NEW.revision_id JOIN content_component_revision_decisions d ON d.id=NEW.approving_decision_id WHERE c.id=NEW.component_id AND c.lifecycle_state='active'AND r.state='approved'AND d.decision='approved')THEN RAISE EXCEPTION 'component profile must pin active approved revision' USING ERRCODE='23514';END IF;END IF;
 RETURN CASE WHEN TG_OP='DELETE'THEN OLD ELSE NEW END;END $$;
DROP TRIGGER IF EXISTS component_retrieval_profiles_guard_trg ON component_retrieval_profiles;
CREATE TRIGGER component_retrieval_profiles_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON component_retrieval_profiles FOR EACH ROW EXECUTE FUNCTION sample_stage4_component_profile_guard();

CREATE OR REPLACE FUNCTION sample_stage4_component_vector_guard() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE s TEXT;BEGIN SELECT status INTO s FROM component_retrieval_profiles WHERE id=CASE WHEN TG_OP='DELETE'THEN OLD.profile_id ELSE NEW.profile_id END;IF s='complete'THEN RAISE EXCEPTION 'complete profile children immutable' USING ERRCODE='55000';END IF;RETURN CASE WHEN TG_OP='DELETE'THEN OLD ELSE NEW END;END $$;
DROP TRIGGER IF EXISTS component_retrieval_vectors_guard_trg ON component_retrieval_vectors;
CREATE TRIGGER component_retrieval_vectors_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON component_retrieval_vectors FOR EACH ROW EXECUTE FUNCTION sample_stage4_component_vector_guard();

CREATE OR REPLACE FUNCTION sample_stage4_tag_observation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE k TEXT;active BOOLEAN;BEGIN SELECT kind,t.active INTO k,active FROM tags t WHERE id=NEW.tag_id;IF k IS DISTINCT FROM NEW.dimension_key OR active IS DISTINCT FROM true THEN RAISE EXCEPTION 'observation tag must be active and match dimension' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM sample_analysis_versions v WHERE v.id=NEW.analysis_version_id AND v.sample_id=NEW.sample_id AND v.status='complete')THEN RAISE EXCEPTION 'observation requires complete analysis' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
DROP TRIGGER IF EXISTS sample_element_tag_observations_validate_trg ON sample_element_tag_observations;
CREATE TRIGGER sample_element_tag_observations_validate_trg BEFORE INSERT ON sample_element_tag_observations FOR EACH ROW EXECUTE FUNCTION sample_stage4_tag_observation_guard();

CREATE OR REPLACE FUNCTION sample_stage4_insight_feature_validate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE canonical BIGINT[];tag_kind TEXT;tag_origin TEXT;observed_state TEXT;BEGIN SELECT array_agg(DISTINCT x ORDER BY x)INTO canonical FROM unnest(NEW.tag_ids)x;IF canonical IS DISTINCT FROM NEW.tag_ids THEN RAISE EXCEPTION 'feature tag_ids must be sorted and distinct' USING ERRCODE='23514';END IF;
 IF NEW.feature_type='single'THEN SELECT kind INTO tag_kind FROM tags WHERE id=NEW.tag_id;IF tag_kind IS DISTINCT FROM NEW.dimension_key THEN RAISE EXCEPTION 'single feature tag kind must match dimension' USING ERRCODE='23514';END IF;END IF;
 IF NEW.source='explicit_observation'THEN SELECT state INTO observed_state FROM sample_element_tag_observations WHERE id=NEW.observation_id;IF observed_state IS DISTINCT FROM NEW.state THEN RAISE EXCEPTION 'explicit feature state must equal its observation state' USING ERRCODE='23514';END IF;END IF;
 IF NEW.source IN('manual_tag','effective_tag')THEN SELECT origin INTO tag_origin FROM sample_element_tags WHERE id=NEW.element_tag_id;IF NEW.source='manual_tag'AND tag_origin IS DISTINCT FROM'manual'THEN RAISE EXCEPTION 'manual feature provenance requires a manual element tag' USING ERRCODE='23514';END IF;END IF;RETURN NEW;END $$;
DROP TRIGGER IF EXISTS sample_insight_run_features_validate_trg ON sample_insight_run_features;CREATE TRIGGER sample_insight_run_features_validate_trg BEFORE INSERT ON sample_insight_run_features FOR EACH ROW EXECUTE FUNCTION sample_stage4_insight_feature_validate();

CREATE OR REPLACE FUNCTION sample_stage4_parent_child_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rid BIGINT;s TEXT;BEGIN rid:=CASE WHEN TG_OP='DELETE'THEN OLD.run_id ELSE NEW.run_id END;
 IF TG_TABLE_NAME LIKE 'sample_cluster_%' THEN SELECT status INTO s FROM sample_cluster_runs WHERE id=rid;ELSE SELECT status INTO s FROM sample_insight_runs WHERE id=rid;END IF;
 IF TG_OP='INSERT'THEN
  IF TG_TABLE_NAME='sample_cluster_run_profiles'THEN
   IF NOT EXISTS(SELECT 1 FROM sample_cluster_runs r JOIN sample_retrieval_algorithm_selections sel ON sel.id=r.algorithm_selection_id JOIN sample_retrieval_profiles p ON p.id=NEW.profile_id AND p.sample_id=NEW.sample_id AND p.build_id=sel.build_id AND p.algorithm_id=sel.algorithm_id AND p.status='complete'JOIN sample_retrieval_states st ON st.sample_id=NEW.sample_id AND st.last_profile_id=p.id AND NOT st.dirty AND st.current_fingerprint=p.input_sha256 WHERE r.id=NEW.run_id AND r.algorithm_selection_id=NEW.algorithm_selection_id)THEN RAISE EXCEPTION 'cluster input must pin a fresh selected profile' USING ERRCODE='23514';END IF;
  ELSIF TG_TABLE_NAME='sample_insight_statistics'THEN
   IF NOT EXISTS(SELECT 1 FROM sample_insight_run_features f WHERE f.run_id=NEW.run_id AND f.feature_key=NEW.feature_key)THEN RAISE EXCEPTION 'statistic feature must belong to the same run' USING ERRCODE='23503';END IF;
  END IF;
 END IF;
 IF s IN('complete','failed','cancelled')THEN RAISE EXCEPTION 'terminal run children immutable' USING ERRCODE='55000';END IF;RETURN CASE WHEN TG_OP='DELETE'THEN OLD ELSE NEW END;END $$;
DO $$ DECLARE t TEXT;BEGIN FOREACH t IN ARRAY ARRAY['sample_cluster_run_profiles','sample_clusters','sample_cluster_members','sample_insight_run_members','sample_insight_run_features','sample_insight_statistics']LOOP
 EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I',t||'_guard_trg',t);EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION sample_stage4_parent_child_guard()',t||'_guard_trg',t);END LOOP;END $$;

CREATE OR REPLACE FUNCTION sample_stage4_cluster_run_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE inputs INT;assigned INT;bad INT;BEGIN IF TG_OP='DELETE'OR OLD.status IN('complete','failed')THEN RAISE EXCEPTION 'terminal cluster run immutable' USING ERRCODE='55000';END IF;
 IF NEW.status='complete'AND OLD.status='building'THEN SELECT count(*)INTO inputs FROM sample_cluster_run_profiles WHERE run_id=NEW.id;SELECT count(*)INTO assigned FROM sample_cluster_members WHERE run_id=NEW.id;
 SELECT count(*)INTO bad FROM sample_cluster_members m WHERE m.run_id=NEW.id AND((m.is_outlier AND m.cluster_id IS NOT NULL)OR(NOT m.is_outlier AND m.cluster_id IS NULL));
 IF EXISTS(SELECT 1 FROM sample_clusters c WHERE c.run_id=NEW.id AND((SELECT count(*)FROM sample_cluster_members m WHERE m.run_id=c.run_id AND m.cluster_id=c.id)<3 OR(SELECT count(*)FROM sample_cluster_members m WHERE m.run_id=c.run_id AND m.cluster_id=c.id AND m.representative)<>1 OR NOT EXISTS(SELECT 1 FROM sample_cluster_members m WHERE m.run_id=c.run_id AND m.cluster_id=c.id AND m.sample_id=c.representative_sample_id AND m.representative)))THEN bad:=bad+1;END IF;
 IF inputs<>NEW.profile_count OR assigned<>inputs OR bad<>0 THEN RAISE EXCEPTION 'complete cluster run must assign every input exactly once and validate clusters' USING ERRCODE='23514';END IF;END IF;RETURN NEW;END $$;
DROP TRIGGER IF EXISTS sample_cluster_runs_guard_trg ON sample_cluster_runs;CREATE TRIGGER sample_cluster_runs_guard_trg BEFORE UPDATE OR DELETE ON sample_cluster_runs FOR EACH ROW EXECUTE FUNCTION sample_stage4_cluster_run_guard();

CREATE OR REPLACE FUNCTION sample_stage4_insight_run_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF TG_OP='DELETE'OR OLD.status IN('complete','failed','cancelled')THEN RAISE EXCEPTION 'terminal insight run immutable' USING ERRCODE='55000';END IF;
 IF NEW.status='complete'AND OLD.status='running'THEN
  IF NOT EXISTS(SELECT 1 FROM sample_insight_run_members WHERE run_id=NEW.id AND outcome_state='observed')THEN RAISE EXCEPTION 'complete insight needs observed outcomes' USING ERRCODE='23514';END IF;
  IF EXISTS(WITH expected AS(
    SELECT 'tag:'||value feature_key,'single'feature_type,ARRAY[value::bigint]tag_ids FROM jsonb_array_elements_text(NEW.normalized_request#>'{features,singleTagIds}')
    UNION ALL SELECT'tags:'||x.feature_key,'combination',x.tag_ids FROM jsonb_array_elements(NEW.normalized_request#>'{features,combinations}')combo
      CROSS JOIN LATERAL(SELECT string_agg(value,'+'ORDER BY ord)feature_key,array_agg(value::bigint ORDER BY ord)tag_ids FROM jsonb_array_elements_text(combo.value)WITH ORDINALITY z(value,ord))x)
    SELECT 1 FROM sample_insight_run_members m WHERE m.run_id=NEW.id AND(
      EXISTS(SELECT 1 FROM expected e WHERE NOT EXISTS(SELECT 1 FROM sample_insight_run_features f WHERE f.run_id=NEW.id AND f.member_id=m.id AND f.feature_key=e.feature_key AND f.feature_type=e.feature_type AND f.tag_ids=e.tag_ids))OR
      EXISTS(SELECT 1 FROM sample_insight_run_features f WHERE f.run_id=NEW.id AND f.member_id=m.id AND NOT EXISTS(SELECT 1 FROM expected e WHERE e.feature_key=f.feature_key AND e.feature_type=f.feature_type AND e.tag_ids=f.tag_ids))))
  THEN RAISE EXCEPTION 'every insight member must freeze the exact canonical requested feature set' USING ERRCODE='23514';END IF;
  IF EXISTS(WITH expected AS(
    SELECT 'tag:'||value feature_key,'single'feature_type FROM jsonb_array_elements_text(NEW.normalized_request#>'{features,singleTagIds}')
    UNION ALL SELECT'tags:'||x.feature_key,'combination'FROM jsonb_array_elements(NEW.normalized_request#>'{features,combinations}')combo
      CROSS JOIN LATERAL(SELECT string_agg(value,'+'ORDER BY ord)feature_key FROM jsonb_array_elements_text(combo.value)WITH ORDINALITY z(value,ord))x)
    SELECT 1 FROM expected e WHERE NOT EXISTS(SELECT 1 FROM sample_insight_statistics s WHERE s.run_id=NEW.id AND s.feature_key=e.feature_key AND s.feature_type=e.feature_type)
    UNION ALL SELECT 1 FROM sample_insight_statistics s WHERE s.run_id=NEW.id AND NOT EXISTS(SELECT 1 FROM expected e WHERE e.feature_key=s.feature_key AND e.feature_type=s.feature_type))
  THEN RAISE EXCEPTION 'insight statistics must equal the canonical requested feature set' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;END $$;
DROP TRIGGER IF EXISTS sample_insight_runs_guard_trg ON sample_insight_runs;CREATE TRIGGER sample_insight_runs_guard_trg BEFORE UPDATE OR DELETE ON sample_insight_runs FOR EACH ROW EXECUTE FUNCTION sample_stage4_insight_run_guard();

DO $$ DECLARE t TEXT;BEGIN FOREACH t IN ARRAY ARRAY['sample_retrieval_algorithms','sample_retrieval_algorithm_selections','sample_cluster_selections','sample_element_tag_observations']LOOP
 EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I',t||'_append_only_trg',t);EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION sample_stage4_append_only_guard()',t||'_append_only_trg',t);END LOOP;END $$;

CREATE OR REPLACE FUNCTION sample_stage4_mark_sample_dirty() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sid BIGINT;BEGIN
 IF TG_TABLE_NAME='samples'THEN sid:=COALESCE(NEW.id,OLD.id);
 ELSIF TG_TABLE_NAME='sample_analysis_selections'THEN sid:=NEW.sample_id;
 ELSIF TG_TABLE_NAME='sample_element_decisions'THEN SELECT v.sample_id INTO sid FROM sample_analysis_elements e JOIN sample_analysis_versions v ON v.id=e.version_id JOIN samples s ON s.id=v.sample_id AND s.current_analysis_version_id=v.id WHERE e.id=NEW.element_id;
 ELSIF TG_TABLE_NAME='sample_element_tags'THEN SELECT v.sample_id INTO sid FROM sample_analysis_versions v JOIN samples s ON s.id=v.sample_id AND s.current_analysis_version_id=v.id WHERE v.id=NEW.version_id;
 ELSE RETURN CASE WHEN TG_OP='DELETE'THEN OLD ELSE NEW END;END IF;
 IF sid IS NULL THEN RETURN CASE WHEN TG_OP='DELETE'THEN OLD ELSE NEW END;END IF;
 INSERT INTO sample_retrieval_states(sample_id,dirty,dirty_generation)VALUES(sid,true,1)ON CONFLICT(sample_id)DO UPDATE SET dirty=true,dirty_generation=sample_retrieval_states.dirty_generation+1,updated_at=now();RETURN CASE WHEN TG_OP='DELETE'THEN OLD ELSE NEW END;END $$;
DROP TRIGGER IF EXISTS sample_stage4_samples_dirty_trg ON samples;CREATE TRIGGER sample_stage4_samples_dirty_trg AFTER UPDATE OF current_analysis_version_id ON samples FOR EACH ROW WHEN(OLD.current_analysis_version_id IS DISTINCT FROM NEW.current_analysis_version_id)EXECUTE FUNCTION sample_stage4_mark_sample_dirty();
DROP TRIGGER IF EXISTS sample_stage4_selection_dirty_trg ON sample_analysis_selections;CREATE TRIGGER sample_stage4_selection_dirty_trg AFTER INSERT ON sample_analysis_selections FOR EACH ROW EXECUTE FUNCTION sample_stage4_mark_sample_dirty();
DROP TRIGGER IF EXISTS sample_stage4_decision_dirty_trg ON sample_element_decisions;CREATE TRIGGER sample_stage4_decision_dirty_trg AFTER INSERT ON sample_element_decisions FOR EACH ROW EXECUTE FUNCTION sample_stage4_mark_sample_dirty();
DROP TRIGGER IF EXISTS sample_stage4_element_tag_dirty_trg ON sample_element_tags;CREATE TRIGGER sample_stage4_element_tag_dirty_trg AFTER INSERT ON sample_element_tags FOR EACH ROW EXECUTE FUNCTION sample_stage4_mark_sample_dirty();

CREATE OR REPLACE FUNCTION sample_stage4_mark_entity_tag_dirty() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e TEXT;eid BIGINT;BEGIN e:=CASE WHEN TG_OP='DELETE'THEN OLD.entity ELSE NEW.entity END;eid:=CASE WHEN TG_OP='DELETE'THEN OLD.entity_id ELSE NEW.entity_id END;
 IF e='sample'THEN INSERT INTO sample_retrieval_states(sample_id,dirty,dirty_generation)VALUES(eid,true,1)ON CONFLICT(sample_id)DO UPDATE SET dirty=true,dirty_generation=sample_retrieval_states.dirty_generation+1,updated_at=now();END IF;RETURN CASE WHEN TG_OP='DELETE'THEN OLD ELSE NEW END;END $$;
DROP TRIGGER IF EXISTS sample_stage4_entity_tag_dirty_trg ON entity_tags;CREATE TRIGGER sample_stage4_entity_tag_dirty_trg AFTER INSERT OR UPDATE OR DELETE ON entity_tags FOR EACH ROW EXECUTE FUNCTION sample_stage4_mark_entity_tag_dirty();

CREATE OR REPLACE FUNCTION sample_stage4_mark_tag_dictionary_dirty() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF OLD.name IS NOT DISTINCT FROM NEW.name AND OLD.active IS NOT DISTINCT FROM NEW.active AND OLD.kind IS NOT DISTINCT FROM NEW.kind THEN RETURN NEW;END IF;
 INSERT INTO sample_retrieval_states(sample_id,dirty,dirty_generation)
 SELECT DISTINCT s.id,true,1 FROM samples s LEFT JOIN entity_tags et ON et.entity='sample'AND et.entity_id=s.id LEFT JOIN sample_analysis_elements e ON e.version_id=s.current_analysis_version_id LEFT JOIN sample_element_tags st ON st.element_id=e.id WHERE et.tag_id=NEW.id OR st.tag_id=NEW.id
 ON CONFLICT(sample_id)DO UPDATE SET dirty=true,dirty_generation=sample_retrieval_states.dirty_generation+1,updated_at=now();
 INSERT INTO component_retrieval_states(component_id,dirty,dirty_generation)SELECT DISTINCT rt.component_id,true,1 FROM content_component_revision_tags rt WHERE rt.tag_id=NEW.id ON CONFLICT(component_id)DO UPDATE SET dirty=true,dirty_generation=component_retrieval_states.dirty_generation+1,updated_at=now();RETURN NEW;END $$;
DROP TRIGGER IF EXISTS sample_stage4_tag_dictionary_dirty_trg ON tags;CREATE TRIGGER sample_stage4_tag_dictionary_dirty_trg AFTER UPDATE OF name,active,kind ON tags FOR EACH ROW EXECUTE FUNCTION sample_stage4_mark_tag_dictionary_dirty();

CREATE OR REPLACE FUNCTION sample_stage4_mark_component_dirty() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cid BIGINT;BEGIN IF TG_TABLE_NAME='content_components'THEN cid:=COALESCE(NEW.id,OLD.id);ELSE cid:=COALESCE(NEW.component_id,OLD.component_id);END IF;
 INSERT INTO component_retrieval_states(component_id,dirty,dirty_generation)VALUES(cid,true,1)ON CONFLICT(component_id)DO UPDATE SET dirty=true,dirty_generation=component_retrieval_states.dirty_generation+1,updated_at=now();RETURN CASE WHEN TG_OP='DELETE'THEN OLD ELSE NEW END;END $$;
DROP TRIGGER IF EXISTS sample_stage4_component_selection_dirty_trg ON content_component_selections;CREATE TRIGGER sample_stage4_component_selection_dirty_trg AFTER INSERT ON content_component_selections FOR EACH ROW EXECUTE FUNCTION sample_stage4_mark_component_dirty();
DROP TRIGGER IF EXISTS sample_stage4_component_tag_dirty_trg ON content_component_revision_tags;CREATE TRIGGER sample_stage4_component_tag_dirty_trg AFTER INSERT OR UPDATE OR DELETE ON content_component_revision_tags FOR EACH ROW EXECUTE FUNCTION sample_stage4_mark_component_dirty();
DROP TRIGGER IF EXISTS sample_stage4_component_lifecycle_dirty_trg ON content_components;CREATE TRIGGER sample_stage4_component_lifecycle_dirty_trg AFTER UPDATE OF lifecycle_state ON content_components FOR EACH ROW WHEN(OLD.lifecycle_state IS DISTINCT FROM NEW.lifecycle_state)EXECUTE FUNCTION sample_stage4_mark_component_dirty();

COMMIT;
