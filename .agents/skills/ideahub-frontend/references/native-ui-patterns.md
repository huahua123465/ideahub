# IdeaHub 原生前端模式库

这不是第二套组件系统，也不是要求机械复制的成品模板。它把仓库中已经稳定使用的原生 ES Module、生命周期、状态和 CSS 接线方式压缩成起点，减少新页面各写一套的漂移。

## 先选改动类型

| 类型 | 使用方式 | 不应发生 |
|---|---|---|
| 小修 | 直接沿用相邻视图，只取下文对应的状态或异步片段 | 复制整份新页面模板、改全局 tokens |
| 新页面 | 先完成使用者、唯一任务、内容层级、标志性元素和 token 变化说明，再使用三个 assets 接线 | 把占位内容当最终业务内容 |
| 重设计 | 先保存业务、权限、URL 和状态合同，再用模式库核对没有丢功能 | 用新结构规避旧业务或测试 |

模板位于：

- `assets/new-view-module.js.txt`：视图模块、幂等绑定、状态渲染。
- `assets/new-view-container.html.txt`：一级导航与视图容器接线片段。
- `assets/new-view.css.txt`：页面前缀、现有 tokens、局部滚动和移动断点。
- `assets/page-shell.html.txt`：页面头、筛选区、状态区与主内容语义。
- `assets/accessible-modal.html.txt`：dialog 标题、表单标签、错误区和焦点合同。
- `assets/latest-request.js.txt`：AbortController + 代次校验，确保最新意图获胜。
- `assets/roving-tabs.js.txt`：方向键、Home/End、ARIA 选中与 roving tabindex。
- `assets/responsive-data.css.txt`：桌面宽表与手机卡片的同数据双呈现。
- `assets/view-ui-test.mjs.txt`：复用项目 UI harness 的桌面/手机专项测试起点。

复制后必须替换全部 `__PLACEHOLDER__`，删除未使用能力，并按真实 API 与相邻页面调整。不要直接把 assets 引入生产 bundle。

## 视图模块合同

IdeaHub 视图通常从 `web/src/views/*.js` 导出 `render`，跨模块导航通过 `EventTarget` 传意图，由 `main.js` 决定去哪里。通用能力从 `api.js`、`util.js`、`icons.js` 和现有视图复用。

新模块至少要决定：

1. 根节点是已有一级视图还是二级详情视图。
2. 哪些状态属于本页，离开后哪些请求或计时器必须失效。
3. 事件绑定是否只执行一次。
4. 加载、空、错误、无权限和成功各画什么。
5. 用户输入经 `esc()` 进入模板，还是用 `textContent` 写入。
6. API 与 `mock.js` 是否使用同一 DTO 字段和错误语义。

## 最新请求获胜

筛选、搜索、详情切换和 PDF/媒体打开不能让较慢的旧响应覆盖新选择。无法取消底层请求时使用递增代次：

```js
let renderGeneration = 0;

export async function render(params) {
  const own = ++renderGeneration;
  paintLoading();
  try {
    const data = await api.someList(params);
    if (own !== renderGeneration) return;
    paintData(data);
  } catch (error) {
    if (own !== renderGeneration) return;
    paintError(error);
  }
}

export function leave() {
  renderGeneration += 1;
}
```

底层支持 `AbortSignal` 时可以再加 `AbortController`，但仍需校验当前目标 ID。取消属于正常切换，不显示成失败 toast。

## 幂等事件与局部更新

视图反复进入时不要重复 `addEventListener`。使用模块级 `bound` 或把稳定事件绑定放在应用启动处：

```js
let bound = false;

function bindOnce(root) {
  if (bound) return;
  bound = true;
  root.addEventListener('click', event => {
    const action = event.target.closest('[data-example-action]');
    if (!action) return;
    events.dispatchEvent(new CustomEvent('open', { detail: { id: action.dataset.id } }));
  });
}
```

整块重绘只适合没有输入、选择或滚动状态的区域。表单提交、抽屉编辑和长列表优先保留用户正在操作的局部状态。

## 状态语言

- 加载态说明正在读取什么，不让旧内容继续冒充新结果。
- 空状态说明为什么为空，并给一个当前用户有权限执行的下一步。
- 错误态保留输入，使用可执行的恢复动作；401 继续交给统一 API 层处理。
- 按钮写“保存更改”，进行中写“正在保存…”，成功反馈写“已保存”，不要在同一流程换成“提交/处理完成”。
- AI 生成内容保持辅助性质，保存或覆盖人工资料前必须有明确确认。

## CSS 接线

- 页面根使用唯一前缀，例如 `.research-page`、`.research-card`，不要新增无范围的 `.header`、`.section`、`.card` 覆盖。
- 从 `var(--surface)`、`var(--ink)`、`var(--line)`、`var(--radius)`、`var(--r-sm)`、`var(--r-lg)` 等现有 tokens 派生。
- 页面根和 Grid/Flex 子项设置 `min-width: 0`；真正需要宽度的表格或媒体放进局部 `overflow:auto` 容器。
- 先按内容决定断点，再优先复用 1180、700、560px。390×844 是常规手机验收，不是唯一需要成立的宽度。
- 动效从 `motion.css` 取时长和缓动，并提供 `prefers-reduced-motion` 路径。

## 新一级视图接线清单

1. `web/index.html` 同时增加 `#tab-__VIEW__` 与 `#v-__VIEW__`，文案使用真实业务名。
2. `web/src/main.js` 增加 import、`CHROME`、`VIEWS`、`go()` 渲染分支和权限可见性。
3. `web/src/views/__VIEW__.js` 只持有本页状态，并对重复进入保持幂等。
4. `web/src/api.js`、服务端 DTO 与 `web/src/mock.js` 同步字段。
5. `web/styles.css` 使用页面前缀；检查 `soft.css` 的后加载覆盖。
6. `scripts/ui-check.mjs` 或专项 UI 测试覆盖入口、核心动作、桌面、390px、console 和错误状态。

完成后搜索所有 `__PLACEHOLDER__`，结果必须为空；再运行构建与 `ideahub-ui-qa`。

## 权限与弹窗

无权限不能伪装成空数据。页面要区分没有记录、仍在加载、读取失败和当前角色不可操作；隐藏按钮之外，服务端仍需执行权限校验。

使用 `accessible-modal.html.txt` 时，把打开/关闭接入项目已有遮罩与最上层 dialog 规则。静态 `role="dialog"` 只是起点，必须验证初始焦点、Tab 环、Escape 和焦点归还；确认层叠在普通 modal 上时，确认层拥有焦点优先级。

## 宽数据与 tabs

宽表不是简单加 `overflow-x:auto` 就结束。桌面保留可扫描的列关系，手机用卡片重排相同字段；两种表现必须来自同一份数据和状态，不能各维护一套业务判断。tabs 使用 `roving-tabs.js.txt` 起步，并让 tab、panel 的 ID 与 `aria-controls`/`aria-labelledby` 一一对应。

## 专项验收模板

`view-ui-test.mjs.txt` 只提供生命周期、隔离和证据框架。复制后补齐真实导航动作、业务就绪条件、错误/权限状态和关键交互；不能只保留溢出断言。输出必须留在 `scripts/.uidiff/` 的自有子目录，测试不得接受任意删除路径。
