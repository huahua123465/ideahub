#!/usr/bin/env bash
# 邻居服务健康检查 —— 只读，不改任何东西。
#
# 用途：改 IdeaHub 之前跑一次、之后再跑一次，diff 两份输出。
# 有差异就说明这次改动波及了别的项目，立刻停下来。
#
#   bash scripts/check-neighbors.sh > /tmp/before.txt
#   ...改动 + 部署...
#   bash scripts/check-neighbors.sh > /tmp/after.txt
#   diff /tmp/before.txt /tmp/after.txt      # 应当无差异
#
# 输出刻意不含运行时长、时间戳这类必然变化的东西，否则 diff 永远有噪音。

echo "=== 容器状态 ==="
# 只取 running/exited 和 healthy/unhealthy，不取 "Up 12 hours" ——
# 时长每次都不一样，带上它 diff 就没法用了
docker ps -a --format '{{.Names}}' | sort | while read -r n; do
  state=$(docker inspect "$n" --format '{{.State.Status}}' 2>/dev/null)
  health=$(docker inspect "$n" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}-{{end}}' 2>/dev/null)
  printf '%-22s %-10s %s\n' "$n" "$state" "$health"
done

echo
echo "=== 端口占用 ==="
# 去掉 pid：容器重启后 docker-proxy 的 pid 会变，但端口没变，那不算「被影响」
(ss -tlnH 2>/dev/null || netstat -tln 2>/dev/null) \
  | awk '{print $4}' | sed 's/.*://' | grep -E '^[0-9]+$' | sort -un | tr '\n' ' '
echo

echo
echo "=== 各服务探活 ==="
probe() {
  code=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 8 "$2" 2>/dev/null)
  printf '%-26s %s  %s\n' "$1" "${code:-000}" "$2"
}
probe "IdeaHub (直连)"        "http://127.0.0.1:18080/api/health"
probe "IdeaHub (HTTPS)"       "https://xm.xingxingqule.com:9443/api/health"
probe "infinite-canvas"       "http://127.0.0.1:3010/"
probe "new-api"               "http://127.0.0.1:3011/"
probe "canvas-media-https:80" "http://127.0.0.1:80/"

echo
echo "=== 共享配置文件指纹 ==="
# 这个文件同时给三个项目做前置代理，动了它就是动了所有人。
# 只比对哈希，内容不打印（里面可能有不该进日志的东西）
SHARED=/opt/ai-stack/new-api/Caddyfile.canvas-media
if [ -f "$SHARED" ]; then
  printf '%-46s %s\n' "$SHARED" "$(md5sum "$SHARED" | cut -c1-12)"
else
  echo "$SHARED  缺失！"
fi
