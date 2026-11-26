> Historical note. This rewrite landed on official `0.1.134` (`d8e0ed71`). Current fork base is `0.1.139-fork.1` on `5d9c08fc`. See `rebase-0.1.139.md`.

# agy-cli fork rebuilt on official 0.1.134

This fork's `main` was rewritten onto official `magpie-community/plugins` `main` at `d8e0ed71bdcffc2c9201110575d0c967fd57b02e` (`@magpie-community/opencode-agy-cli-auth` `0.1.134`). The packed version is `0.1.134-fork.1`. It does not claim official `0.1.135`. `notOfficialRelease` is true.

The older notes in this directory describe the pre-rewrite fork (0.1.116 through `0.1.121-fork.1`). They are history, not the current base. Behavior that official `0.1.134` already has was not replayed: raw tool-result identity (0.1.129), identical tool_result step replay (0.1.131), AgentSummary scope (0.1.127), and cross-account `sameAccount()` (0.1.133).

What this tree adds on top of that base:

- spilled output reads are bound to the current session
- a strict prefix of the recorded history is rejected instead of reclaiming the live turn
- a finished turn is recorded and released before `message_stop`
- `turn.continuing` covers the `await proc.updateTools` window

`owner-acceptance.mjs` from the old fork is not on this base. Those cases covered behavior official main already has. The fork workflow runs the marker, the four behaviors above, and the official regression files that still exist (`duplicate-result-notice`, `tool-step-retry`, `tool-result-prefill`) plus `test/smoke.mjs`.

The production VPS pin `4d273930f15aeb24042c18e1bdc5d914344e3f70` stays fetchable as tag `prod-vps-agy-cli-4d273930-20261125`. This rewrite does not deploy, and `deploy/fork-rollout.sh` still performs no copy and no restart. Its `--execute` check now requires base `0.1.134`.
