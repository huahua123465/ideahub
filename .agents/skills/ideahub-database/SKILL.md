---
name: ideahub-database
description: IdeaHub PostgreSQL 表结构、迁移与数据安全工作流。凡是涉及 server/src/schema.sql、表、字段、索引、约束、枚举、触发器、生产数据迁移、备份恢复或用户提到“改数据库”“加字段”“迁移线上数据”时必须使用。此类修改在动手前必须先向用户说明生产迁移不会随 Docker 重建自动生效并取得确认。
compatibility: IdeaHub repository; PostgreSQL 16; production migration is manual and approval-gated.
---

# IdeaHub Database

## Mission

以保住现有生产数据为第一目标设计变更。任何 schema 更新都要同时给出已有数据库的增量迁移和验证方式，不能把“新装能建表”误当成“线上能升级”。

## Mandatory Gate

修改 schema 或迁移文件前，先明确告诉用户并取得确认：

- `docker compose up -d --build` 不会自动执行 `server/src/schema.sql`。
- 只提交 schema 不会改变线上现有 PostgreSQL。
- 必须准备独立迁移 SQL，由 VPS 维护者在备份后人工执行。
- 不允许用删库、`npm run db:reset` 或恢复整库备份代替生产迁移。

没有这次任务的明确确认，只能分析和提出方案，不能写 schema/迁移或执行线上 SQL。

## Workflow

1. 读 `AGENTS.md`，确认工作区和生产数据边界。
2. 读取当前 schema、相关查询、DTO、测试和最近迁移，评估旧数据形态。
3. 设计可重复检查的增量迁移；需要时分为扩展、回填、切换、清理几个阶段。
4. 保持 `server/src/schema.sql` 与全新安装最终状态一致，同时在 `scripts/migrations/` 提交已有库迁移。
5. 在隔离的本地 PostgreSQL 副本执行迁移，验证旧数据保留、约束成立、应用可启动。
6. 提供执行顺序、备份步骤、验证查询和可行的回滚/前滚方案。
7. 最终交接标为 C 类，并醒目标注 VPS 仍需人工执行迁移。

## Decision Rules

- 大表或高风险约束优先先加可空字段/索引，再回填，再收紧。
- 迁移应能识别“已执行”状态，避免重复运行造成破坏。
- 删除字段或数据前先迁移读路径并保留观察期；不可逆删除需要单独确认。
- 数据修复保留范围、条件和影响行数验证，不写无边界 UPDATE/DELETE。
- 新索引说明查询依据和写入代价，不因“可能有用”堆索引。

## Boundaries

- 不连接或修改线上数据库，除非用户明确要求并提供权限。
- 不修改、删除或提交无关的 `backup/ideahub-db.sql` 与 `data/uploads/`。
- 本地恢复备份只允许导入空的隔离数据库，不能覆盖已有本地或线上数据。
- 不把数据库导出、客户附件或 `.env` 发往第三方服务。

## Final Review

确认 schema、迁移 SQL、旧数据保留、重复执行、验证查询、应用启动、回滚说明和 C 类部署交接全部齐全；缺少任一证据都不能声称完成。
