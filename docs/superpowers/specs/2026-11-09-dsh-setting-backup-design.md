# dsh-setting-backup 设计文档

- 日期：2026-11-09
- 状态：待评审
- 插件名：`dsh-setting-backup`（显示名「配置备份与恢复」）

## 1. 目标与不做什么

### 目标

1. 在 DSH 左侧栏提供一个「配置备份与恢复」入口，集中完成备份、导出、导入。
2. 导出一个 **ZIP 包**，内含 DSH 当前生效配置 + 已安装插件清单（含精确版本），用于跨环境还原工作台。
3. 导入时 **覆盖** 当前配置（不与现有配置合并），并还原插件。
4. 还原链路必须走通：导入 → 重启 → 自动安装插件 → 再次重启 → 回到原工作台。
5. 任何一步失败都必须可回退到导入前的配置，且 **DSH 始终能启动**。

### 明确不做

- 不导出 / 不还原 `sessions`、`attachments`、`cache`、`node_modules`、`*.sqlite` 等业务数据与二进制目录（体积与隐私）。界面上列为「不包含」。
- 不做配置合并、不做智能 diff 合并；覆盖即覆盖。
- 不代管官方账户凭据之外的任何密钥内容（凭据默认不导出）。

## 2. 关键约束（决定设计形态）

### 2.1 硬约束：bundles 未就位前绝不可写入配置

DSH 启动时会对 `package.json` 的 `dsh.profile.bundles` 逐条做解析检查，解析不到即判 `cannot resolve <name>` 并**拒绝启动**（`dsh-undo-savepoint` 的 safe mode 正是为此中和 bundle 列表）。

推论：**不能**「导入时一次性覆盖全部配置（含 bundles）→ 重启 → 指望启动后自动装插件」。那样重启后 DSH 根本起不来，安装环节没有执行环境。

因此采用 **严格两段式恢复**，两次重启的职责不同：

**第一次重启 = 进入安装阶段，配置尚未生效**

- 导入时把包内全量配置解包到暂存区 `.setting-backup/staged/<id>/`，只立即覆盖**与插件无关**的配置（`settings.yaml`），profile 的 `package.json` / `cordis.patch.yml` / `cordis.yml` / `pnpm-*.yaml` 一律不动。
- 因为 plugins 配置未改，DSH 用旧配置正常启动，本插件（载体，本来就在旧 bundles 里）被加载，读到 `pending-restore.json` 后自动进入安装页并开始安装。

**第二次重启 = 配置生效，回到原工作台**

- 插件装齐后，一次性覆盖暂存区里的 profile 全量配置（含 `bundles`），写入前做 resolve 守卫，然后重启。

这样"重启 → 自动安装 → 再重启 → 恢复"与需求描述逐字一致，同时不会把 DSH 变成起不来的状态。

### 2.2 插件来源不一定可下载

- registry 包：可用 `name@version` 还原。
- GitHub / tarball / 本地 `link:` / `file:` 依赖：**不可假定**跨机可还原。清单必须记录 `source` 与原始 spec，导入预检时对 `local` 来源单列告警，不静默失败。
- 参考既有环境经验：GitHub 直连常超时，registry 可走镜像；安装器需记录并支持 registry 回退。

### 2.3 本插件自身的先有性

本插件是还原的载体。目标环境若没有安装本插件，导入界面本身不存在。跨机首次使用需先安装本插件（README 说明）；可选提供「连同本插件包一起导出」以便离线自举。

### 2.4 配置是多来源的，不止一个文件

| 位置 | 文件 | 作用 |
| --- | --- | --- |
| `DSH_HOME` | `settings.yaml` | 全局设置（含模型配置） |
| `DSH_HOME` | `.credentials.yaml`、`.env` | 凭据（**默认不导出**） |
| `DSH_HOME` | `*.json` 插件自有配置 | 各插件落盘的小配置（白名单收集） |
| `DSH_HOME/profiles/<name>` | `package.json` | 依赖精确版本 + `dsh.profile.bundles` |
| `DSH_HOME/profiles/<name>` | `cordis.patch.yml` | 用户补丁层（插件开关与 config） |
| `DSH_HOME/profiles/<name>` | `cordis.yml` | 基础加载配置 |
| `DSH_HOME/profiles/<name>` | `pnpm-workspace.yaml`、`pnpm-lock.yaml` | 依赖拓扑与版本锁定 |

profile 名不固定（实测存在 `desktop` / `web` / `open-design`），必须从运行时上下文解析，不能写死。

## 3. 包格式

```text
dsh-setting-backup-<profile>-<YYYYMMDD-HHmmss>.zip
├── manifest.json           # 格式版本、DSH 版本、profile、平台、时间、sensitive 标记
├── plugins.json            # 插件清单（见 3.1）
├── checksums.json          # 除 checksums.json 外每个文件的 sha256
└── config/
    ├── home/               # settings.yaml，可选 .credentials.yaml / .env，白名单插件配置
    └── profile/            # package.json、cordis.patch.yml、cordis.yml、pnpm-*.yaml
```

勾选「包含本插件包（离线自举）」时追加 `self/dsh-setting-backup-<version>.tgz`，供全新环境先装载体插件；未勾选则包内无此目录，导入端不假定它存在。

### 3.1 plugins.json 条目

```json
{
  "name": "@hope_phenom/dsh-plugin-code-quality",
  "version": "0.1.1",
  "declared": "^0.1.1",
  "role": "bundle",
  "source": "registry",
  "installSpec": "@hope_phenom/dsh-plugin-code-quality@0.1.1",
  "bundlePatch": "./cordis.patch.yml"
}
```

- `role`：`bundle`（在 bundles 列表）/ `dependency`（仅在 dependencies）。
- `source`：`registry` / `github` / `tarball` / `link` / `file`。
- `source != registry` 时 `installSpec` 保留原始声明，并在导入预检中标注「可能需手工处理」。
- **清单来源**：以 `package.json` 的 `dependencies` 声明为准，`role` 由 `dsh.profile.bundles` 是否包含该名决定；`version` 取 `node_modules/<name>/package.json` 的实装版本（缺包时回退 `declared` 并标 `installed: false`）。不从 `node_modules` 目录遍历反推，避免把传递依赖误当插件。

### 3.2 manifest.json

```json
{
  "format": "dsh-setting-backup/1",
  "createdAt": "2026-11-09T16:40:00+08:00",
  "profile": "desktop",
  "dshVersion": "0.2.2-rc.1",
  "platform": "win32",
  "sensitive": false,
  "counts": { "plugins": 42, "configFiles": 9, "skippedLocalPlugins": 1 }
}
```

`format` 用于导入时拒绝不认识的版本，不做向前兼容猜测。

## 4. 恢复状态机（严格两段式）

状态文件：`<profile>/.setting-backup/pending-restore.json`，暂存区 `<profile>/.setting-backup/staged/<id>/`

```text
idle → staged ──[重启①]──> installing → configured ──[重启②]──> done
                                └── failed（可重试回 installing，或整单回退）
```

| 状态 | 含义 | 已覆盖的配置 | DSH 可启动 |
| --- | --- | --- | --- |
| `staged` | 包已解包校验、差异已算、导入前快照已存 | 仅 `settings.yaml` | 是（profile 插件配置未动） |
| `installing` | 重启①后进入安装环节，逐插件落地 | 同上 | 是 |
| `configured` | 插件装齐、profile 全量配置已覆盖（含 bundles） | 全部 | 是（写入前已 resolve 守卫） |
| `done` | 重启②完成后的回执 | 全部 | 是 |

### 4.1 导入步骤（DSH 运行中，第一段）

1. 读取 ZIP → 校验 `format`、`checksums.json`、拒绝越界路径（zip slip）、拒绝符号链接条目。
2. 解析目标 profile / DSH 版本 / 平台，写入预检报告：`missing`、`versionMismatch`、`localSourceWarn`、`extraLocal`。
3. 解包全量配置到 `staged/<id>/`（不动生效目录）。
4. **覆盖前自动快照**当前配置到 `.setting-backup/snapshots/<stamp>/`（不压缩，可一键回退）。
5. 立即覆盖 `settings.yaml`（与插件加载无关，先让用户看到设置变化）；**不覆盖** `package.json` / `cordis.patch.yml` / `cordis.yml` / `pnpm-*.yaml`。
6. 写入 `staged` 状态，界面提示「需重启进入安装环节」，并把重启按钮置于显眼位置。

### 4.2 第一次重启（进入安装环节）

- 复用既有 detached helper 模式关闭并拉起。
- 启动后服务端读取 `pending-restore.json`：`staged` → 自动转 `installing`，客户端侧栏入口高亮并在主区展示安装页，**自动开始**逐插件安装（不需用户再点一次）。
- 因为 plugins 配置仍是旧的，DSH 这次启动完全正常。

### 4.3 安装步骤（第二段）

- 优先调用宿主暴露的插件管理服务；该服务不可用（或未暴露 install 能力）时，回退为在 profile 目录执行 `pnpm add <installSpec>`（精确版本），最后 `pnpm install --frozen-lockfile` 收敛。两条路径都要先探测 pnpm 可执行文件，探测失败则直接报可操作错误（提示用户安装 pnpm 或改用完整包）。
- registry 直连失败时按配置回退镜像重试（沿用项目既有环境经验）。
- 逐条记录 `ok / failed(reason)`；单条失败不中断其余条目，但**不进入 `configured`**。
- 安装期间禁止并发触发第二次导入（读既有 `.plugin-manager/run.json` 锁）。

### 4.4 提交配置（仍只在 `missing` 为空时执行）

1. 备份将被覆盖的 profile 文件为 `<file>.bak-<stamp>`。
2. 覆盖 `cordis.patch.yml`、`cordis.yml`、`pnpm-*.yaml` 与白名单插件配置。
3. 合并 `package.json`：dependencies 用包内精确版本覆盖；`dsh.profile.bundles` 用包内顺序覆盖。
4. **写入前守卫**：逐条校验每个 bundle 名可被解析（`node_modules/<name>/package.json` 存在），任何一条失败 → 不写 bundles、回滚到 `.bak`、状态置 `failed` 并列出具体缺失名。
5. 状态置 `configured`，界面提示「配置已就位，重启后生效」。

### 4.5 第二次重启与收尾

- 再次复用 detached helper 重启。
- 启动后读取状态：`configured` → 置 `done`，提示「已恢复到备份时的工作台」；`installing` → 继续未完成的安装；`failed` → 显示失败项与「重试 / 回退」两个动作。

### 4.6 为什么第一段不写 packages.json

若在导入时就写入含未安装插件的 `bundles`，下一次启动会被 bundle 解析检查判为 `cannot resolve` 而**拒绝启动**，安装环节将没有执行环境。因此把 `bundles` 的落盘推迟到 4.4，且写入前逐条校验。这是本设计不可让渡的约束。

### 4.7 回退

任一步骤失败都可「整单回退」：删除 `staged/`、恢复 `snapshots/<stamp>/`（含 `settings.yaml` 与 `.bak` 文件）、状态清回 `idle`。回退不依赖网络，纯本地文件操作。

## 5. 侧栏入口与界面

### 5.1 入口

| 槽位 | 用途 |
| --- | --- |
| `sidebar.panellist` + `main` | 侧栏「配置备份」行 + 主区完整页面（成对注册，缺一不可） |
| `settings.section` | 设置页配置区（入口关闭时仍可回来） |

### 5.2 页面分区

1. **概览**：当前 profile、DSH 版本、插件数、上次备份时间、恢复状态徽标。
2. **导出**：勾选项「包含凭据（不推荐）」「包含本插件包（离线自举）」，生成 ZIP 并提供下载/另存路径。
3. **本地备份**：快照列表（时间、插件数、大小），支持「恢复到此快照」「删除」；保留策略默认 5 份。
4. **导入**：选择 ZIP → 预检报告 → 确认覆盖（存快照）→ 提示重启①→ 安装进度页（逐插件，自动开始）→ 提示重启②→ 完成。
5. **故障**：最近一次恢复日志、失败项、重试、回退到导入前快照。

## 6. 安全

- 默认不含凭据；勾选后 manifest 标 `sensitive: true`，页面持续显示警示，且不写入任何诊断日志。
- ZIP 解压白名单目录，拒绝绝对路径、`..`、盘符、符号链接。
- HTTP 接口：仅接受同源请求、限定 method；安装与覆盖类操作要求页面内二次确认。
- 安装命令参数来自包内清单，禁止 shell 拼接（用 `spawn` 参数数组）。

## 7. 模块划分

| 模块 | 职责 | 依赖 |
| --- | --- | --- |
| `lib/paths.js` | 解析 `DSH_HOME`、profile 目录、状态与快照路径 | 运行时 ctx / env |
| `lib/collect.js` | 收集配置与插件清单 → 内存模型 | fs |
| `lib/zip.js` | 最小 ZIP 读写（无第三方依赖）+ zip slip 防护 | fs / zlib |
| `lib/archive.js` | 打包与解包、checksums | zip、collect |
| `lib/plan.js` | 差异计算、本地来源告警、bundles 解析守卫 | collect |
| `lib/install.js` | 逐插件安装、registry 回退、安装锁 | plan、child_process |
| `lib/apply.js` | 备份、覆盖写、回滚 | plan、fs |
| `lib/state.js` | `pending-restore.json` 状态机 | fs |
| `lib/snapshots.js` | 本地快照与轮转 | fs |
| `lib/routes.js` | `/plugins/dsh-setting-backup/*` 接口 | 以上 |
| `lib/client.js` | 侧栏与主区 UI、进度轮询 | routes |

`index.js` 只做 `apply` 编排与 `ctx.inject(['webServer'])` 注册。

## 8. 测试

全部 `node --test`，不依赖真实 DSH：

1. 清单生成：从 fixture 的 package.json + patch 推出 plugins.json（含 `role`/`source`/`installSpec`）。
2. ZIP：往返一致；拒绝 `../`、绝对路径、符号链接条目。
3. 差异计算：missing / versionMismatch / localSourceWarn 分类正确。
4. **bundles 守卫**：构造一个不可解析的 bundle 名 → 断言拒绝写入且状态为 `failed`（这是本设计最重要的回归测试）。
5. 状态机：`staged → installing`（部分失败）→ 不可 configure；全 ok → `configured`；非法跳转（如 `staged → configured`）被拒。
6. 快照轮转：超过保留数按时间删除最旧。
7. 敏感开关：未勾选时不产生 `.credentials.yaml` / `.env` 条目。
8. 接口层：非法 method 405、非同源 403、并发导入被锁拒绝。

## 9. 交付顺序（实施计划将细化）

1. 骨架：`package.json`（`dsh.bundle.patch`、`dsh.client`、`exports`）、`cordis.patch.yml`、`index.js`。
2. 只读能力：`paths/collect/zip/archive` + 导出接口 → 能真实导出当前配置。
3. `plan/state/snapshots` + 预检接口 → 能看到差异报告。
4. `install/apply` + 守卫单测 → 能完成一次真实还原。
5. `client.js` 侧栏 UI 与进度。
6. 真机验证：本机导出 → 改配置 → 导入还原 → 校验工作台恢复。

## 10. 已确认决策

1. **凭据**：默认不导出；勾选「包含凭据」才写入 `.credentials.yaml` / `.env`，并在包内标 `sensitive`。
2. **流程**：严格两段式 —— 导入 → 重启① → 自动安装 → 重启② → 恢复。第一段不写插件列表，理由见 4.6。
3. **其它默认**（未提出异议即采用）：本地备份保留 5 份、不压缩、可回退；`extraLocal`（本地已装但包里没有的插件）默认**保留**不卸载。
