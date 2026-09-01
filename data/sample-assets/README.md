# 样本库原始媒体（跨机搬运用的镜像副本）

这里是 `sample_assets` 表引用的原始图片/视频/音频，按 `storage_key`（内容哈希）平铺存放。

## 为什么会有这个目录

生产环境真正在用的目录是**仓库外**的 `/opt/ideahub-samples`（见 `docker-compose.yml` 的
`${SAMPLE_ASSET_PATH:-/opt/ideahub-samples}`）。那个目录不进 git —— 样本库上传弹窗里
写的"文件按原始字节流式保存，不进入 Git"说的就是它。

于是换一台机器时会出现这个坑：`backup/ideahub-db.sql` 带着全部 `sample_assets` 记录跟仓库
走了，但文件没走。新机器上样本卡片会显示"N 份媒体"、封面却全是坏图问号，应用还会提示你
"重新上传" —— 其实文件一个没丢，只是没被搬过来。

（对照组：真人/矩阵那边的图走 `/api/files/{id}` → `data/uploads/`，那个目录**在**仓库里跟踪着，
所以换机后一直是正常的。两边看起来一样，存储根其实不是同一个。）

这个目录就是为了补上这一段搬运。

## 在另一台机器上怎么用

1. `git pull` 拿到这些文件；
2. 改**本机**的 `.env`（`.env` 不被 git 跟踪，不会被 pull 覆盖）：

   ```
   SAMPLE_ASSET_PATH=./data/sample-assets
   ```

3. `docker compose up -d api`，刷新样本库页面。

Docker Desktop for Mac 默认只共享 `/Users`、`/Volumes`、`/private`、`/tmp`，`/opt` 不在其中；
用仓库内的相对路径正好绕开这一点。

## 维护须知

- **这是副本，不是生产存储。** VPS 上不要把 `SAMPLE_ASSET_PATH` 改到这里。
- 目前是**一次性快照**（2026-09-01，49 个文件 / 9.4MB，已按数据库 sha256 逐条校验）。
  VPS 之后新采集的素材不会自动出现在这里，需要再同步一次。
- 文件名是内容哈希，写一次永不修改，所以 git 里每个文件只存一份，不会重复累积。
- ⚠️ 如果哪天开始归档视频要特别小心：`SAMPLE_ASSET_MAX_BYTES` 默认 500MB，而 GitHub 硬拒
  单文件 >100MB。一旦有这种文件被提交进来，`git push` 会永久失败，并**连带把每天 03:20 的
  数据库备份推送一起打断**。同步前先筛一遍体积。
- 在开发机上如果把 `SAMPLE_ASSET_PATH` 指向这里，本地新上传的媒体会直接落进工作区，
  变成 git 改动，注意别误提交。
