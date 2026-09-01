---
name: ideahub-release
description: IdeaHub 提交、推送、VPS 部署与高风险配置工作流。凡是用户要求提交、上传仓库、推送、发布、部署、给 VPS 命令，或修改 .env、npm 依赖、Docker、Compose、Caddy、端口、域名、证书、健康检查时必须使用。VPS 上操作还必须完整读取 CLAUDE.md；涉及 Collector 或数据库时同时使用对应 skill。
compatibility: Windows local Git workflow plus manual VPS deployment in /root/ideahub-deploy; GitHub private repository.
---

# IdeaHub Release

## Mission

把已经验证的改动安全送到仓库和 VPS，同时保护远端自动备份、生产数据与同机邻居服务。发布是人工重建和短暂停机切换，不是热部署。

## Deployment Classes

- **A**：仅代码、文档、测试或样式。VPS 拉取后按需要重建。
- **B**：新增或升级 npm 依赖。必须提交 `package.json` 与 lockfile；重建时安装。
- **C**：数据库结构或数据迁移。重建不够，VPS 还要备份并人工执行迁移 SQL。
- **D**：`.env`、端口、域名、Docker、Caddy、Collector 环境或网络。维护者先审核影响与步骤。

多类同时出现时按最高风险类别交接。

## Local Commit And Push Workflow

1. 确认改动前已经执行 `git status --short --branch` 和 `git pull --ff-only origin main`。
2. 查看完整 diff，排除 `.env`、备份、附件、生成 bundle、截图和临时文件。
3. 运行与改动匹配的语法、构建、UI、API、数据库或 Collector 检查。
4. 提交前再运行 `git diff --check`。
5. 提交后、推送前执行 `git fetch origin main` 和当前远端分支，确认 VPS 自动备份没有让远端前进。
6. 远端已前进时安全接入新提交并逐项检查冲突；严禁 `git push --force` 或 `--force-with-lease`。
7. 只推送明确的当前分支；未经 Collector 门禁或用户授权，不把功能分支合并进 main。

## VPS Gate

在 VPS 上操作前完整读取根目录 `CLAUDE.md`。它包含 `/root/ideahub-deploy/` 范围、18080 端口、共享 Caddy、邻居服务和禁止命令；本 skill 不替代该文件。

安全发布的最小顺序：

1. `cd /root/ideahub-deploy`。
2. `bash scripts/check-neighbors.sh > /tmp/ideahub-neighbors-before.txt`。
3. 确认 `git status --short --branch` 干净；不干净就停止，不能覆盖。
4. 拉取明确的已推送分支，不使用 reset、force checkout 或改写历史。
5. C 类先备份并按交接执行迁移；D 类先完成人工审核和专项 gate。
6. 需要运行时代码生效时执行 `docker compose up -d --build`。
7. 检查 `docker compose ps`、`/api/health` 与受影响页面。
8. `bash scripts/check-neighbors.sh > /tmp/ideahub-neighbors-after.txt` 并对比前后。

## Hard Boundaries

- 不修改 `/opt/ai-stack/**`、共享 `canvas-media-https`、xray/x-ui 或其他项目，除非用户逐项授权。
- 不运行 `docker system prune`、`docker image prune -a`、`docker volume prune`、批量 stop 或全机 compose down。
- 不删除数据库、volume、`data/`、`backup/ideahub-db.sql` 或真实附件来排错。
- 不展示或复制 `.env` 内容。
- 端口、证书、DNS、共享 Caddy 和线上 SQL 都需要额外人工审核。

## Final Handoff Format

每次完成改动都要给出：

1. **改了什么**：功能和关键文件。
2. **本地验证**：通过、失败与未执行项。
3. **上线类型**：A/B/C/D 及原因。
4. **VPS 待办**：完整可复制命令，或明确写“无”。

推送成功后必须写出仓库、分支和提交号。没有验证远端提交存在，不得声称“已上传”。
