> Historical note from before the 0.1.139 rewrite. Current fork base is `0.1.139-fork.1` on `5d9c08fc`. See `rebase-0.1.139.md`.

# agy-cli 0.1.116：合入 #1482 与 #1513（仅 fork，未部署）

这是个人 fork `berwinjoule/plugins` 上的集成记录，不是上游合并，也不是生产热修。包版本保持 `0.1.116`，没有编造成官方 `0.1.117`。

## 基线

| 项 | 值 |
|---|---|
| 基线提交 | `330335cb6b1ac3abc5750d6412c778d0521465d3` |
| 集成提交 | `e7e2153d765e95841b19e5af3a2a1a934ef62465`（代码、测试与本说明初稿；若本文件再有文档提交，只是补上这个哈希） |
| 提交说明 | `agy-cli 0.1.116: out of the login keychain's reach ...` |
| 提交时间 | 2026-11-24 13:17:50 +0800 |
| 父提交 | `716ba754712b593f83006472fbc8d12ed428e7be` |
| `packages/agy-cli/package.json` | `@magpie-community/opencode-agy-cli-auth` `0.1.116` |
| 与 fork `main`（`e77dec9f`） | `330335cb` 是 `main` 的祖先。`330335cb..main` 没有再改 `packages/agy-cli` |
| 与 #1513 父提交 `d6749261` | `packages/agy-cli/index.mjs` 与 `package.json` 无差异 |

已安装包磁盘哈希 `a2f544638abd10ec4e3f4fb694b508c057b5ea22c96576971daf0c0978ecc4b9` 来自调查报告，本仓库没有那份已安装 `index.mjs`，不能声称运行中的 host 加载的就是这个提交。

## 上游补丁（调查时仍为 open、未合并）

| PR | head | 分支 | 作者提交身份 | 本集成怎么用 |
|---|---|---|---|---|
| [#1482](https://github.com/magpie-community/plugins/pull/1482) | `358312154acfa22704d89cd81a016ce5a67d45e8` | `wangbingnan136:codex/agy-cli-duplicate-result-notice` | `wangbingnan728628-netizen <wangbingnan728628@gmail.com>` | 行为合入。相对上游 main 为 dirty / 有冲突。父提交是 0.1.114，与 0.1.116 的差异只在登录 home / unreachable，不在工具结果路径 |
| [#1513](https://github.com/magpie-community/plugins/pull/1513) | `ffc516f3dd8f04d0055e5592972f8392344cc006` | `shelken:fix/agy-cli-step-receipt` | `shelken <shelken.pxk@gmail.com>` | 行为合入。父提交的 `agy-cli` 与本基线相同，因此以这份 `index.mjs` 为结构底稿 |
| #1520 | 未读取、未合入 | | | 明确排除 |

## 独立核对，而不是按报告逐行改

在未改 `index.mjs` 的 0.1.116 上，用包内 `test/testkit.mjs`（假 ACP、假 MCP socket、`AGY_BRIDGE_STORED_SIGNIN=skip`）先跑失败测试：

1. **续接不是原子的。** 同一 turn 上两个不同的 pending 工具并发各提交一个结果。被 503 拒绝的那一次仍然写下了自己的 `call.result`（日志里是 `result-b`）。`turn.attached` 只在 `continueWith` 之后的 `streamResponse` 里才置位；`await updateTools` 即使目录没变也会让出事件循环。
2. **raw / cooked 被当成同一种结果。** `inspectToolTurn` 把 `<system-reminder>` 拼进 MCP result 再存进 `call.result`。自然 `message_stop` / detach 之后，字节相同的请求重送，在 inspect 之前拿 raw JSON 去比这份 cooked result，得到 `409 conflicting duplicate result`。
3. **`updateTools` 挂起期间 abort** 仍会提交 `ABORT-RESULT`。
4. **`updateTools` 挂起期间把 owner `retiring = true`**，基线仍返回 200，不会在提交前重新确认 owner。
5. **另一个 `user_id`** 在 owner 停在 `updateTools` 时，把 `INTRUDER-RESULT` 写进了 owner 的工具调用。基线的 direct match 不看 user / account。

同时已经成立、必须留下的行为：真正改过的 tool_result 是 409；另一个 `x-magpie-session` 不会提交 owner 的结果，owner 随后仍在原会话结束；两个不同开场的分支可以并行 200。

#1513 的 `checkCommitted: false` 只在「调用 ID 恰好等于 `lastToolStep`」时跳过已提交比较。#1482 的第三步是把已经交付过的旧结果和新建结果放在同一次请求里，调用 ID 对不上 last step，仍会在 inspect 之前拿 raw 去比 cooked。两份补丁不能各 cherry-pick 一次就当组合完成。

## 合入后的行为

以 #1513 的 `index.mjs` 为底，再把 #1482 的 raw 身份接进去：

- `turn.continuing` 在 `await proc.updateTools` **之前**同步置位。第二个请求看到 `turnBusyReason` 为 `continuing` / `attached` / `steering` 时直接 503，不会 `continueWith`。`finally` 清掉 `continuing`。`streamResponse` 同步 `attach`，中间没有两者都为 false 的空隙。
- `updateTools` 返回后、提交前再次确认：请求已 abort、owner 已不是当前 turn、`stopping` / `retiring` / `finalized` / `cancelRequested` / `attached` / `steering`。abort 与退休都不提交。
- 重复身份是 `rawKey = JSON.stringify(toolResult(block))`，记在 `call.rawResultKey`。交给 MCP 的仍是 inspect 之后的 cooked `call.result`（含 notice）。`checkCommitted: false` 保留给 last-step replay：内存里只有旧 cooked `call.result`、还没有 `rawResultKey` 时，不在 inspect 前误 409。
- 相同请求在 `message_stop` 之后重放 `lastToolStep`：同一个 response id、usage 为 0、不再 `session/prompt`、MCP 不第二次交付。digest 仍哈希 **cooked** result，以及 tools / model / effort / output format。notice、工具表、模型不同就不会重放旧步骤。
- account / user / session scope 不匹配时，direct tool id 不绑到别人的 turn，也不推进对方的 `clientSeen` 和时钟。匹配到的 owner 上的占位是这只 turn 的 `continuing`，不是 selected-account 的 `convKey` 锁。不同开场的合法分支不共享这把锁。
- `launchKey` / spare 带上 `accountPrefix`，避免换默认账号时领走另一账号预热的 spare。冷启动默认账号会读一次测试夹具里的 stored sign-in，用来和后续请求落在同一分区。测试夹具不读真实钥匙串。
- `telemetryArgs` 与 `AGY_BRIDGE_TELEMETRY` 的判断没有改。可选遥测仍是默认关闭、显式打开才留给 agy 自己的默认。

有意不做的事：不升版本，不改 registry，不合 #1520，不改无关包，不部署，不推 `magpie-community/plugins`。

## 命令与计数

运行环境：`HOME` 指向空临时目录，`AGY_BRIDGE_STORED_SIGNIN=skip`。没有 `.env`，没有账号凭据，没有真实 `agy` 进程，没有模型请求。测试入口是包内 `node:test` 文件（`agy-cli.test.mjs` 的 bun 外壳本环境没有 bun，未跑）。

基线（`AGY_BRIDGE_TEST_INDEX` 指向 `330335cb` 的 `index.mjs`，或当时工作区仍是该文件）：

| 套件 | 结果 |
|---|---|
| `test/owner-acceptance.mjs` | 7 项里 2 通过、5 失败，退出 1。失败是 split 提交、notice 重试 409、abort 仍提交、退休仍 200、跨 user 写进 owner |
| `test/duplicate-result-notice.mjs` | 4 项里 1 通过、3 失败，退出 1。失败为 409 |
| `test/tool-step-retry.mjs` | 11 项里 1 通过、10 失败，退出 1。第 8 项（真 409 优先于 400 / 不重放过期步骤）在基线上已经通过 |

集成后，每个文件单独进程：

| 套件 | 结果 |
|---|---|
| `test/owner-acceptance.mjs` | 7/7，退出 0；再重复 20/20 |
| `test/duplicate-result-notice.mjs` | 4/4，退出 0；再重复 5/5 |
| `test/tool-step-retry.mjs` | 11/11，退出 0；再重复 5/5 |
| `test/steer-in-session.mjs` | 10/10 |
| `test/unmatched-results.mjs` | 5/5 |
| `test/dropped-call.mjs` | 3/3 |
| `test/spare.mjs` | 7/7 |
| `test/stateless-reuse.mjs` | 8/8 |
| `test/concurrent-convs.mjs` | 9/9 |
| `test/tools-listed.mjs` | 5/5 |
| `test/compat.mjs` | 13/13（含 image / notice 的 `inspectToolTurn`） |

TAP 原文在 `notes/logs/`。

示例：

```bash
export HOME=/tmp/agy-test-home AGY_BRIDGE_STORED_SIGNIN=skip
cd packages/agy-cli
node --experimental-vm-modules --test --test-timeout 180000 \
  test/owner-acceptance.mjs \
  test/duplicate-result-notice.mjs \
  test/tool-step-retry.mjs
```

邻接套件用同样的环境变量、每个文件一个进程。本环境没有 bun，所以没有跑 `bun test packages/agy-cli/agy-cli.test.mjs`，也没有跑 `scripts/check.mjs` 的 bun 入口。

## 风险与没测的路径

- 没有部署，没有改生产文件，没有刷新 OAuth，没有 SSH。不能把原先 8 次 503 或某一条 409 归因到这两处缺陷；现场没有 acceptance 序号，内存里加载的哈希也未知。
- 没跑 `smoke.mjs`、`repeat-batch.mjs`、`usage.mjs`、`platform.mjs`。后两者的包测试依赖 bun 的 `cp-hook.mjs`。
- 没有真实 `agy` / `agy acp` 的 cancel、断线和 CLI 退出。`cancelTurn` 只在假 ACP 里间接碰到。
- 热内存里已经写了 cooked `call.result` 但没有 `rawResultKey` 的调用，普通路径仍退回 cooked JSON 比较；只有 last-step replay 候选会跳过这次比较。这不是一次在线升级演练。
- abort 发生在 `updateTools` 已经发出 `tools_changed` 之后时，目录通告可能已经发出，但工具结果不会提交。
- 重放缓存只在进程内存的当前 turn 上。进程重启、end_turn、取消、digest 任一字段变化都不会重放。
- 分拆提交仍是「先到的那一次占住 owner，后到的 503 且不提交」。协议如果真要合并两次部分结果，本集成没有定义合并规则。

## 回滚与部署核对（只是计划，不要执行）

1. 不要把这个分支装进正在服务的插件 host。当前边界是不刷新认证、不中断在途工具会话。
2. 回滚就是继续使用已安装的 0.1.116 构建。报告里的磁盘哈希是 `a2f544638abd10ec4e3f4fb694b508c057b5ea22c96576971daf0c0978ecc4b9`。部署前要重新计算将要加载的文件哈希，不能假设 host 已经换成 git 里的源码。
3. 若以后单独获准部署：先审 host 加载图和认证调用图；重建 host 会丢掉内存中的 `toolCalls`，并可能碰到既有 OAuth 刷新。`forgetAccount` 不是代码重载。
4. 部署后只做只读核对：版本仍不应冒充上游已发布的 0.1.117；`AGY_BRIDGE_TELEMETRY` 默认行为不变。
5. 出现新的 503/409 时记录 owner、accept 阶段和 raw/cooked 是否相同，不要靠关掉账号或换 IP 当作修复。
