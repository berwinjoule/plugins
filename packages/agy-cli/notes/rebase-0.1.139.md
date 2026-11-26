# agy-cli fork rebuilt on official 0.1.139

This fork's `main` was rewritten onto official `magpie-community/plugins` `main` at `5d9c08fca0d34472f032a3555e7ed30d06ff81dc` (`@magpie-community/opencode-agy-cli-auth` `0.1.139`). The packed version is `0.1.139-fork.1`. It does not claim official `0.1.140`. `notOfficialRelease` is true.

Official `0.1.135` through `0.1.139` are in this base and were not dropped: usage and the stored email (`0.1.135`), web search through agy's own `search_web` (`0.1.136`), a one-request image or hook block keeping the live session (`0.1.137`), a marker-only compact-budget notice as a baseline (`0.1.138`), and a replay over 128 KiB sent whole over several prompts (`0.1.139`). The other commits between `d8e0ed71` and `5d9c08fc` are other packages.

Behavior that official `0.1.134` already had was not replayed: raw tool-result identity (0.1.129), identical tool_result step replay (0.1.131), AgentSummary scope (0.1.127), and cross-account `sameAccount()` (0.1.133).

Checked on `5d9c08fc` before this rewrite, official `packages/agy-cli/index.mjs` still lacked `staleSnapshot` / `reject_stale_snapshot`, `turn.continuing`, and `O_NOFOLLOW`. Official `spilledOutput` still took a path and `realpath` and was not bound to the current session. Open official agy-cli pull requests, including #1551 (`0.1.140`), did not contain those four behaviors. All four were replayed as separate commits.

What this tree adds on top of official `0.1.139`:

- spilled output reads are bound to the current session, and the open uses `O_NOFOLLOW`
- a strict prefix of the recorded history is rejected (`reject_stale_snapshot:prefix`) instead of reclaiming the live turn
- on the result path, usage, the assistant reply, and `finalizeTurn` run before `message_stop`; a `tool_use` stop is unchanged
- `turn.continuing` is set before `await proc.updateTools` and cleared in `finally`

`notes/rebase-0.1.134.md` records the previous rewrite. The fork workflow runs the marker, the four behaviors above, and the official regression files that still exist (`duplicate-result-notice`, `tool-step-retry`, `tool-result-prefill`) plus `test/smoke.mjs`.

The production VPS pin `4d273930f15aeb24042c18e1bdc5d914344e3f70` stays fetchable as tag `prod-vps-agy-cli-4d273930-20261125`. This rewrite does not deploy, and `deploy/fork-rollout.sh` still performs no copy and no restart. Its `--execute` check now requires base `0.1.139`.
