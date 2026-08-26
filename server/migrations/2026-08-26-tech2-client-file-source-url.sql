-- 技术2按 externalId 上传客户附件：记录上游文件的原始来源地址。
-- 上线前先备份生产数据库，再执行本文件；可重复执行。
BEGIN;

ALTER TABLE attachments
  ADD COLUMN IF NOT EXISTS source_url TEXT;

COMMIT;

-- 验证：应返回 source_url / text / YES
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name = 'attachments'
   AND column_name = 'source_url';
