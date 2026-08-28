# 创作者内容采集台技术手册

> 文档版本：1.0.0  
> 基线日期：2026-08-26  
> 适用对象：开发、测试、运维、数据、AI 集成与技术支持人员  
> 内容源：当前工作区代码、配置、数据库定义与自动化测试

## 1. 文档目的与使用方式

本手册说明“创作者内容采集台”的安装、配置、运行、架构、接口、数据、测试、排障和维护方法。目标是让未参与原始开发的技术人员能够在不依赖口头交接的情况下完成以下工作：

- 在 Windows、macOS 或 Linux 环境准备运行条件并启动系统。
- 判断采集、OCR、视频模型、评论、AI 分析和 IdeaHub 推送分别处于什么状态。
- 安全地维护环境变量、登录态、SQLite 数据库与任务文件。
- 通过 API、模块和测试定位问题，进行可回滚的变更。
- 在代码结构、接口或配置发生变化后，按统一流程持续更新本手册。

本文以 Flask Web 应用 `app.py` 为当前正式入口。仓库中的 `main.py` 是早期“视频转分镜”命令行入口，仍引用已经移除或改名的 `extract_frames`、`describe_frames`、`create_characters` 和 `generate`，当前不能作为生产入口使用；在完成兼容改造和测试前不要纳入运行手册。

## 2. 系统概览

系统接收抖音、小红书等平台的分享链接或分享文案，规范化链接后创建任务，采集公开页面、账号、媒体元数据和评论，对图片或视频执行 OCR，并生成面向业务人员的 AI 分析及面向技术人员的独立审计文件。结果可在网页查看，也可导出 JSON、Markdown 或文本，并可选择推送到 IdeaHub。

### 2.1 当前能力边界

- 当前 Web 产品固定使用“采集分析”模式：`COLLECTION_MODE=analyze`。
- 当前内容结构版本为 `CONTENT_SCHEMA_VERSION=16`。
- 最大同时执行 3 个高成本采集任务；相同内容会合并为同一任务。
- 图文原图保存在任务目录；视频只在工作目录中临时处理，完成后删除，结果保留来源链接、规格和识别文本。
- AI 视频分析与评论分析独立降级；任一部分失败不会删除原始采集结果。
- 评论分析只接收模型返回的评论 ID，展示原话由后端从已采集数据回填。
- 技术审计下载只允许服务器本机请求。
- 小红书页面和评论采集可能需要有效登录态；平台页面或接口变化会影响可用性。

### 2.2 逻辑架构

```text
浏览器 / API 调用方
        |
        v
Flask Web 层（app.py + templates/index.html）
        |
        +--> 任务协调：去重、并发槽位、状态轮询、刷新、删除
        |
        +--> 采集层（media/）
        |      +--> 页面解析 / Playwright
        |      +--> yt-dlp 媒体元数据与临时下载
        |      +--> OCR / 封面标题 / 视频逐段文字
        |      +--> 账号信息 / 评论与回复
        |
        +--> AI 分析层（generators/business_analyzer.py）
        |      +--> 内容分析
        |      +--> 评论需求分析
        |      +--> 技术审计
        |
        +--> 持久化层
        |      +--> SQLite：data/pipeline.db
        |      +--> 任务文件：output/<task_id>/
        |
        +--> 外部集成：IdeaHub
```

### 2.3 端到端数据流

1. `POST /api/convert` 接收 `url`，从分享文案中提取 URL，并解析小红书短链接。
2. `canonical_content_key()` 生成稳定内容标识；小红书 PC 与移动分享链接可复用同一任务。
3. 系统检查缓存、当前运行任务和并发槽位，然后以后台线程启动采集。
4. 视频路径先读取媒体元数据和页面内容，再临时下载视频；优先调用原生视频模型逐段识别，失败时退回本地抽帧 OCR。
5. 图文路径解析正文和原图地址，下载原图并执行 OCR。
6. 系统补充账号资料，采集达到阈值的高赞评论及回复，并记录覆盖度和置信度。
7. AI 模块分别生成内容分析和评论需求分析，同时生成技术审计 JSON/Markdown。
8. 结果以原子写入方式保存为 `content.json`、`content.txt` 和审计文件；任务状态变为 `done`。
9. 浏览器通过状态和结果接口展示内容，并提供导出、刷新、IdeaHub 推送和删除操作。

## 3. 技术栈与运行依赖

| 类别 | 技术/组件 | 用途 |
|---|---|---|
| 语言 | Python 3.11 | 后端、采集、处理、测试 |
| Web | Flask 3.x | 页面与 REST API |
| 页面自动化 | Playwright + Chromium | 动态页面、登录、评论和账号信息采集 |
| HTTP | httpx | 短链接解析、页面/API 访问、IdeaHub 与视频模型请求 |
| 媒体下载 | yt-dlp | 视频元数据、视频与封面获取 |
| 媒体处理 | FFmpeg / ffprobe | 视频分段、压缩、音频、时长和抽帧 |
| OCR | RapidOCR ONNX Runtime、OpenCV、Pillow | 图像文字、封面标题和视频画面文字 |
| AI SDK | OpenAI Python SDK | OpenAI 兼容文本、视觉和语音接口 |
| 数据 | SQLite（WAL） | 任务、产物、脚本版本和角色记录 |
| 前端 | 单页 HTML/CSS/JavaScript | 提交、轮询、结果、历史、登录和导出 |
| 测试 | Python `unittest` | 80 个当前基线测试 |

系统还依赖网络可访问目标平台和已配置的 AI/集成服务。平台登录、反爬策略、Cookie、地区网络、代理和第三方限流都可能改变运行结果。

## 4. 目录与模块职责

```text
dataClean-main/
  app.py                         Flask 正式入口、任务协调、API、结果与生命周期
  config.py                      环境变量、路径、模型和采集阈值
  db.py                          SQLite 数据访问层
  utils.py                       URL 规范化、内容 ID、文件名和平台识别
  requirements.txt               Python 运行依赖
  .env.example                   部分环境变量示例；完整清单以 config.py 为准
  templates/index.html           Web 单页界面
  media/                         下载、页面、账号、评论、OCR、媒体与登录
  generators/business_analyzer.py 业务分析和技术审计
  generators/script_generator.py  旧内容改写能力，当前 Web 主流程未调用
  tests/                         单元和接口测试
  data/                          SQLite、Cookie、Playwright 登录态（敏感）
  output/<task_id>/              每个任务的结果和保留素材
  docs/                          技术文档
  tools/                         文档构建与一致性检查工具
```

### 4.1 核心模块

| 模块 | 主要职责 | 维护注意 |
|---|---|---|
| `app.py` | Web 路由、3 槽位并发、任务去重、采集管线、刷新、导出、推送、删除 | 修改 API、状态、内容结构或文件生命周期时必须同步测试和手册 |
| `config.py` | 从 `.env` 读取模型、路径和阈值 | 新增变量时同步 `.env.example`、手册和快照 |
| `db.py` | 初始化 SQLite、WAL、事务和 CRUD | 表结构变更需要迁移策略，不能只修改新建库脚本 |
| `utils.py` | 分享文本解析、短链、内容键和平台识别 | URL 规则影响缓存复用和任务 ID |
| `media/content_extractor.py` | 页面提取、正文/话题/互动解析、去重 | 平台 HTML 变化的高风险点 |
| `media/downloader.py` | yt-dlp 元数据、临时视频、封面 | 依赖 FFmpeg、Cookie 与平台兼容性 |
| `media/video_transcriber.py` | 视频切片、压缩、视频模型请求和字幕合并 | 视频按重叠片段发送到外部服务，需关注成本与隐私 |
| `media/text_ocr.py` | 图片/视频 OCR、封面标题识别 | OCR 阈值变更需保留回归测试 |
| `media/profile_extractor.py` | 账号结构化状态、HTTP 和浏览器回退 | 不得推算平台未返回指标 |
| `media/comment_extractor.py` | 评论/回复规范化、阈值、覆盖和置信度 | 平台接口变化与登录态最易导致部分结果 |
| `media/platform_login.py` | 小红书可视化扫码登录和状态保存 | 登录态文件属于密钥级敏感数据 |
| `generators/business_analyzer.py` | 固定栏目 AI 分析、证据回填、技术审计 | 不允许模型生成伪造评论原话或隐藏推理链 |

## 5. 安装与启动

### 5.1 前置条件

- Python 3.11。当前项目基线在 Python 3.11.15 上验证。
- FFmpeg 与 ffprobe 已安装并可从 `PATH` 调用。
- 可访问目标平台、模型服务和可选的 IdeaHub。
- Chromium 浏览器运行依赖；通过 Playwright 安装。
- 建议至少 8 GB 内存和足够的临时磁盘空间。视频任务并发时需求会明显增加。

### 5.2 Windows / PowerShell

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
python -m playwright install chromium
Copy-Item .env.example .env
ffmpeg -version
ffprobe -version
python app.py
```

打开 `http://127.0.0.1:5000`。程序实际监听 `0.0.0.0:5000`，因此同网段访问前应配置防火墙、访问控制和反向代理。

### 5.3 macOS / Linux

```bash
python3.11 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
python -m playwright install chromium
cp .env.example .env
ffmpeg -version
ffprobe -version
python app.py
```

FFmpeg 的安装方式由操作系统包管理器决定。无图形桌面的服务器无法完成小红书可视化扫码登录；应预先导入受控登录态，或在具备桌面环境的受信任主机上运行登录流程。

### 5.4 启动后健康检查

```powershell
Invoke-RestMethod http://127.0.0.1:5000/api/history
Invoke-RestMethod http://127.0.0.1:5000/api/login/xiaohongshu/status
Invoke-RestMethod http://127.0.0.1:5000/api/ideahub/status
```

检查项：

- 首页返回 200，浏览器能加载样式和脚本。
- `/api/history` 返回 JSON 数组。
- 登录状态接口只返回状态和是否已保存，不返回 Cookie 内容。
- IdeaHub 状态只返回是否已配置、文档地址和允许的通道，不返回密钥。
- `data/pipeline.db` 可创建，`output/` 可写。

### 5.5 生产部署说明

当前 `app.py` 使用 Flask 内置服务器并关闭 debug，适合本机或受控内网使用，不是完整的公网生产部署方案。生产化至少需要：

- 选择并加入 WSGI 服务器（Windows 常用 Waitress，Linux 常用 Gunicorn）。
- 在前端设置 Nginx、Caddy 或等效反向代理，并限制来源、请求体和超时。
- 仅允许受信任用户访问登录、导出、刷新、推送和删除接口。
- 将 Cookie、数据库、结果目录和日志放在受控磁盘，设置备份和保留期。
- 评估多进程部署：当前 `_running`、信号量和登录状态都在单进程内存中，多进程会导致状态不共享；要横向扩展必须先引入共享任务队列和共享状态存储。

## 6. 配置管理

`config.py` 是完整配置事实源。`.env.example` 当前只列出视频模型和 IdeaHub 相关变量，技术人员在初始化环境时还应按本节补充文本模型、Whisper 和采集阈值。所有密钥仅放在服务器环境或 `.env`，不得写入 HTML、日志、文档或版本库。

### 6.1 文本、视觉与语音模型

| 变量 | 默认值 | 说明 |
|---|---|---|
| `OPENAI_API_KEY` | 空 | OpenAI/兼容服务密钥；也可作为文本模型回退 |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | OpenAI 兼容基础地址 |
| `MODEL_VLM` | `gpt-4o` | 旧视觉处理模块模型 |
| `DEEPSEEK_API_KEY` | 空 | 设置后优先作为文本分析密钥 |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | DeepSeek 基础地址 |
| `DEEPSEEK_MODEL` | `deepseek-v4-flash` | DeepSeek 文本模型 |
| `MODEL_LLM` | `gpt-4o` | 未配置 DeepSeek 时的文本模型 |
| `OPENAI_WHISPER_KEY` | 继承 `OPENAI_API_KEY` | Whisper 密钥 |
| `OPENAI_WHISPER_URL` | `https://api.openai.com/v1` | Whisper 基础地址 |
| `MODEL_WHISPER` | `whisper-1` | Whisper 模型 |

文本业务分析优先使用 DeepSeek 配置；若未设置 `DEEPSEEK_API_KEY`，则使用 OpenAI 配置。没有文本模型密钥时，原始采集仍可完成，但 AI 分析状态会降级为 `unavailable`。

### 6.2 原生视频模型

| 变量 | 默认值 | 说明 |
|---|---|---|
| `VIDEO_MODEL_PROVIDER` | `moxus` | 首选 `moxus` 或 `openrouter` |
| `MOXUS_API_KEY` | 空 | Moxus 密钥 |
| `MOXUS_BASE_URL` | `https://moxus.ai` | Moxus 地址 |
| `MOXUS_VIDEO_MODEL` | `gemini-3.6-flash` | Moxus 视频模型 |
| `OPENROUTER_API_KEY` | 空 | OpenRouter 密钥 |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | OpenRouter 地址 |
| `OPENROUTER_VIDEO_MODEL` | `stealth/ox-alpha` | OpenRouter 视频模型 |
| `VIDEO_MODEL_CHUNK_SECONDS` | `60` | 单片段秒数 |
| `VIDEO_MODEL_CHUNK_OVERLAP` | `2` | 片段重叠秒数 |
| `VIDEO_MODEL_FPS` | `4` | 发送视频帧率 |
| `VIDEO_MODEL_WIDTH` | `720` | 压缩宽度 |
| `VIDEO_MODEL_MAX_CHUNKS` | `20` | 最大片段数 |
| `VIDEO_MODEL_REQUEST_RETRIES` | `3` | 单片段请求重试数 |

服务会在已配置密钥中选择首选提供商；首选没有密钥时尝试另一个。都未配置时不会发送视频，并回退到本地抽帧 OCR。

### 6.3 采集与评论阈值

| 变量 | 默认值 | 说明 |
|---|---|---|
| `FRAME_INTERVAL` | `5` | 旧帧处理间隔，秒 |
| `MAX_FRAMES` | `20` | 旧帧处理最大数量 |
| `MAX_VIDEO_DURATION` | `600` | 旧视频时长上限，秒 |
| `COMMENT_LIKE_THRESHOLD` | `20` | 高赞评论最低点赞数 |
| `COMMENT_TOP_K` | `5` | 目标高赞评论数量 |
| `COMMENT_MAX_PRIMARY_PAGES` | `8` | 主评论最大翻页数 |
| `COMMENT_MAX_REPLY_THREADS` | `24` | 最大回复线程数 |
| `COMMENT_MAX_REPLY_PAGES` | `3` | 单回复线程最大页数 |
| `COMMENT_MAX_SCANNED` | `320` | 最大扫描评论数 |
| `COMMENT_TIMEOUT_SEC` | `50` | 评论采集超时秒数 |
| `COMMENT_MIN_CONFIDENCE_SCANNED` | `80` | 置信度评估最低扫描量 |
| `COMMENT_TARGET_CONFIDENCE` | `0.80` | 目标置信度 |

阈值变更会改变成本、时延和结果覆盖，不应只改配置；必须记录变更理由，执行评论相关回归测试，并在发布说明中说明结果口径变化。

### 6.4 IdeaHub

| 变量 | 默认值 | 说明 |
|---|---|---|
| `IDEAHUB_API_KEY` | 空 | 服务端 Bearer 密钥 |
| `IDEAHUB_INGEST_URL` | 项目默认地址 | 分析接收接口 |
| `IDEAHUB_DOC_URL` | 项目默认地址 | 对接说明页 |

单任务 JSON 上限为 8 MB；封面内嵌数据上限为 3 MB。通道必须显式为 `persona`、`matrix` 或 `persona,matrix`。

### 6.5 最小 `.env` 示例

```dotenv
# 文本分析，二选一或按兼容服务设置
DEEPSEEK_API_KEY=replace-me
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-flash

# 视频逐段识别；不配置时使用本地 OCR 回退
VIDEO_MODEL_PROVIDER=moxus
MOXUS_API_KEY=replace-me
MOXUS_BASE_URL=https://moxus.ai
MOXUS_VIDEO_MODEL=gemini-3.6-flash

# 可选集成
IDEAHUB_API_KEY=replace-me
```

不要把真实密钥复制到问题单、聊天、截图或技术手册。轮换密钥时先更新运行环境，再验证状态和一条最小任务，最后吊销旧密钥。

## 7. 任务运行与操作 SOP

### 7.1 提交任务

1. 打开首页并粘贴平台 URL 或带 URL 的分享文案。
2. 后端解析短链并计算内容 ID。
3. 如果同一内容的当前结构版本结果有效，接口直接返回缓存。
4. 如果同一任务已在排队或运行，接口返回 `coalesced=true`，不会启动重复工作。
5. 新任务进入后台线程；浏览器约每 1.8 秒轮询状态。

```powershell
$body = @{ url = 'https://example.com/post' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:5000/api/convert `
  -ContentType 'application/json' -Body $body
```

### 7.2 状态判断

| 状态 | 含义 | 建议动作 |
|---|---|---|
| `pending` | 已登记，等待并发槽位 | 继续轮询，不要重复提交 |
| `running` | 正在采集或分析 | 查看 `progress` 与 `message` |
| `done` | 文件和数据库状态已完成 | 调用结果或导出接口 |
| `failed` | 管线失败，数据库记录错误信息 | 查看服务端异常与 `error_msg`，修复后重新提交 |
| `unknown` | 任务不存在于内存和数据库 | 检查任务 ID、数据库或是否已删除 |

### 7.3 小红书登录

- `POST /api/login/xiaohongshu` 启动可见 Chromium 窗口。
- `force_fresh=true` 或 `mode=switch` 用于切换账号。
- 前端轮询 `/api/login/xiaohongshu/status`。
- 登录态保存在 `data/` 下的 Cookie 或 storage state 文件，等同凭据管理。
- 如果评论采集返回 `login_required`，系统会使旧登录态失效并提示重新扫码。

### 7.4 手动更新

`POST /api/task/<task_id>/refresh` 只允许已完成且存在 `content.json` 的任务。刷新沿用原历史记录，并使用临时目录收集新结果；成功时原子替换旧目录，失败时恢复旧结果。更新请求在 3 个并发槽位均占用时返回 429。

### 7.5 导出与技术审计

- 业务导出：`GET /api/export/<task_id>/json|md|txt`。
- 兼容下载：`GET /api/download/<task_id>`，等同 TXT 导出。
- 技术审计：`GET /api/technical-audit/<task_id>/json|md`，只允许本机。
- 图片：`GET /api/image/<task_id>/<filename>`。
- 媒体：`GET /api/media/<task_id>/<filename>`，仅允许列出的媒体扩展名。

### 7.6 IdeaHub 推送

推送接口读取已保存的 `content.json` 原始字节，不在浏览器端拼接密钥，也不向前端返回上游完整响应。批量推送最多 50 条；单条失败会保留在批量结果中，便于单独重试。

### 7.7 删除

删除前会校验所有任务；只要其中一个正在运行，整个批次都不会开始。文件先移动到批次暂存目录，再在同一数据库事务中删除记录；数据库删除失败时恢复全部目录。成功后暂存目录被永久删除，任务文件不可从系统内恢复，因此操作前应确认备份。

## 8. API 参考

| 方法 | 路径 | 作用 | 常见状态 |
|---|---|---|---|
| GET | `/` | Web 首页 | 200 |
| POST | `/api/login/xiaohongshu` | 启动登录或切换账号 | 200, 409 |
| GET | `/api/login/xiaohongshu/status` | 登录状态 | 200 |
| POST | `/api/convert` | 提交或复用任务 | 200, 400 |
| GET | `/api/status/<vid>` | 查询任务进度 | 200 |
| POST | `/api/task/<vid>/refresh` | 刷新已完成任务 | 200, 400, 404, 409, 429 |
| GET | `/api/result/<vid>` | 获取结构化结果 | 200, 404, 409 |
| GET | `/api/image/<vid>/<filename>` | 查看/下载图片 | 200, 404 |
| GET | `/api/media/<vid>/<filename>` | 查看/下载允许的媒体 | 200, 400, 404 |
| GET | `/api/download/<vid>` | 下载 TXT | 200, 404, 500 |
| GET | `/api/export/<vid>/<format>` | 导出 JSON/MD/TXT | 200, 400, 404, 500 |
| GET | `/api/technical-audit/<vid>/<format>` | 本机下载技术审计 | 200, 400, 403, 404 |
| GET | `/api/ideahub/status` | 集成状态与通道 | 200 |
| POST | `/api/ideahub/push/<vid>` | 单任务推送 | 200, 400, 404, 413, 502, 503 |
| POST | `/api/ideahub/push-batch` | 最多 50 条批量推送 | 200, 400, 503 |
| GET | `/api/history` | 最近 50 条任务 | 200 |
| DELETE | `/api/task/<vid>` | 删除单任务 | 200, 400, 404, 409, 500 |
| POST | `/api/tasks/batch-delete` | 最多 50 条批量删除 | 200, 400, 404, 409, 500 |

### 8.1 主要请求示例

```json
POST /api/convert
{"url":"平台分享链接或含链接的分享文案"}
```

```json
POST /api/ideahub/push/<vid>
{"channel":"persona"}
```

```json
POST /api/tasks/batch-delete
{"task_ids":["id-1","id-2"]}
```

API 当前没有身份认证或 CSRF 防护。不要直接暴露到不受信任网络；生产接入必须在反向代理或应用层增加认证、授权、速率限制和审计。

## 9. 数据模型与文件规范

### 9.1 SQLite

数据库默认位于 `data/pipeline.db`，连接启用 WAL 和外键约束。

| 表 | 主键/关联 | 用途 |
|---|---|---|
| `tasks` | `id` | URL、来源、标题、账号、状态、错误和时间 |
| `artifacts` | 自增 `id`，外键 `task_id` | 产物类型、路径和 JSON 元数据 |
| `scripts` | 自增 `id`，外键 `task_id` | 旧分镜脚本版本与文件路径 |
| `characters` | 自增 `id`，唯一 `(task_id,char_id)` | 旧分镜角色信息 |

`account_name` 通过启动时列检查追加，属于轻量历史迁移。后续复杂迁移应增加明确的版本表和可重复迁移脚本，不要依赖多条临时 `ALTER TABLE`。

### 9.2 任务目录

```text
output/<task_id>/
  content.json                   结构化主结果
  content.txt                    人类可读文本导出缓存
  ai_analysis.technical.json     技术审计结构化文件
  ai_analysis.technical.md       技术审计阅读版
  comments.last_good.json        最近一次成功/部分成功评论结果
  video_ocr.txt                  视频文字识别结果（视频任务可选）
  images/                        图文原图和 OCR 证据
```

运行期间可能出现 `_working_media`、`.refresh-<id>`、`.refresh-backup-<id>` 或 `.delete-batch-<uuid>`。正常完成会清理；异常终止后可先停止服务、核对路径位于 `output/` 内，再按恢复规则处理，禁止对不确定路径执行递归删除。

### 9.3 `content.json` 关键字段

| 字段 | 说明 |
|---|---|
| `schema_version` | 当前为 16；消费者应按版本兼容 |
| `task_id`, `source_url`, `platform` | 任务和来源身份 |
| `collection_mode`, `storage` | 采集口径与素材保留策略 |
| `media_type`, `media_assets` | 视频或图文及媒体规格 |
| `post_title`, `post_description`, `display_title` | 平台标题、描述和展示标题 |
| `account`, `collection_status` | 账号数据与完整性状态 |
| `engagement`, `topics` | 公开互动与话题 |
| `video_text`, `video_text_meta`, `images` | OCR、视频模型与图片证据 |
| `comments`, `comment_summary` | 评论、回复、覆盖与置信度 |
| `ai_analysis` | 面向业务人员的固定结构分析 |

对外消费者不要依赖未记录的临时字段。更改字段名称、含义或存储策略时提升 `CONTENT_SCHEMA_VERSION`，提供兼容读取或迁移，并更新接口测试和本手册。

## 10. 并发、一致性与故障恢复

### 10.1 并发模型

- 每个任务由 daemon 后台线程执行。
- `BoundedSemaphore(3)` 限制高成本管线并发。
- `_task_state_lock` 防止同一进程内同时为同一内容启动多个工作线程。
- `_running`、`_login_state` 和信号量都是进程内状态，重启后不会保留。
- SQLite 每次操作使用独立连接和 WAL，支持当前轻量并发，但不是分布式任务数据库。

### 10.2 原子性设计

- 结果文本通过“写临时文件后替换”保存。
- 手动刷新先在临时任务目录完成，再交换正式目录；失败恢复旧目录。
- 批量删除先预检，再移动文件，后删数据库；数据库失败则恢复文件。
- 评论刷新失败且新结果为空时，保留 `comments.last_good.json` 的上次有效结果。

### 10.3 服务重启后的处理

1. 查询数据库中非 `done`/`failed` 的任务。
2. 检查 `output/` 是否有残留工作、刷新、备份或删除暂存目录。
3. 不要只根据目录名删除；先将目录与数据库任务、时间和正式结果核对。
4. 确认没有另一个实例在运行后，再恢复备份或移动到隔离目录。
5. 重新提交失败任务；当前系统不会自动恢复中断线程。

## 11. 测试与质量门禁

当前测试基线：Python 3.11.15，`unittest` 共 80 项，2026-08-26 全部通过。测试中故意触发的失败管线和数据库异常会写 ERROR 日志，但相应断言验证了旧结果/文件可以恢复，不代表测试失败。

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
```

当前虚拟环境未安装 pytest，因此通用命令应使用标准库 `unittest`。如团队决定引入 pytest，应将其加入开发依赖并同步 CI，而不是依赖个人全局环境。

### 11.1 测试覆盖主题

- URL/短链解析、稳定内容 ID 和平台识别。
- 页面标题、正文、话题、互动数据与重复文本处理。
- 视频元数据重试、视频信号和临时素材策略。
- OCR 封面标题、多行标题和低置信度修正。
- 视频分片、重叠去重、模型 JSON 和缺失密钥降级。
- 账号结构化状态、合并和浏览器回退。
- 评论阈值、回复、游标、置信度、登录 Cookie 和上次有效结果。
- AI 固定栏目、评论证据 ID、部分失败和技术审计分离。
- 任务缓存、刷新、旧结果回填和结果 API。
- JSON/Markdown/TXT 导出。
- IdeaHub 密钥隔离、通道、大小限制、批量部分失败。
- SQLite 状态恢复和批量删除事务回滚。

### 11.2 变更最低验证矩阵

| 变更类型 | 最低验证 |
|---|---|
| 页面/平台采集 | 相关单元测试 + 每个平台一条受控样例 |
| API/前端 | 全量测试 + 浏览器提交、轮询、结果、历史和错误态 |
| 内容结构 | 提升版本 + 结果/导出/旧数据回填测试 |
| 数据库 | 临时新库 + 历史库副本迁移 + 回滚验证 |
| AI 提示/模型 | 固定结构、证据 ID、缺密钥和服务失败测试 |
| 删除/刷新 | 成功、运行中阻止、磁盘/数据库失败恢复 |
| 配置/依赖 | 全新虚拟环境安装 + 启动健康检查 |

## 12. 日志、监控与容量

当前主要日志来自 Flask 和各处理模块的标准输出/错误输出，仓库内没有统一结构化日志、轮转或指标系统。生产前建议补充：

- 请求 ID、任务 ID、阶段、耗时、状态和错误类别。
- 队列等待时间、运行中任务数、各阶段成功率和第三方请求时延。
- `data/`、`output/` 和临时磁盘使用量。
- AI/平台请求次数、限流、超时和成本。
- 登录态失效、评论覆盖不足、OCR 回退和部分分析状态。
- 日志脱敏规则：不得记录 API Key、Cookie、Authorization、视频 base64 或完整第三方响应。

容量规划以“最大 3 个并发视频任务”为最坏场景。估算临时磁盘时至少覆盖 3 份原视频、压缩分片、封面、OCR 临时文件和最终输出。更改并发数前应先压测 CPU、内存、磁盘和第三方限流。

## 13. 安全与合规

### 13.1 已有保护

- `.env`、Cookie、storage state、`output/` 和虚拟环境已列入 `.gitignore`。
- IdeaHub 密钥仅由服务端读取，浏览器状态接口不返回密钥。
- 技术审计限制为本机下载。
- 任务 ID 和任务目录进行格式与父目录检查。
- 媒体接口使用扩展名允许列表。
- 刷新和删除使用受控临时目录与回滚。
- AI 评论证据由后端按评论 ID 回填，模型不能改写原话。

### 13.2 必须补强的部署边界

- 当前 API 无身份认证、授权和 CSRF 防护。
- Flask 内置服务器不应直接面对公网。
- `data/` 包含可复用登录态，应限制操作系统权限并加密备份。
- `output/` 可能包含用户内容、评论和原图，应定义访问、保留、删除和审计策略。
- 视频会分片发送到配置的外部模型服务；上线前确认用户授权、数据地域、服务条款和保留政策。
- 采集行为必须遵守适用法律、平台规则和组织政策；只处理已获授权或合法公开的数据。

## 14. 常见故障排查

### 14.1 页面无法提取或评论为空

1. 确认分享链接可在正常浏览器打开且未失效。
2. 检查是否为小红书短链，确认解析后仍为受支持域名。
3. 查看登录状态；必要时切换账号并重新扫码。
4. 检查 Playwright Chromium 是否安装。
5. 查看平台是否更新 HTML、内嵌状态或评论接口。
6. 若评论新抓取失败但页面仍显示旧评论，检查 `preserved_previous` 和 `last_refresh_status`，这是保护行为。

### 14.2 视频无法处理

1. 运行 `yt-dlp --version`、`ffmpeg -version` 和 `ffprobe -version`。
2. 检查平台 Cookie、网络和媒体 URL 是否可访问。
3. 查看 `collection_status.media` 与 `video_text_meta`。
4. 视频模型失败但 `method=frame_ocr` 时属于预期回退。
5. 确认临时磁盘空间和单任务 600 秒下载/120 秒处理类超时是否足够。

### 14.3 AI 分析为 `unavailable` 或 `partial`

1. 确认文本模型密钥、基础地址和模型名。
2. 使用最小请求验证 OpenAI 兼容接口。
3. 查看是视频部分、评论部分还是两者失败。
4. 检查模型是否返回有效 JSON 和固定字段。
5. 不要因 AI 失败删除 `content.json` 原始数据；修复后执行手动更新。

### 14.4 任务一直 `pending` 或 `running`

1. 查看是否已有 3 个高成本任务占用槽位。
2. 检查服务进程是否重启；内存状态不会跨重启恢复。
3. 检查第三方请求、浏览器和 FFmpeg 子进程是否卡住。
4. 对中断任务先核对正式目录和数据库状态，再重新提交。

### 14.5 数据库锁或损坏

1. 停止所有应用实例并备份 `data/pipeline.db*`。
2. 检查是否误用多进程共享当前内存任务模型。
3. 使用 SQLite 工具执行只读完整性检查。
4. 不要直接删除 WAL/SHM 文件来“解锁”；先确保所有连接已关闭并按 SQLite 备份流程处理。

### 14.6 中文日志乱码

Windows 控制台或测试捕获可能显示乱码，但不一定表示文件内容损坏。确认终端为 UTF-8、源文件以 UTF-8 保存，并直接读取 `content.json` 验证。不要仅根据控制台渲染决定覆盖结果文件。

## 15. 备份、恢复与数据保留

### 15.1 建议备份集合

- `data/pipeline.db` 及 SQLite 一致性备份。
- `data/*.cookies.txt*` 与 `data/*.storage_state.json*`，使用加密和最小权限。
- `output/` 中需要保留的任务证据和审计文件。
- `.env` 的密钥应进入秘密管理系统，不与普通文件备份混放。

### 15.2 恢复顺序

1. 在隔离环境验证应用版本和数据库副本匹配。
2. 恢复数据库和任务目录，保持任务 ID 路径一致。
3. 恢复登录态前确认凭据仍有效且授权未撤销。
4. 启动服务，执行健康检查和一条只读历史/结果验证。
5. 再执行一条受控新任务，确认第三方服务与写入能力。

数据保留时间应由业务、隐私和合规要求共同决定。删除任务会永久移除系统内任务文件，备份系统的删除需另行治理。

## 16. 持续更新机制

本仓库采用以下文档生命周期：

1. `docs/TECHNICAL_MANUAL.md` 是唯一内容源。
2. `tools/build_technical_manual.py` 从 Markdown 生成 DOCX 交付版。
3. `tools/check_technical_manual.py` 提取代码结构快照并与 `docs/TECHNICAL_MANUAL.snapshot.json` 比较。
4. 代码评审时先运行漂移检查；发现变化后先更新手册，再确认新快照。
5. 每次正式发布更新版本号、基线日期和 `docs/TECHNICAL_MANUAL_CHANGELOG.md`。

### 16.1 日常检查命令

```powershell
.\.venv\Scripts\python.exe tools\check_technical_manual.py --check
```

检查范围包括：Flask 路由与方法、环境变量、requirements、数据库表、顶层模块入口、测试数量、内容结构版本、采集模式、存储策略和并发数。脚本退出码为 0 表示与已确认快照一致，退出码为 1 表示需要评审手册。

### 16.2 确认新快照

只有在完成代码评审、测试和手册更新后才能运行：

```powershell
.\.venv\Scripts\python.exe tools\check_technical_manual.py --update-snapshot
```

更新快照不是“修复”漂移，它只表示技术负责人确认手册已反映当前结构。提交或交付前再次运行 `--check`。

### 16.3 重新生成 DOCX

```powershell
& 'C:\path\to\bundled\python.exe' tools\build_technical_manual.py
```

生成后必须将 DOCX 渲染为逐页图片并检查标题、代码块、表格、分页、页眉页脚和中文字体。只修改 DOCX 而不修改 Markdown 会在下次构建时丢失，因此禁止手工维护两个内容版本。

### 16.4 强制更新触发条件

- 新增、删除或修改 API 路径、方法、请求体或响应状态。
- 修改环境变量、默认值、模型提供商、密钥处理或第三方地址。
- 修改 SQLite 表、字段、迁移或文件目录。
- 修改 `CONTENT_SCHEMA_VERSION`、存储策略或素材保留规则。
- 修改并发、缓存、刷新、删除或故障恢复语义。
- 新增平台、采集方式、AI 输出字段或 IdeaHub 通道。
- 依赖升级导致安装、浏览器、FFmpeg 或 Python 版本变化。
- 新增已知限制、安全风险或重大排障经验。

## 17. 发布与交接清单

### 17.1 发布前

- [ ] 全新环境可以按手册安装并启动。
- [ ] `.env.example` 与 `config.py` 的必需配置一致，不含真实密钥。
- [ ] FFmpeg、ffprobe 和 Playwright Chromium 检查通过。
- [ ] 全量 `unittest` 通过。
- [ ] 小红书/抖音受控样例完成最小端到端验证。
- [ ] 缺失 AI 密钥、平台登录失效和第三方超时均能安全降级。
- [ ] 刷新失败保留旧结果，批量删除失败恢复文件。
- [ ] API、内容结构、数据库和输出目录变更已同步手册。
- [ ] 文档漂移检查通过，DOCX 已重新构建并逐页检查。
- [ ] 版本、日期和变更记录已更新。

### 17.2 交接资料

- [ ] 当前运行版本与部署拓扑。
- [ ] 环境变量清单和秘密管理位置，不交接明文密钥。
- [ ] 数据库、Cookie、输出与日志的存储/备份位置。
- [ ] 平台账号负责人、模型服务负责人和 IdeaHub 对接人。
- [ ] 已知限制、待办、最近故障和回滚方案。
- [ ] 一条可复现的健康检查任务和预期结果。

## 18. 已知技术债与后续建议

- 当前工作目录没有 `.git` 元数据；现有变更记录和漂移检查可独立运行，但正式协作应纳入 Git 或等效版本控制，并在评审流程中执行文档门禁。
- `main.py` 是失效的旧 CLI 入口，应删除、迁移或恢复依赖后增加入口测试。
- `.env.example` 未覆盖 `config.py` 的完整变量，建议由配置清单生成示例文件或增加一致性测试。
- 当前没有锁定依赖版本、开发依赖文件或 CI 配置；建议引入可重复构建和自动测试。
- 当前没有统一结构化日志、指标、追踪和告警。
- 当前内存任务状态限制了多进程和横向扩展；需要任务队列时应重新设计状态模型。
- API 缺少认证、授权、CSRF 和速率限制，只适合受控环境。
- SQLite 迁移机制仅覆盖一个追加字段，建议引入显式 schema 版本和迁移脚本。
- 自动漂移检查覆盖结构变化，但不能判断业务语义是否变化，仍需要技术负责人评审。

## 附录 A：常用命令

```powershell
# 启动
.\.venv\Scripts\python.exe app.py

# 全量测试
.\.venv\Scripts\python.exe -m unittest discover -s tests -v

# 文档漂移检查
.\.venv\Scripts\python.exe tools\check_technical_manual.py --check

# 查看最近任务
Invoke-RestMethod http://127.0.0.1:5000/api/history

# 查询任务
Invoke-RestMethod http://127.0.0.1:5000/api/status/<task_id>

# SQLite 只读快速检查（已安装 sqlite3 CLI 时）
sqlite3 data/pipeline.db "PRAGMA quick_check;"
```

## 附录 B：维护责任建议

| 内容 | 主责角色 | 复核角色 |
|---|---|---|
| 安装、部署、监控、备份 | 运维/平台工程 | 后端开发 |
| API、任务状态、数据库 | 后端开发 | 测试/运维 |
| 页面与交互 | 前端开发 | 测试/产品 |
| 平台采集与登录 | 采集工程 | 安全/测试 |
| OCR、视频模型、AI 分析 | AI 工程 | 数据/业务/安全 |
| IdeaHub 接口 | 集成工程 | 后端/安全 |
| 测试基线和发布门禁 | 测试工程 | 模块负责人 |
| 手册与变更记录 | 变更发起人 | 技术负责人 |
