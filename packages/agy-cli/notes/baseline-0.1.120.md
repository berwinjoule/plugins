# 0.1.120 基线（0.1.116 候选作废）

生产只读回报：插件宿主是 Bun 1.4.5；磁盘 `index.mjs` sha256 是 `8cc4e0a591efad49e067d0b8231d7ac966c7fba4dd10a727cee6c90b8b3b3868`，版本 0.1.120。内存哈希未知，不能把磁盘和内存说成同一个包。

公开源码 `magpie-community/plugins` `e967ba4d946071c6c27a51cd5168b12ce832da5c` 的 `packages/agy-cli/index.mjs` 算出同一个 sha256，`package.json` 版本是 0.1.120。这只证明这一份公开 `index.mjs` 与上报的磁盘文件一致。安装目录里的其他文件是否逐字节相同，这里未知。

`e967ba4d` 里没有 `rawResultKey`、`turn.continuing`、`replayToolStep`。#1482 仍 open 未合并。#1513 仍 open，head 已改到 `e741e5940be0b6076bb11265479d73c2251aec3f`，作者写明只保留幂等重放，并拿掉了 account 分区、`continuing` 和 abort 响应。#1520 没有合入。

因此 0.1.116 上的旧候选不能部署，也不能覆盖或回退现在的 0.1.120。本分支用 merge 接上 `e967ba4d`，不 rebase 已有提交，再把重放、raw 身份、`continuing` 占位和 user/home 匹配接到 0.1.120 上。补丁后的 `index.mjs` 哈希必然不同于生产磁盘，`FORK_BUILD.json` 把这一点写成 false。

宿主：Magpie 0.1.4656 的 plugin host 由主进程直管，`magpie.service` `CanReload=no`、`KillMode=control-group`。没有已证实的独立 host reload。最近仍有 attached/pending turn。部署方案不能承诺只重启 host、无会话中断或 OAuth 零刷新。本文件不授权任何生产操作。
