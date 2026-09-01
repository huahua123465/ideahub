# IdeaHub 前端架构

## 技术边界

- 页面使用原生 HTML、CSS 与 ES Module，Node.js 20+。
- `web/index.html` 是应用壳和一级视图容器。
- `web/src/main.js` 负责启动、全局导航、模块装配和实时事件协调。
- `web/src/views/*.js` 负责各业务视图；通用能力位于 `web/src/api.js`、`mock.js`、`util.js`、`icons.js`、`motion.js` 等文件。
- 生产构建使用 `scripts/build-web.mjs` 与 esbuild，输出到被忽略的 `web/dist/`。
- 浏览器回归使用 Puppeteer；不要再引入 Playwright 形成第二套浏览器运行时。

## 页面接入路径

新增一级视图时，通常需要同时核对：

1. `web/index.html` 中的导航按钮 `#tab-*` 和视图容器 `#v-*`。
2. `web/src/main.js` 中的模块 import、`CHROME`、`VIEWS`、`go()` 与按需渲染分支。
3. 对应的 `web/src/views/<name>.js`。
4. 真实接口与 `web/src/mock.js` 的一致字段和错误语义。
5. `web/styles.css` 中带页面前缀的样式与移动端规则。
6. `scripts/ui-check.mjs` 或对应专项 UI 测试中的核心路径覆盖。

二级详情页不一定需要新的导航按钮。延续 `clientDetail` 这类模式时，要明确返回路径和一级导航高亮归属。

## 视图模块约定

- 模块只持有自身页面状态，不把全站状态复制一份。
- `render`/`refresh`/`leave` 等生命周期沿用相邻模块的语义。
- 事件绑定应幂等，避免每次进入页面重复绑定。
- 切换页面后不应让已离开的轮询、定时器或旧请求继续覆盖当前 UI。
- 服务端事件是“需要刷新”的信号，真实数据仍从 API 读取，不直接信任事件体绘制完整记录。

## API 与 mock

- 本地 `?mock=1` 用于界面和交互验收；它必须复用生产 DTO 字段和权限差异。
- 新增请求时同时检查 `web/src/api.js`、`web/src/mock.js` 和服务端路由。
- 失败状态应保留用户输入，并提供可执行的下一步。
- 快速切换、搜索或重复提交使用请求序号、目标 ID 或 AbortController 防止旧响应覆盖。
- mock 只允许本地主机启用，不能让 URL 参数在非本地域名上强制演示模式。

## 构建与生成物

- 编辑 `web/src/`、`web/*.css` 和 `web/*.html`，不要编辑 `web/dist/app.js`。
- `node scripts/build-web.mjs` 会构建 bundle、更新 `web/index.html` 的 cache-busting 版本，并同步少量公开资源。
- `node scripts/build-web.mjs --dev` 切回源码模块模式。
- `web/dist/`、`scripts/.uidiff/` 和临时截图不进入 Git。
