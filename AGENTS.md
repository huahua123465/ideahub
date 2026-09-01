# IdeaHub 全局安全与技能路由

> 本文件适用于整个仓库，保留每次任务都必须知道的安全规则。具体开发、验收、数据库、Collector 与发布流程放在 `.agents/skills/`，按任务加载。
> 当前工作模式是 Windows 本地修改并推送，VPS 维护者人工拉取、重建和验证；代码推送不会自动上线。

## 1. 动手前的全局门槛

1. 先运行 `git status --short --branch`，确认当前目录是 Git 工作区且没有来历不明的改动。
2. **修改任何文件前必须运行 `git pull --ff-only origin main`。** VPS 会把备份、附件和服务器端变化自动推到同一仓库，不能假定本地是最新版。同步失败就停止修改并查明原因。
3. 已有的用户改动不覆盖、不丢弃、不替用户提交；需要绕开时明确说明。
4. 先判断任务是否涉及数据库、`.env`、依赖、Docker/Caddy、端口/域名、Collector、生产数据或线上操作，再加载对应 skill。
5. 默认只在本地工作。没有用户明确要求和相应权限，不连接、不修改生产环境。

## 2. 按需技能路由

任务匹配下列范围时，开始修改前完整读取相应 `SKILL.md`；同时跨多个范围就同时使用多个 skill。

| 任务范围 | 必须读取 |
|---|---|
| 页面、导航、弹窗、交互、CSS、响应式、前端 mock/API | `.agents/skills/ideahub-frontend/SKILL.md` |
| 任何 `web/` 界面改动的完成验收 | `.agents/skills/ideahub-ui-qa/SKILL.md` |
| 后端 route/lib、认证、DTO、上传、事件、AI provider | `.agents/skills/ideahub-backend/SKILL.md` |
| 表、字段、索引、约束、迁移、备份恢复 | `.agents/skills/ideahub-database/SKILL.md` |
| 内容采集、Collector 代理、二维码、Cookie、OCR/FFmpeg/Chromium | `.agents/skills/ideahub-collector/SKILL.md` |
| 提交、推送、上传仓库、依赖、部署、VPS、`.env`、Docker/Caddy/端口 | `.agents/skills/ideahub-release/SKILL.md` |

VPS 上工作时还必须完整读取 `CLAUDE.md`。它记录同机邻居服务、共享 Caddy、18080 端口与生产禁止项，skills 不能替代它。

## 3. 始终有效的数据与秘密边界

- `.env`、内部 token、API Key、平台 Cookie 和 storage state 默认不修改、不展示、不复制到聊天或日志，也绝不能进入 `web/`。
- `backup/ideahub-db.sql` 和 `data/uploads/` 是生产快照与真实附件，不是测试素材；没有逐项授权不修改、不删除、不批量整理。
- 不删除 `data/pg/`、Docker volume、数据库或任何生产数据，不用删库重建和 `npm run db:reset` 代替迁移。
- 不把真实配置、数据库导出或客户附件上传到公开仓库、公开链接或第三方服务。含生产秘密的远端仓库必须保持 Private。
- 本地测试使用隔离数据库和单独测试文件，不提交测试产生的数据目录、临时附件、bundle、截图或日志。
- 不执行可能波及同机项目的全局 Docker 清理、批量停止、跨项目 compose 或 `/opt/ai-stack/**` 修改。

## 4. 修改与验证总则

- 只改完成任务所需的源码、测试、文档和配置，不顺手重构无关区域。
- JavaScript 修改至少运行 `node --check`；前端改动必须使用 `ideahub-ui-qa`；后端、数据库和 Collector 使用各自专项门禁。
- `web/dist/` 是生成物，不手工编辑、不提交。生产前端由 `scripts/build-web.mjs` 构建，源码变更需要重建镜像才会线上生效。
- 新增 npm 依赖必须同时更新 `package.json` 与 `package-lock.json`，并按 B 类发布交接。
- 不为了让测试变绿而放宽安全边界、删除有效场景、隐藏 console 错误或自动更新未经确认的视觉基准。
- 不为普通本地验证触碰生产环境。

## 5. 提交与推送保护

1. 提交前查看完整差异并运行 `git diff --check`，确认没有误提交秘密、备份、附件或生成物。
2. 推送前执行 `git fetch origin main` 并获取当前远端分支，确认修改期间是否新增 VPS 自动备份提交。
3. 远端已前进或 push 被拒绝时，安全接入新提交并逐项检查冲突；**严禁 `git push --force`、`--force-with-lease` 或任何远端历史改写。**
4. 不能用本地旧版覆盖 VPS 新产生的 `.env`、`backup/ideahub-db.sql` 或 `data/uploads/`。
5. Collector 功能分支没有通过 `ideahub-collector` 的 VPS/真实平台门禁前，不得合并 main。

## 6. 完成交接

完成任务时使用 `ideahub-release` 的交接格式，说明：

1. 改了什么。
2. 本地验证及未执行项。
3. A/B/C/D 上线类型。
4. VPS 待办或明确写“无”。

只有远端可读取到目标提交时才能说“已上传”。VPS 发布失败时优先保住数据并回滚应用版本，绝不通过删库、删卷或清理全机 Docker 资源排错。
