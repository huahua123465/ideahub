---
name: ideahub-collector
description: IdeaHub 内容采集 Collector 的开发、审查与部署门禁。凡是修改 services/data-clean、/api/collector 代理、web/src/views/collector.js、Collector 登录/二维码/Cookie、采集任务、OCR/FFmpeg/Chromium、采集 AI、compose 资源限制或采集归档时必须使用，并同时按改动范围使用前端、后端、UI QA 或 release skill。
compatibility: IdeaHub feat/content-collector workflow; Python 3.11, Chromium, FFmpeg, Docker, and a 4 GB VPS resource ceiling.
---

# IdeaHub Collector

## Mission

在不暴露平台凭据、不绕过风控、不拖垮 4GB VPS 的前提下，把内容采集能力安全接入 IdeaHub。Collector 是隔离的内部服务，不是新的公网 API。

## Success Bar

- 浏览器只能访问 IdeaHub `/api/collector/*` 登录与权限代理，不能直连 Collector。
- 平台 Cookie、storage state、SQLite、内部 token、媒体和 AI 密钥不进入前端或普通日志。
- 任务归属、管理员能力、二维码 generation 和删除确认边界正确。
- 容器非 root、资源受限、状态持久化在仓库外，重启后任务可解释且不静默重跑。
- 功能分支通过代码测试和 VPS smoke，真实扫码与一条真实采集验证完成后才允许合并 main。

## Hard Architecture Rules

- `services/data-clean/` 通过 Git subtree 跟踪内部 dataClean 上游，不改成 submodule。
- Collector 只 `expose: 5000` 到 Docker 内网，不添加宿主机 `ports`，不让 Caddy 直接反代。
- 所有浏览器请求经过 IdeaHub `/api/collector/*`，并执行登录、角色和任务归属校验。
- `COLLECTOR_INTERNAL_TOKEN` 至少 32 字节，只在服务间传递。
- 真实 state/output 固定放仓库外 `/opt/ideahub-collector/`。
- 4GB VPS 默认采集并发 1、OCR/数值库线程 1；没有峰值实测不提高。
- 不绕过验证码、平台风控或登录要求；二维码由管理员在 IdeaHub 操作，Cookie 永不返回浏览器。

## Workflow

1. 读 `AGENTS.md`、本 skill 和相关 subtree/代理/compose/前端文件。
2. 标出信任边界：浏览器、IdeaHub、Collector、平台、持久目录与 AI 服务。
3. 先写或更新权限、SSRF、任务状态、凭据脱敏和资源限制测试，再实现功能。
4. 前端改动使用 `ideahub-frontend` 与 `ideahub-ui-qa`；代理改动使用 `ideahub-backend`。
5. 运行 Collector 代理、compose、archive UI、Python 单测和相关前端测试。
6. 修改 Collector、Compose 或采集环境变量时按 D 类交接；推 main 前在 VPS 运行 `bash scripts/check-collector-vps.sh`。
7. 完成一次真实小红书/抖音采集、二维码登录与 IdeaHub 归档验证后，才可解除功能分支合并门禁。

## Boundaries

- 没有用户逐项授权，不修改 `.env`、Docker/Caddy 或线上状态。
- 不在本地测试中使用真实平台 Cookie 或生产输出目录。
- 不用提高并发、扩大 shm 或取消超时来掩盖任务设计问题。
- 不把失败任务静默重新执行；重启中断应标记为可解释、可人工重试的状态。

## Final Review

交接必须列出已通过的代码级检查、尚未执行的 VPS/真实平台检查、D 类部署影响和 main 合并门禁状态。缺少真实 VPS smoke 时只能说“已推功能分支，禁止合并 main”。
