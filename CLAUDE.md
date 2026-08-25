# IdeaHub —— 改动前必读

> 这台 VPS 上同时跑着 4 套互不相干的服务。**IdeaHub 的任何改动都不得影响其他项目的正常运行。**
> 本文件是每次动手前要过一遍的全局清单。**凡是落进「需要人工审核」一节的操作，一律先停下来问，不要自作主张执行。**

---

## 一、最高铁律

1. **改动范围默认锁死在 `/root/ideahub-deploy/` 之内。** 要写这个目录以外的任何文件，先停下来问。
2. **拿不准就问，不要试。** 这台机器上跑着生产服务，"试一下看会不会坏"的代价是别人的服务掉线。
3. **动手前后各跑一次 `bash scripts/check-neighbors.sh`**，确认邻居服务状态没变。
4. 本项目**是 git 仓库**（2026-08-25 起），远端是 GitHub 私有仓库 `huahua123465/ideahub`。
   改坏了可以 `git checkout -- <文件>` 退回去，不必再往项目外拷临时备份。
   **注意远端仓库里有 `.env` 和 `data/uploads/`（真实客户附件）** —— 那是有意的，
   它同时充当异地备份，所以仓库必须一直保持 Private。

---

## 二、这台机器上有谁

| 服务 | 位置 | 对外端口 | 归属 |
|---|---|---|---|
| **IdeaHub**（本项目） | `/root/ideahub-deploy` | `18080` (HTTP) | compose 项目 `ideahub` |
| infinite-canvas | `/opt/ai-stack/infinite-canvas` | `127.0.0.1:3010` | compose 项目 `infinite-canvas` |
| new-api | `/opt/ai-stack/new-api` | `127.0.0.1:3011` | compose 项目 `new-api` |
| canvas-media-https | 配置在 `/opt/ai-stack/new-api/` | `80`, `9443` | 独立容器，**三个项目共用的前置 Caddy** |
| xray / x-ui | 宿主机进程 | `443`, `8443`, `2053`, `2083`, `2087`, `2096`, `11111`, `62789` | 系统服务，与本项目无关 |

**443 是 xray 的，不是我们的。** 别以为 HTTPS 就该在 443。

---

## 三、⚠️ 危险区：跨项目的耦合点

### 1. IdeaHub 的 HTTPS 入口不在本项目里

对外地址由 **`/opt/ai-stack/new-api/Caddyfile.canvas-media`** 提供 —— 那个文件属于 new-api，
挂进 `canvas-media-https` 容器，而**同一个 Caddy 同时在服务 infinite-canvas 和 new-api**。

> 后果：改 IdeaHub 的对外路由 = 动一个同时扛着三个项目的文件。
> 那个 Caddy 配置写错或重启失败，**另外两个项目一起掉线**。
>
> ⛔ **改这个文件、或重启 `canvas-media-https`，一律先问人。**

原因是这台机器的 80 端口在那个 Caddy 手里，而签 Let's Encrypt 证书需要 80（HTTP-01），
IdeaHub 自己的 Caddy 拿不到 80。这是有意的设计，不要试图"改回来"。

### 2. 端口 18080 硬编码在两个地方

- `/root/ideahub-deploy/.env` 的 `HTTP_PORT=18080`
- `/opt/ai-stack/new-api/Caddyfile.canvas-media` 里的 `reverse_proxy 172.17.0.1:18080`（两处 handle 块）

> **改端口必须两边同时改**，只改一边 = IdeaHub 从公网彻底失联。而第二个文件在危险区，要先问人。
> 上游走 docker 网关 `172.17.0.1` 是因为两个 compose 项目不在同一个 docker 网络里。

### 3. 共享的 docker 资源

镜像层、构建缓存、`bridge` 网络（`172.17.0.1`）是全机共用的。
清理类命令会波及别人 —— 见下面的禁止清单。

---

## 四、操作分级

### ✅ 安全（自己做即可）

- 改 `/root/ideahub-deploy/` 下的源码、样式、文档
- `node scripts/build-web.mjs`（只写 `web/dist/` 和 `web/index.html`）
- `docker compose up -d --build`、`docker compose restart api`、`docker compose logs`
  —— 在本项目目录下执行时，作用域被 `name: ideahub` 限定，只动自己那 3 个容器
- `npm run test:api` / `test:ui`、只读的查询命令
- 起临时服务器调试（**用没人占的端口**，跑完记得关）

### ⚠️ 需要人工审核（先问，别动手）

- 编辑 `/opt/ai-stack/**` 下的任何文件 —— 尤其是 `Caddyfile.canvas-media`
- `docker restart canvas-media-https` / 让那个 Caddy 重载配置
- 改 `.env` 里的 `HTTP_PORT`，或 `docker-compose.override.yml` 的端口映射
- 占用一个新的宿主机端口（先用 `ss -tlnp` 确认没人用）
- 任何涉及证书、DNS、域名的改动
- 数据库结构变更（`server/src/schema.sql`）、数据迁移、`npm run db:reset`
- 装/升级系统级软件、改系统服务

### ⛔ 禁止（除非用户明确逐条授权）

- `docker system prune` / `docker image prune -a` / `docker volume prune`
  —— 会删掉其他项目在用的镜像和卷
- `docker stop $(docker ps -q)` 之类的批量操作
- 在 `/opt/ai-stack` 或 `/` 下执行 `docker compose down`
- 动 xray / x-ui 的任何东西（`443/8443/2053/2083/2087/2096/11111/62789`）
- `rm -rf` 项目目录以外的路径
- 碰 `/root/ideahub-deploy/data/`（Postgres 数据 + 用户上传的附件）。
  异地备份现在有了（每天 03:20 自动推 GitHub，见下面「备份」一节），
  但那是**每天一次**的快照 —— 今天新产生的数据仍然只有这一份，删了就没了。

---

## 五、改动流程

```bash
cd /root/ideahub-deploy

# 1. 改之前：记录邻居基线
bash scripts/check-neighbors.sh > /tmp/before.txt

# 2. 确认工作区干净（有 git 了，不用再手工拷备份）
git status --short          # 应该是空的；不空说明有别人/上一轮没提交的改动

# 3. 改代码 → 语法检查 → 打包
node --check web/src/<改过的文件>.js
node scripts/build-web.mjs

# 4. 部署（只影响 ideahub 自己的容器）
docker compose up -d --build

# 5. 改之后：确认邻居没被波及
bash scripts/check-neighbors.sh > /tmp/after.txt
diff /tmp/before.txt /tmp/after.txt   # 应当无差异
```

前端源码是 COPY 进镜像的，**改了源码不重新 build 就不会生效** ——
反过来说，改源码本身不会影响正在跑的站点，这一步是天然的安全垫。

---

## 五又二分之一、备份与恢复

| | |
|---|---|
| 每天 03:00 | `scripts/backup.sh` → 本地 `/backup/ideahub`，保留 30 天 |
| 每天 03:20 | `scripts/backup-to-git.sh` → 推到 GitHub 私有仓库（代码 + `.env` + 附件 + 整库导出） |

远端仓库是**这套系统的完整副本**：机器没了，在新机器上 clone 下来就能原样起回来，
步骤见 `backup/恢复说明.md`。`.env` 也在里面，恢复时不用重新想数据库密码。

**只覆盖 IdeaHub。** 这台机器上的 xray / x-ui、new-api、infinite-canvas 都不在备份范围内。

改 `.env` 要留意：它现在跟着仓库走，从别处 `git pull` 会覆盖掉服务器上这一份。

## 六、访问地址

| 地址 | 用途 | 安全上下文 |
|---|---|---|
| `https://xm.xingxingqule.com:9443` | **推荐**，证书有效 | ✅ 是 |
| `http://xm.xingxingqule.com` | 不带端口，好输入 | ❌ 否 |
| `http://67.230.168.104:18080` | 直连，绕过前置 Caddy | ❌ 否 |
| ~~`https://xm.xingxingqule.com`~~ | **不可用**，443 是 xray，证书对不上 | — |

**"安全上下文"这一列会影响功能**：桌面通知、剪贴板等能力只在 HTTPS 下开放。
所以要用桌面通知，必须走 `:9443` 那个地址。详见 `web/src/views/alert.js` 的注释。
