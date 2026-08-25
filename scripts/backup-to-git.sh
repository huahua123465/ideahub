#!/bin/sh
# 把整套东西备份到 GitHub 私有仓库：代码 + .env + 附件 + 整库数据。
#
# 用法：
#   sh scripts/backup-to-git.sh            # 备份并推送
#   sh scripts/backup-to-git.sh --no-push  # 只提交到本地，不推
#
# 装进 crontab（每天 03:20 一次）：
#   20 3 * * * sh scripts/backup-to-git.sh >> /var/log/ideahub-gitbackup.log 2>&1
set -eu

cd "$(dirname "$0")/.."
STAMP="$(date '+%F %H:%M')"

# ---- 数据库 ----
# 导成 .sql 而不是 .sql.gz：压缩包对 git 是一团二进制，每天都要整份重存；
# 纯文本 git 能做增量压缩，改了几行就只多存几行。
# 0.29MB 的库压不压缩都无所谓，但一年 365 次提交的差别是几百 MB。
mkdir -p backup
docker compose exec -T db pg_dump -U ideahub -d ideahub --no-owner --no-privileges > backup/ideahub-db.sql.tmp

# 小于 10KB 基本可以断定导出失败了 —— 与其用一个空文件覆盖掉上一次的好备份，
# 不如就地报错退出。备份脚本最坏的失败方式是"看起来成功了"。
SIZE=$(wc -c < backup/ideahub-db.sql.tmp)
if [ "$SIZE" -lt 10240 ]; then
  echo "[备份] 失败：导出只有 ${SIZE} 字节，保留上一次的备份不动"
  rm -f backup/ideahub-db.sql.tmp
  exit 1
fi
mv backup/ideahub-db.sql.tmp backup/ideahub-db.sql

# ---- 提交 ----
# 附件（data/uploads）本身就在工作区里跟踪着，git add -A 会带上新增的那些。
git add -A
if git diff --cached --quiet; then
  echo "[备份] $STAMP 没有变化，跳过"
  exit 0
fi

COUNT=$(docker compose exec -T db psql -U ideahub -d ideahub -At -c \
  "select sum(n_live_tup)::bigint from pg_stat_user_tables" 2>/dev/null | tr -d '\r' || echo '?')
git commit -q -m "备份 $STAMP（数据库 $(numfmt --to=iec "$SIZE" 2>/dev/null || echo "${SIZE}B")，约 ${COUNT} 行数据）"

if [ "${1:-}" = "--no-push" ]; then
  echo "[备份] $STAMP 已提交到本地（未推送）"
  exit 0
fi
if ! git remote get-url origin >/dev/null 2>&1; then
  echo "[备份] $STAMP 已提交，但还没配 origin，没推"
  exit 0
fi
git push -q origin HEAD
echo "[备份] $STAMP 已推送，数据库 $(numfmt --to=iec "$SIZE" 2>/dev/null || echo "${SIZE}B")"
