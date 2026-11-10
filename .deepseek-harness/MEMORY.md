## DSH 机制
- DSH 启动会逐条解析 profile 的 dsh.profile.bundles，任一条解析不到即判 cannot resolve 并拒绝启动；因此任何"还原插件配置"的功能都不能一次性写入未安装插件的 bundles，必须等插件装齐后再写并逐条校验。
- bundles 守卫必须豁免宿主托管包（正则 ^@deepseek-ai\/dsh(?:-|$)，出处 dsh-undo-savepoint 的 HOST_MANAGED_BUNDLE_RE）：@deepseek-ai/dsh-base、dsh-web-app 等由宿主自带，不在 profile 的 node_modules 里，凡把它们判成缺失的校验都会让真实环境的提交永远失败。

## 环境必知
- 本机 `node --test` 会因每文件 spawn 子进程被沙箱拒（spawn EPERM），测试改用同进程 runner（test/all.mjs 依次 import 各 *.test.mjs），npm test 指向它。
- dsh_hot_reload 换完代码后条目会暂落 disabled（路由变 404），再调用一次同一 entryId 才回到 active；判断是否真加载要看 dsh_diagnose_plugin_load 的 phase，不能只看 hot_reload 的 ok。
- 会话默认仅 workspace-write，写 ~/.dsh（安装插件 dsh plugin add、清理 profile 残留）会被 EPERM 拒绝，需要对该次命令申请 danger-full-access；dsh_restart 还受 enableRestart 开关限制，默认关闭时调用直接返回 not-configured。

## 项目约定
- 插件安装配置的正确入口是 `dsh plugin --profile <name> add <spec>`（内部转发 pnpm 到 profile 目录），不要自己往 profile 跑包管理器；plugin add 会把包追加进 dsh.profile.bundles 并维护 dependencies。
