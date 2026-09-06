---
name: ideahub-backend
description: IdeaHub Node.js 后端与 API 开发工作流。凡是修改 server/src/routes、server/src/lib、认证授权、会话、事件、上传、DTO、AI provider、服务端业务逻辑或 API 测试时都应使用；如果改动涉及表、字段、索引或迁移，还必须同时使用 ideahub-database。不要用它处理纯前端视觉或 VPS 网络配置。
compatibility: IdeaHub repository; Node.js 20+; PostgreSQL 16 for database-backed tests.
metadata:
  version: "1.0.0"
  owner: "ideahub"
---

# IdeaHub Backend

## Mission

维护一个依赖少、边界清楚的内部业务服务。接口必须在真实权限、错误、并发和数据边界下成立，不能只让成功路径返回一个看似正确的 JSON。

## Success Bar

- 路由、业务逻辑与数据访问职责清楚，错误有稳定状态码和可执行信息。
- 所有读写遵守登录、角色、资源归属和 CSRF/SSRF 等既有边界。
- 响应 DTO 与前端、mock、测试保持一致，不泄露内部 token、Cookie、堆栈或存储路径。
- 修改后的 JavaScript 通过语法检查，相关 API 测试在隔离数据库上通过。

## Workflow

1. 读根目录 `AGENTS.md`，确认同步、数据和环境限制。
2. 定位路由、对应 `server/src/lib/`、数据库访问、前端调用与现有测试。
3. 明确权限主体、输入约束、成功 DTO、错误 DTO、幂等性和并发行为。
4. 延续现有 Node 内置 `http`、router 和 `pg` 模式，不为单个接口引入新框架。
5. 修改表、字段、索引或 SQL 迁移前，切换到 `ideahub-database` 并遵守确认门槛。
6. 对改过的 `.mjs` 运行 `node --check`，再运行最接近的专项测试；有本地数据库时运行 `npm run test:api`。
7. 核对前端和 `web/src/mock.js` 是否需要同步 DTO，但不要用 mock 通过代替服务端验证。

## Decision Rules

- 通用 HTTP/鉴权/错误能力放 `server/src/lib/`；单一业务域行为留在对应 route 或领域 lib。
- 列表接口限制字段、分页和排序；不要把数据库整行或大文件内容直接返回。
- 上传和媒体访问校验类型、大小、路径和资源归属，生成下载地址而不是暴露磁盘路径。
- 删除、归档和重试明确幂等语义；不能把不存在与无权限混成泄露资源存在性的响应。
- 外部 URL、重定向和平台抓取属于高风险输入；Collector 路径同时使用 `ideahub-collector`。
- AI 输出是辅助数据，保留来源、版本、编辑状态和人工确认边界。

## Boundaries

- 不修改或输出 `.env` 与真实密钥。
- 不在普通日志记录 Cookie、token、客户附件正文或完整外部响应。
- 不用生产数据库、备份或真实附件跑写入测试。
- 不通过 `npm run db:reset` 代替迁移。
- Docker、端口和 Caddy 变更改用 `ideahub-release`。

## Common Failure Modes

- 只验证管理员成功路径，成员越权或资源归属没有测试。
- DTO 字段改名后只改服务端，前端和 mock 静默漂移。
- 捕获所有错误并统一返回 500，用户无法恢复，测试也无法区分原因。
- 列表或附件接口返回无界数据，在 4GB VPS 上放大内存和延迟。
- 用生产快照做“方便的测试数据”。

## Final Review

确认语法、输入校验、权限、错误、DTO、幂等/并发、日志脱敏和相关测试都有证据；未能连接本地数据库时明确说明未运行的数据库验证。
