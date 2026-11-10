# dsh-setting-backup

把 DeepSeek Harness 的配置和**已安装插件清单（含精确版本）**打包成一个 zip，换成新环境时一键还原整个工作台。

## 它解决什么

换机器、重装、或者把一套调好的工作台复制给同事时，真正难还原的不是配置文件，而是「装了哪些插件、各是什么版本」。本插件把这两件事一起打包，并按固定流程还原：

```
导入 zip  →  重启①  →  自动安装插件  →  重启②  →  原工作台复活
```

## 安装

```bash
dsh plugin --profile desktop add https://github.com/<you>/dsh-setting-backup
```

离线或本地开发：

```bash
dsh plugin --profile desktop add "D:/code/dsh-plugins/dsh-setting-backup"
```

装好后重启 DSH，左侧栏会出现「配置备份」，主区与 设置 → 配置备份 都能打开同一页面。

## 导出

页面「导出」区，点「导出 zip」。产物落在 DSH_HOME 下（不在 profile 里，避免 profile 重建时被清掉）：

```
~/.dsh/setting-backup/exports/dsh-setting-backup-<yyyy-MM-dd_HH-mm-ss>.zip
```

时间一律用**本地时间**，界面显示为 `yyyy-MM-dd HH:mm:ss`。

导出后点「另存为…」可以自己选保存位置：

- 浏览器支持原生保存对话框（`showSaveFilePicker`）时，直接弹窗让你选目录和文件名；
- 不支持时退回普通下载流程，在下载对话框里同样能选位置。

两种情况都会**额外保留一份默认副本**在上面那个 `exports` 目录里，作为安全网。

包内结构：

```
manifest.json      格式版本、DSH 版本、profile、平台、是否含凭据
plugins.json       插件清单：名称、实装版本、来源、安装 spec
checksums.json     每个文件的 sha256
config/home/       settings.yaml（勾选后含 .credentials.yaml / .env）
config/profile/    package.json、cordis.patch.yml、cordis.yml、pnpm-*.yaml
```

**凭据默认不导出。** 勾选「包含凭据」才会写入，包内会被标记为 sensitive，导入时必须再次明确同意。

不包含：`sessions`、`attachments`、`cache`、`node_modules`、业务数据库——这些是数据，不是配置。

## 导入与还原

1. **导入**：选 zip → 可先看预检（待安装几个、版本不符几个、哪些是本地来源）。确认后：
   - 先给当前配置存一份本地快照（可随时回退）
   - 解包到 `.setting-backup/staged/`
   - 只立即覆盖 `settings.yaml`
   - **不动** `package.json` / `cordis.patch.yml` / `cordis.yml` / `pnpm-*.yaml`
   - 状态置 `staged`，提示重启①
2. **重启①** → 进入安装环节，逐插件执行 `dsh plugin add <name>@<版本>`，页面显示每条结果
3. **装齐后提交配置**：这一步才会覆盖 profile 的插件配置并写 `dsh.profile.bundles`。写入前逐条校验每个包真的在 `node_modules` 里，任何一条不在就**拒绝写入**并报出包名
4. **重启②** → 原工作台

## 为什么第一段不能直接覆盖插件列表

DSH 启动时会解析 `dsh.profile.bundles` 里的每个包，解析不到就判 `cannot resolve` 并**拒绝启动**。如果导入时就把还没安装的插件写进 bundles，重启后 DSH 根本起不来，安装环节没有执行环境。所以插件列表必须等装齐之后才落盘。

## 失败与回退

- 单条插件安装失败不会中断其余条目，但状态会停在 `failed`，不进入「提交配置」
- 页面「故障与日志」区列出失败项与 stderr 摘要
- 「重试安装」再试一次；「整单回退」把配置恢复到导入前（纯本地文件操作，不依赖网络）

## 已知边界

- `link:` / `file:` / GitHub 直连来源的插件，跨机不一定能重新下载。预检会单列出来提示手工处理，不会假装装成功。
- 插件版本按导出行时的**实装版本**精确还原，不跟随升级。
- 本插件自身是还原的载体：全新环境需先装本插件，或导出时勾选「同时包含本插件包」。

## 开发

```bash
node test/all.mjs     # 全部单测（同进程运行，不 spawn 子进程）
```

```
lib/paths.js      DSH_HOME / profile 目录解析
lib/collect.js    收集配置与插件清单
lib/zip.js        零依赖 zip 读写 + 路径守卫
lib/archive.js    打包与校验
lib/plan.js       差异计算 + bundles 守卫
lib/state.js      两段式状态机
lib/snapshots.js  本地快照与轮转
lib/install.js    调用官方 dsh plugin add
lib/apply.js      提交配置与 .bak 回滚
lib/routes.js     HTTP 接口
lib/client.js     侧栏 / 主区 / 设置页 UI
```
