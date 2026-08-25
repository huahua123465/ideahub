#!/bin/sh
# 每天备份一次。灵感库最怕的是丢数据，不是宕机几分钟。
#
# 装进 crontab：
#   0 3 * * * /opt/ideahub/scripts/backup.sh >> /var/log/ideahub-backup.log 2>&1
set -eu

DIR="${BACKUP_DIR:-/backup/ideahub}"
KEEP="${BACKUP_KEEP_DAYS:-30}"
STAMP="$(date +%F-%H%M)"

mkdir -p "$DIR"

docker compose exec -T db pg_dump -U ideahub ideahub \
  | gzip -9 > "$DIR/ideahub-$STAMP.sql.gz"

# 备份文件小于 1KB 基本可以断定是空的 —— 与其留一个假备份，不如直接报错
SIZE=$(wc -c < "$DIR/ideahub-$STAMP.sql.gz")
if [ "$SIZE" -lt 1024 ]; then
  echo "[backup] 失败：产物只有 ${SIZE} 字节，删掉并退出"
  rm -f "$DIR/ideahub-$STAMP.sql.gz"
  exit 1
fi

# ---- 附件 ----
# 数据库里只有元信息，文件本体在 data/uploads。
# 而且磁盘上的文件名是随机的（防路径穿越），原始文件名只存在数据库里 ——
# 所以两者必须一起备份：单独还原一边，文件就认不出是什么了。
UP="$(cd "$(dirname "$0")/.." && pwd)/data/uploads"
if [ -d "$UP" ]; then
  tar czf "$DIR/uploads-$STAMP.tar.gz" -C "$(dirname "$UP")" uploads
  USIZE=$(wc -c < "$DIR/uploads-$STAMP.tar.gz")
  echo "[backup] 附件 $(numfmt --to=iec "$USIZE" 2>/dev/null || echo "$USIZE B")"
else
  echo "[backup] 警告：找不到附件目录 $UP"
fi

find "$DIR" -name 'ideahub-*.sql.gz'  -mtime +"$KEEP" -delete
find "$DIR" -name 'uploads-*.tar.gz'  -mtime +"$KEEP" -delete

echo "[backup] $STAMP 完成，数据库 $(numfmt --to=iec "$SIZE" 2>/dev/null || echo "$SIZE B")，保留 ${KEEP} 天"
