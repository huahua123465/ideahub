# Collector 容器部署片段

Collector 只能由 IdeaHub 通过 Docker 内部网络调用，禁止在 Compose 中配置
`ports:`。容器内监听 `5000`，未配置至少 32 字节
`COLLECTOR_INTERNAL_TOKEN` 时入口脚本会拒绝启动。

持久化目录：

- `/var/lib/collector/state`：SQLite、Cookie、storage state、二维码临时文件；
- `/var/lib/collector/output`：采集结果和媒体。

建议 Compose 安全/资源项：

```yaml
collector:
  build: ./services/data-clean
  init: true
  expose: ["5000"]
  mem_limit: 1536m
  cpus: 1.5
  pids_limit: 256
  shm_size: 256m
  cap_drop: [ALL]
  security_opt: [no-new-privileges:true]
  volumes:
    - /opt/ideahub-collector/state:/var/lib/collector/state
    - /opt/ideahub-collector/output:/var/lib/collector/output
  healthcheck:
    test: ["CMD", "curl", "-fsS", "http://127.0.0.1:5000/health"]
    interval: 30s
    timeout: 5s
    retries: 3
```

运行前在 VPS 建立两个宿主机目录并将其所有者设置为 `10001:10001`。
二维码接口仅返回二维码截图，Cookie 和 storage state 永远保留在 state 持久卷。
原始媒体建议 7 天清理一次；清理前确认任务不处于 pending/running 状态。
