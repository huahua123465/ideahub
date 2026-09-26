-- 界面偏好跟着账号走（2026-09-26）
--
-- 上线方式：先做一次经过验证的 PostgreSQL 备份，再把整个文件执行一次。
-- 重复执行是安全的：只建一张新表，不写数据，不改动任何已有的表和数据。
-- 中途失败会整体回滚，修好原因后重跑即可，不要为了重试去删表或恢复整库。
-- 内容与 server/src/schema.sql「界面偏好」一节里的 user_ui_prefs 保持一致。
--
-- 新增：
--   user_ui_prefs  每人一行：配色与外观、我的配色、明暗（前端的数据结构，JSONB）
--
-- 数据：这张表一开始是空的。用户下次打开页面时，前端会把这台浏览器里的设置推上来；
-- 之后在别的电脑、别的浏览器登录，就会用上同一套。
-- 回退：应用退回旧版本时，这张表原样留着即可（旧代码不读它，不影响任何功能）；
-- 真要去掉，确认不再需要后再单独执行 DROP TABLE user_ui_prefs;（不可逆，先备份）。
BEGIN;

CREATE TABLE IF NOT EXISTS user_ui_prefs (
  user_id     BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  prefs       JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;

-- 验证（执行完看一眼）：
--   SELECT to_regclass('public.user_ui_prefs') AS table_exists;           -- 应返回 user_ui_prefs
--   SELECT count(*) FROM user_ui_prefs;                                    -- 刚建好是 0
