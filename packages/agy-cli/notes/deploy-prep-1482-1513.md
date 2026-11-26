> Historical note from before the 0.1.139 rewrite. Current fork base is `0.1.139-fork.1` on `5d9c08fc`. See `rebase-0.1.139.md`.

# 部署前准备与写入通路（未部署、未推送）

本文件只记录 2026-11-24 对已有集成分支的续作。没有重做 #1482 / #1513 的代码整合，没有连接 VPS 或开发机，没有改生产配置，没有重启，没有账号 OAuth，没有真实模型请求。

## GitHub 写入通路

Cursor 的 GitHub 集成是连着的，而且这个 fork 的权限够推送。缺的是这台 VM 的 git 客户端凭据注入，不是仓库授权。

证据：

- `cursor-github get_me` 返回已连接账号 `berwinjoule`（id `11504640`）。
- `get_repository berwinjoule/plugins` 返回 `permissions.push=true`、`admin=true`、`maintain=true`。仓库是 public fork，父仓库是 `magpie-community/plugins`，默认分支 `main`。
- 本 run 的 dashboard 事件里没有 `mcp_auth_error`。先前的 `pr_creation_failed` 只说分支还没出现在远端。
- `gh auth status` 是未登录。这只说明 gh CLI 没有自己的登录，不能当成 Cursor 集成未连接。
- 这台 VM 的 git：`origin` 是不带用户信息的 `https://github.com/berwinjoule/plugins`；`git config` 没有 `credential.helper`，也没有 `include`；环境里没有 `GH_TOKEN` / `GITHUB_TOKEN` / `GIT_CONFIG_GLOBAL`。`GIT_TERMINAL_PROMPT=0 git push -u origin cursor/agy-cli-integrate-1482-1513-38a7` 再次失败：`could not read Username for 'https://github.com'`。

因此父级不该把这次失败当成需要重新连接 GitHub 或补 repo grant。`RequestScmConnect` 的「未连接 / 缺仓库访问 / 凭据失效」三个条件都不成立，这里不调用它，也不把 `reconnect` 设成 true。

父级要做的是：把已经连上的 `berwinjoule` 的官方 git 写入凭据注入这台 VM（git credential helper 或官方 git-auth include），不要把 token 交给本代理、不要嵌进 URL。注入之后，由本代理执行：

```bash
git push -u origin cursor/agy-cli-integrate-1482-1513-38a7
```

然后只用原生 PR 工具，把该分支对 `berwinjoule/plugins` 的 `main` 开 PR。不合并，不 force-push，不对 `magpie-community/plugins` 开 PR。如果注入入口的函数名就是 `RequestScmConnect`，和上述证据相符的参数是：`intent=push`，`provider=github`，`repo=https://github.com/berwinjoule/plugins`，`reconnect=false`。这是把已有连接的写凭据送进 VM，不是重新授权。

在注入完成前，提交只在这台 VM。不含秘密的补丁、bundle 和源码包在 `/opt/cursor/artifacts/`，见同目录 `SHA256SUMS`。

## 测试覆盖

假 ACP / 假 MCP。`AGY_BRIDGE_STORED_SIGNIN=skip`，`HOME` 指向临时目录。没有真实 `agy` 二进制，没有登录，没有模型网络。

先前已在 node 上通过、这次没有重跑整合本身：`owner-acceptance` 7/7 且重复 20/20；`duplicate-result-notice` 4/4；`tool-step-retry` 11/11。

这次用 node `--experimental-vm-modules` 补跑：

| 文件 | 结果 |
|---|---|
| `test/smoke.mjs` | `ALL OK (390 checks)`，退出 0 |
| `test/repeat-batch.mjs` | 97/97 |
| `platform` `prefill` `usage` `signin` `catalog` `step-usage` `tool-schema` `tool-summary` `usage-settlement` `windows-nc` `conversation-key` `masking-drift` | 全部退出 0（14、9、49、10、45、10、24、2、41、8、37、41） |
| 先前 node：steer、unmatched、dropped-call、spare、stateless-reuse、concurrent、tools-listed、compat | 10、5、3、7、8、9、5、13 |

`agy-cli.test.mjs` 列出的套件因此都在 node 上通过。`array-items-unit` 与 `documents-unit` 在 bun 直接执行脚本时通过（14ms 量级），它们不走坏掉的 vm 路径。

bun 1.2.21 是用 npm 装进 `/tmp/bun-prefix` 的官方包。`bun test ./agy-cli.test.mjs` 不能当这次的结论：它的子进程是 `bun test`，bun 的 `vm.SourceTextModule` 把 `initializeImportMeta` 的 `meta` 传成 undefined，依赖 testkit 的套件成批失败。同一条 `smoke.mjs` 用 bun 当运行时是 390 项里 2 项失败（same-opening 的 history replay / 不共享 live session）；用 node 再跑是 390/390。这两项失败记在 bun 运行时上，不记成集成回归。`install.test.mjs` 和 `cloak.test.mjs` 不在 `agy-cli.test.mjs` 的入口里，没有跑；`install.test.mjs` 自己用本地假服务器，注释写明不访问网络，但也不在这次授权的套件入口里。

## 宿主加载与认证（只根据本仓库）

Magpie 的安装入口是 `magpie plugin add @magpie-community/opencode-agy-cli-auth`。包的 `main` 是 `opencode.mjs`，它只 `export { default } from "./index.mjs"`。`exports["."]` 是 `opencode2.mjs`，给 OpenCode 2.x；注释写明 Magpie 的插件宿主走 1.x 这面。业务在 `index.mjs`。进程池、`toolCalls`、`Turn` 都在该进程的模块内存里。

本仓库没有插件热加载 API，也没有「只替换 `index.mjs` 立即生效」的机制。Node 已经求值过的 ESM 不会因为磁盘文件变了而重新执行。账号侧的 `forgetStoredSignIn()` 只丢掉 30 秒的钥匙串/令牌文件读取缓存（`signin.mjs` 的 `CACHE_MS`）。它在登录回调和从文件导入账号时被调用。本仓库没有 `forgetAccount`。账号 reload 不是代码 reload。

是否必须重启 Magpie 主服务，还是可以只重建插件宿主进程：本仓库写不出来。README 里的重启指的是 agy 可执行文件和数据目录还在，以及「重启后第一次 `models()`」，不是插件源码热替换。

会读登录状态、但不能说成向 Google 刷新 OAuth 的路径：

- `storedSignInNow()` 返回缓存；缓存空或超过 30 秒就在后台再读一次钥匙串或账号目录里的 token 文件。
- 冷启动、没有账号 home 的默认账号，第一次请求会 `await storedSignIn()`，用来和后续请求落在同一分区。这是读，不是插件自己向 Google 换 token。
- `agy` 在自己的 home 里会读并续期那个文件。插件注释这样写。插件进程自己没有 Google OAuth refresh 调用。
- `models()`、`authorize`、`usage` 会找本机 `agy` 并可能因此让 agy 碰到登录。宿主启动或重载时会不会调用它们，本仓库不能保证。标为未知。
- 重新 import 插件、或宿主在启动时跑上述钩子，不能保证不碰到已有登录读取。当前「不刷新 OAuth」的边界下，不能把这次构建装进正在跑的宿主。

## 父级需要的只读核验（不要在未获准前做）

1. 运行中宿主的进程名、启动命令、插件目录绝对路径。报告里的安装位置是 `~/.config/magpie/plugins/node_modules/@magpie-community/opencode-agy-cli-auth/`，本仓库不能证明现在仍是这样。
2. 该进程已经打开或映射的 `index.mjs` 哈希，是否仍是 `a2f544638abd10ec4e3f4fb694b508c057b5ea22c96576971daf0c0978ecc4b9`。磁盘文件和内存模块可以不一致。
3. Magpie 是单个进程加载插件，还是有可以单独重建的插件宿主。本仓库没有这个开关。
4. 宿主启动、重载、`models()` 刷新是否会调用 `authorize`、`usage` 或 `storedSignIn`。
5. 有没有在途 tool turn。有的话，换进程会丢掉内存里的 `toolCalls`。

## 部署、备份、排空、校验、回滚（计划，不要执行）

候选物是公开插件源码包，版本号仍是 0.1.116，不是上游已发布的 0.1.117，也不是 npm 发布。关联提交见 `SHA256SUMS` 旁的说明和 git bundle。包内 `files` 列表才是安装内容；`test/` 和 `notes/` 不在 `package.json` 的 `files` 里。

1. 备份：停新流量之前，把整个已安装包目录复制到带时间戳的目录，并记下 `index.mjs`、`package.json`、`opencode.mjs` 的 sha256。不要只备份一个文件。
2. 排空：让该 provider 不再接新请求。等在途响应 detach、agy 子进程退出。做不到静默排空时，就接受在途工具调用会丢。不要用账号 reload 代替排空。
3. 替换：停掉已经 import 该包的宿主进程，整包换成候选目录，再启动。不要在进程还活着时覆盖 `index.mjs` 并认为已经生效。
4. 启动风险：第一次请求或宿主的 `models()` 可能读钥匙串或 token 文件。不能把这次启动说成不会碰到 OAuth 相关读取。
5. 校验：只读比较加载路径上的文件哈希和候选 `SHA256SUMS`。不要发真实模型请求当验收。版本号应仍是 0.1.116。
6. 回滚：再停宿主，整目录换回备份，启动。不要用 git reset 或账号操作代替。

下一关口：先注入这台 VM 的官方 git 写凭据并完成 fork PR；部署仍然要另一次明确授权，而且只能发生在上面的只读核验之后。
