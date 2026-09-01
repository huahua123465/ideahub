---
name: ideahub-ui-qa
description: IdeaHub 前端与交互验收工作流。凡是修改 web/ 下的 HTML、CSS、JavaScript、页面结构、导航、表单、弹窗、抽屉、响应式布局或异步 UI 状态，完成前都应使用此 skill；用户说“检查界面”“跑一下前端测试”“看看手机端”“有没有回归”时也必须使用。不要用它替代后端、数据库或 Collector 的专项测试。
compatibility: IdeaHub repository; Node.js 20+; esbuild and Puppeteer installed from package-lock.json.
---

# IdeaHub UI QA

## Mission

作为发布前的 UI 验收员，用可重复的证据证明页面真的能工作。不要把“脚本没报错”“桌面看着正常”或“已有一张截图”当成完整验收。

## Success Bar

一次合格验收应覆盖改动对应的源码语法、生产 bundle、核心用户路径、桌面和手机布局、浏览器错误与实际截图，并明确区分已验证、未执行和需要人工判断的部分。

## Workflow

1. 读根目录 `AGENTS.md` 和本次改动差异，确定受影响页面、状态与部署类型。
2. 对改过的 `.js`/`.mjs` 文件运行 `node --check`。
3. 运行 `npm run test:ui`；Windows PowerShell 因执行策略拦截 npm 时使用 `npm.cmd run test:ui`。
4. 查看 `scripts/.uidiff/report.json`，确认 bundle、检查数量、截图和浏览器错误字段，而不是只看退出码。
5. 实际查看受影响页面的桌面与手机截图。通用截图矩阵见 [验收矩阵](references/test-matrix.md)。
6. 有专项脚本时继续运行最接近改动的测试，例如样本库、附件、Collector 或 API 套件；通用 UI QA 不替代业务断言。
7. 若修改 CSS、布局或交互，至少手工复核一张受影响截图；视觉好坏不能完全交给 DOM 断言。
8. 最终列出通过项、未执行项、证据位置和仍需人工确认的风险。

## Decision Rules

- **只改文案**：仍运行通用 UI QA，重点看溢出、按钮尺寸和移动端换行。
- **改 CSS 或结构**：通用 UI QA之外，检查受影响截图和相邻页面，防止全局选择器污染。
- **改异步状态**：增加或运行针对快速切换、失败重试、旧响应覆盖的专项测试。
- **改 API 字段**：通用 UI QA只证明 mock 页面；必须继续运行对应 API/DTO 测试。
- **改样本库**：使用 `npm run test:samples` 或更精确的 stage 脚本。
- **改附件**：使用 `npm run test:idea-files`。
- **改 Collector**：使用 `ideahub-collector` 指定的代理、compose 和 VPS smoke gates。
- **只生成了截图**：截图是人工审美证据，不代表交互、console 或 API 合约通过。

## The Stable UI Contract

`scripts/ui-check.mjs` 应保持以下性质：

- 只使用 package-lock 已安装的 esbuild 与 Puppeteer，不再依赖 Playwright/Sharp。
- 在内存中构建生产 ESM bundle，不改写 Git 跟踪的 `web/index.html`。
- 使用随机本地端口和内置 mock 数据，不连接生产环境或真实数据库。
- 验证核心页面、桌面 1440×900、手机 390×844、页面级横向溢出、关键弹窗；未处理异常或 `console error` 必须失败。
- 将截图和 `report.json` 写入被忽略的 `scripts/.uidiff/`。
- 失败时保留报告和已生成截图，方便定位；退出码必须非零。

## Boundaries

- 不为普通 UI 验收启动或修改生产环境。
- 不读取或上传 `.env`、数据库备份、真实客户附件。
- 不通过放宽断言、屏蔽 console 错误或删除失败场景来“修绿”测试。
- 不自动更新历史视觉基准来掩盖未经确认的视觉变化。
- 不把通用 smoke test 的通过扩大声称为全站所有业务都已验证。

## Common Failure Modes

- 测试导入仓库没有安装的浏览器库，导致入口本身无法运行。
- 使用固定端口，与开发服务冲突或误连到另一个进程。
- 测试修改 `web/index.html` 版本号，使一次验收产生脏工作区。
- 只测 1440px，不测 390px；或只检查 DOM 存在，不检查页面溢出。
- 只看退出码，不检查 console、截图与报告。
- 用过时静态原型逐像素阻塞已经被产品确认的正常演进。

## Final Review

完成前确认：

1. `npm run test:ui` 从干净依赖安装后可直接运行。
2. 测试没有连接生产、写数据库或修改被跟踪文件。
3. `scripts/.uidiff/report.json` 中 `browserErrors` 为空。
4. 受影响页面在桌面和手机均无页面级横向溢出。
5. 至少查看一张与本次改动相关的截图。
6. 专项业务测试已运行，或在交接中明确写出未运行原因。
