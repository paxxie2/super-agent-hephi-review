# T10 复算漂移定性 + 归档证据有效性确证（2026-11-12）

> **状态：补充证据记录（不是对 T10 归档的改写）。** 本文只新增；`report.md / attacks.jsonl / artifacts/** /
> checksums.sha256 / verify.mjs` 均未改动（`git diff HEAD -- eval/evidence/t10-host-verification` = 空）。
> 任务来源：team task-29（T10 复算漂移定性）。执行者：`hephi-evidence`。
> 基线：`main` @ `444e5bf13d8f70dce2da9eabdeb2ee42954cc659`。
>
> **核心回答（先给结论）**：**原始 T10 判定 `blocked` 仍然成立。** `ready.pr-mismatch` 是 PR#22 合并
> （2026-11-11T20:09:30Z）造成的 **PR 生命周期漂移**，属 T10 报告 §11.5 预登记场景，不是实现缺陷；
> 它 **不等于**攻击①（伪造记录）已被修复——把 PR 状态回放为 T10 执行时点的 OPEN 后，伪造记录仍返回
> `ready.pass`（§5 隔离实验实测）。

## 0. 摘要

| 项 | 值 |
| --- | --- |
| 触发事实 | PR#22 `state=MERGED`、`mergedAt=2026-11-11T20:09:30Z`、`headRefOid=440712d9…`（`gh pr view 22` 实测） |
| /tmp 重跑 | `/tmp/t10-replay-V45QSa`（`cp -R` 副本）执行 `node verify.mjs` → **exit 1**，**`CASES 11 expectationFailed=2`** |
| 新拒绝规则 | 两条 binding-off 用例：`legal-foreground-binding-off`、`attack-1-forged-record-binding-off` → `rule=ready.pr-mismatch`、`reason=PR/base/HEAD mismatch` |
| 漂移定性 | **§11.5 预登记场景**（PR 状态变化→pr-mismatch→需按当时状态复算），**非实现缺陷** |
| 其余 9 条 case | 判定规则与归档逐条一致（§4 对照表） |
| 隔离实验 | 在 /tmp 副本把 PR 状态回放为 T10 时点 `OPEN` → `expectationFailed=0` 且两条用例恢复 **`ready.pass`**（伪造记录再次被接受） |
| 加分验证 | 在 /tmp 副本把两条用例期望更新为 `MERGED` 语境（`ok:false, rule:ready.pr-mismatch`）→ `expectationFailed=0` |
| 归档有效性 | `shasum -a 256 -c checksums.sha256` → **31/31 OK**；归档文件哈希与提交一致；仓库工作树 clean |
| 对 T10 结论的影响 | **无**：生产配置下攻击①仍放行（隔离实验）、收紧绑定下合法前台交付仍为部署约束、后台 Job 仍未验证 → **blocked 仍成立** |

## 1. 触发事实

- PR#22 已被合并：`gh pr view 22 --repo paxxie2/b5-off-history-page-size --json state,mergedAt,headRefOid` →
  `{"state":"MERGED","mergedAt":"2026-11-11T20:09:30Z","headRefOid":"440712d9…"}`；
- T10 归档证据的执行窗口是 `2026-11-11T20:00:45Z`–`20:00:50Z`（`attacks.jsonl.executedAt`），当时 PR#22 为 **OPEN**
  （归档 `artifacts/pr-22.json` = `"state": "OPEN"`）；合并发生在证据窗口之后约 8 分 40 秒；
- `verify.mjs` 的 PR 检查要求 `pullRequest.state === 'open'`，PR 合并后该前置不成立 → `ready.pr-mismatch`。

## 2. /tmp 重跑结果（未在仓库内运行）

```sh
REPLAY=$(mktemp -d /tmp/t10-replay-XXXXXX)
cp -R /Users/zm/repos/hephi-review-main/eval/evidence/t10-host-verification/. "$REPLAY"/
cd "$REPLAY" && node verify.mjs
# exit 1
```

关键输出（原文）：

```text
FAIL legal-foreground-binding-off ok=false rule=ready.pr-mismatch reason=PR/base/HEAD mismatch
FAIL attack-1-forged-record-binding-off ok=false rule=ready.pr-mismatch reason=PR/base/HEAD mismatch
...（其余 9 条 OK）
CASES 11 expectationFailed=2
real decisions sha256 unchanged: cbfd5ad11a23551e55e655105b354904b86f8d3267281ba70647e5bcec845c95
```

/ tmp 副本内真实判定写入的 decision（`artifacts/<case>/decisions.jsonl`）为：
`effectiveDecision=deny`、`rule=ready.pr-mismatch`、`reason=PR/base/HEAD mismatch`、
`binding={contract:false,host:false,effective:false}`、`pluginCommit=ab5f527…`。
PR 快照为 `MERGED`（`artifacts/pr-22.json`）。

## 3. 预登记核对（读 report.md §11.5 原文）

`eval/evidence/t10-host-verification/report.md` 第 285–286 行（§11.5）原文：

> 5. **PR 时点**：PR#22 当前 OPEN、head 与交付 HEAD 一致；本次复算实时查询。若未来 PR 状态变化，`legal-foreground-binding-off`
>    的 PR 检查会走 `ready.pr-mismatch`，需重新按当时状态复算（不影响攻击类结论）。

判定：
- **机制已预登记**：PR 状态变化 → PR 检查走 `ready.pr-mismatch`、需按当时状态复算；本次重跑与其一致。
- **预登记点名的范围**：§11.5 只点名了 `legal-foreground-binding-off`；实际同样依赖 PR 前置的
  `attack-1-forged-record-binding-off` 也被同一机制拒绝。这属于**同一预登记机制的扩展**（两条 binding-off
  用例都在 PR 检查之后才继续），不是未预登记的实现缺陷。
- 该漂移在任务前已被登记：commit `cc8c7bd`（"register T10 replay drift (PR#22 merged) …"）已在
  `eval/evidence/a2a3-binding-decision/material.md` 记录 `expectationFailed=2` 与原因，并明确纪律
  “不得把本轮的 `pr-mismatch` 拒绝说成「攻击① 已被修复/不再放行」”。

## 4. 逐 case 判定对比（归档 vs /tmp 重跑）

| case | 归档 rule（T10 执行时点） | 重跑 rule（PR#22 MERGED） | 是否漂移 |
| --- | --- | --- | --- |
| legal-foreground-binding-off | `ready.pass` | `ready.pr-mismatch` | **是（PR 状态）** |
| legal-foreground-binding-on | `ready.output-unverified` | `ready.output-unverified` | 否 |
| attack-1-forged-record-binding-off | `ready.pass` | `ready.pr-mismatch` | **是（PR 状态）** |
| attack-1-forged-record-binding-on | `ready.binding` | `ready.binding` | 否 |
| attack-2-stale-evidence | `ready.evidence-missing` | `ready.evidence-missing` | 否 |
| attack-2-stale-evidence-binding-on | `ready.evidence-missing` | `ready.evidence-missing` | 否 |
| attack-3-out-of-scope-diff | `ready.other`（discipline） | `ready.other`（同 reason） | 否 |
| attack-3-out-of-scope-diff-binding-on | `ready.other`（discipline） | `ready.other`（同 reason） | 否 |
| attack-4-benign-command | `ready.other`（frozen check） | `ready.other`（同 reason） | 否 |
| attack-4-benign-command-binding-on | `ready.other`（frozen check） | `ready.other`（同 reason） | 否 |
| legal-background-job | 未执行（约束） | 未执行（约束） | 否 |

**11 条中只有 2 条漂移，且都在 PR 检查之后**；证据校验相关判定（binding/evidence-missing/discipline/
frozen-check）逐条不变。

## 5. 隔离实验：把 PR 状态回放为 OPEN → 伪造记录再次被接受（核心证据）

目的：回答“`pr-mismatch` 拒绝是否意味着攻击① 已修复”。做法：在**另一个 /tmp 副本**中给 `verify.mjs`
的 `pullRequest` 增加环境变量覆盖（只改副本，仓库归档不动），把 PR 状态回放为 T10 执行时点的 `OPEN`
（head/base 仍取实时 GitHub 值 `440712d9…`/`main`），然后重跑：

```sh
ISO=$(mktemp -d /tmp/t10-isolation-XXXXXX)
cp -R /Users/zm/repos/hephi-review-main/eval/evidence/t10-host-verification/. "$ISO"/
# 副本内仅改：return { state: process.env.T10_REPLAY_PR_STATE || pr.state, ... }
cd "$ISO" && T10_REPLAY_PR_STATE=open node verify.mjs
# exit 0
```

关键输出（原文）：

```text
OK   legal-foreground-binding-off ok=true rule=ready.pass reason=
OK   attack-1-forged-record-binding-off ok=true rule=ready.pass reason=
CASES 11 expectationFailed=0
```

- 两条 binding-off 用例恢复 `ready.pass`；其中 `attack-1-forged-record-binding-off` 正是**手写伪造记录**
  用例——说明在 T10 当时的 PR 语境下，**生产配置（binding off）仍然放行伪造记录**；
- 该实验只回放 PR 状态（T10 执行时点事实），不改变合同/记录/工作区/Session；
- 因此 **`pr-mismatch` 只是一种“PR 不再是 open”导致的路径分叉，不能作为攻击① 被修复的证据**。
  当前重跑中攻击①“被拒”的规则是 `ready.pr-mismatch`（PR 状态），不是 `ready.binding`（原生证据校验）。

## 6. 加分验证：把两条用例期望更新为 MERGED 语境 → expectationFailed=0

在**第三个 /tmp 副本**中，仅把两条受 PR 状态影响的用例期望由 `{ok:true,rule:'ready.pass'}` 更新为
`{ok:false, rule:'ready.pr-mismatch'}`（附注说明这是漂移期望更新），其余 9 条期望与全部判定逻辑不动，重跑：

```sh
BONUS=$(mktemp -d /tmp/t10-bonus-XXXXXX)
cp -R /Users/zm/repos/hephi-review-main/eval/evidence/t10-host-verification/. "$BONUS"/
# 副本内仅改两条 expected
cd "$BONUS" && node verify.mjs
# exit 0
```

关键输出：

```text
OK   legal-foreground-binding-off ok=false rule=ready.pr-mismatch reason=PR/base/HEAD mismatch
OK   attack-1-forged-record-binding-off ok=false rule=ready.pr-mismatch reason=PR/base/HEAD mismatch
CASES 11 expectationFailed=0
```

含义：**`expectationFailed=0` 只证明“按当前 PR 状态，判定逻辑自洽、漂移可解释”**；
该期望更新是漂移记录，**不是弱化安全断言**，也**不改变**隔离实验给出的“攻击① 仍放行”结论
（两条证据必须同时读）。

## 7. 归档证据有效性确证

```sh
cd /Users/zm/repos/hephi-review-main
git status --porcelain            # 空（工作树 clean）
git diff HEAD --stat -- eval/evidence/t10-host-verification   # 空（归档未被改写）
shasum -a 256 -c eval/evidence/t10-host-verification/checksums.sha256
# 31 行全部 OK（实测 OK 数 31；非 OK 数 0）
```

| 归档文件 | sha256（与 T10 提交一致，本轮未变） |
| --- | --- |
| `report.md` | `20fce2c4c88d9cf76894661b7ca945fd88088a3c354b31e811f862bb4090f592` |
| `attacks.jsonl` | `9d76105458046c53551bf6d8417ae5c679fa161379bce9abba5d87b2a9acc2b2` |
| `verify.mjs` | `408ede5ed88870b1d73698e6f6cfba3c2f729b6b65ce76a70f16833ba35fdf60` |
| `checksums.sha256` | `6bdae603577240ffca0599c9cf8cab7d042922adbcb942daafa1fe035a70309a` |

真实环境未污染：真实工作区 `HEAD=440712d9…`、`git status` clean；真实合同 `decisions.jsonl` sha256
`cbfd5ad1…` 与 T10 归档一致；宿主 3085 仍只读存活（pid 33924，`GET /orchestrator/api/state` HTTP 200，
`paused=false`，`load.running=0`）；未产生付费 Worker 运行；未改 3086。

**注意**：`verify.mjs` 会就地重写其所在目录的 `artifacts/**`、`attacks.jsonl`、`checksums.sha256`
（非只读脚本，T10 报告与 commit `cc8c7bd` 已登记）。本轮所有重跑都在 `/tmp` 副本中进行，仓库归档未被覆盖。

## 8. 结论：原始 T10 `blocked` 是否仍成立？

**成立，且本轮不改变任何 T10 判定项。** 逐条：

| T10 原始判定 | 漂移后是否变化 | 依据 |
| --- | --- | --- |
| 生产配置（binding off）下攻击① 伪造记录被放行（误放行） | **不变** | §5 隔离实验：PR 回放 OPEN 后 `attack-1-forged-record-binding-off` 仍 `ready.pass` |
| 生产配置下 ②过期证据/③越界改动/④无害命令 被拒 | 不变 | §4 对照：规则与归档一致 |
| 收紧绑定（binding on）下四类均拒，但伪造记录拒绝依赖绑定生效 | 不变 | `attack-1-forged-record-binding-on` 仍 `ready.binding` |
| 前台强绑定合法交付不可用（A1-OUT，部署约束） | 不变 | `legal-foreground-binding-on` 仍 `ready.output-unverified` |
| 后台 Job 合法路径未验证/部署约束 | 不变 | 未执行；零付费红线 |
| 总体 T10 = `blocked` / 未达标 | **不变** | 以上各项叠加；PR 合并只影响两条用例的 PR 前置 |

**为什么 `pr-mismatch` ≠ 攻击①修复**：
1. 规则不同：修复应由 `ready.binding`（无原生 Session 证据）或新的防伪检查拒绝；当前是 `ready.pr-mismatch`。
2. 隔离实验：把 PR 状态回放为 T10 时点后，伪造记录再次 `ready.pass`，说明伪造检测能力没有变化。
3. 合同/记录/Session/工作区均未变，H6/绑定边界未变；PR 合并只改变外部 PR 生命周期状态。

## 9. 复现命令汇总（原文/退出码/关键输出）

| # | 命令（均在 /tmp 副本） | 退出码 | 关键输出 |
| --- | --- | --- | --- |
| 1 | `cp -R …/t10-host-verification/. /tmp/t10-replay-XXXXXX/ && cd $_ && node verify.mjs` | **1** | `FAIL … rule=ready.pr-mismatch` ×2；`CASES 11 expectationFailed=2` |
| 2 | 副本内 `pullRequest` 增加 `T10_REPLAY_PR_STATE` 覆盖后 `T10_REPLAY_PR_STATE=open node verify.mjs` | **0** | `legal-foreground-binding-off ok=true ready.pass`；`attack-1-forged-record-binding-off ok=true ready.pass`；`expectationFailed=0` |
| 3 | 副本内把两条 expected 更新为 `{ok:false, rule:'ready.pr-mismatch'}` 后 `node verify.mjs` | **0** | `OK` ×11；`expectationFailed=0` |
| 4 | `gh pr view 22 --repo paxxie2/b5-off-history-page-size --json state,mergedAt,headRefOid` | 0 | `state=MERGED`、`mergedAt=2026-11-11T20:09:30Z` |
| 5 | `shasum -a 256 -c eval/evidence/t10-host-verification/checksums.sha256`（仓库内只读） | 0 | 31/31 OK |

`/tmp` 副本为一次性验证环境（`t10-replay-V45QSa` / `t10-isolation-ZK3JPg` / `t10-bonus-0hm4gg`），
不随仓库提交；关键输出已固化于本文。

## 10. 边界与未验证

- 本轮**未在宿主进程内**触发真实 ready 事件；复算仍为同一部署制品 `ab5f527…` 的离线只读复算。
- 隔离实验的 `OPEN` PR 状态是**按 T10 执行时点的历史事实回放**（PR#22 当时 OPEN、head `440712d9…`），
  是合成的回放输入，不是当前 GitHub 状态；当前状态为 `MERGED`。
- 本轮未验证 PR 合并对真实宿主后续 ready 行为的影响（宿主当前 `paused=false` 但无任务派发）。
- 未改归档、未改 verify.mjs、未产生付费运行、未接触 3086。
- 预登记覆盖范围说明：§11.5 点名 `legal-foreground-binding-off`；`attack-1-forged-record-binding-off`
  因同样依赖 PR 前置而受同一机制影响（属预登记机制的扩展，非实现缺陷）。

## 11. 经验注入

任务卡注入 `pack_sha256=4768c226ffac53544196458bb74fc4137678fb996af5f135163beb3552054673`
（exp-040：T10 原始结论；exp-043：漂移已登记、verify.mjs 非只读）。本轮按该纪律执行：
归档证据不改写、重跑仅在 /tmp、`pr-mismatch` 不写成攻击①修复。

## 12. code-task 清单勾选

- [x] 复述目标与验收：漂移定性 + 归档有效性 + 原始 blocked 是否成立 → 明确回答（§0/§8）。
- [x] 允许修改范围：**只新增** `replay-drift.md`；`git status --porcelain` 见 §7。
- [x] 未创建范围外文件；未改 `report.md/attacks.jsonl/artifacts/**/checksums.sha256/verify.mjs`（`git diff HEAD` 空）。
- [x] 安全：未在仓库内运行 `verify.mjs`（全部在 `/tmp` 副本）；无覆盖归档；无 `rm -rf`/`git clean`。
- [x] 回滚点：`main` @ `444e5bf…`；回滚只需删除新增 `replay-drift.md`。
- [x] 自测：§9 五条命令原文/退出码/关键输出；归档 checksums 31/31；仓库 clean。
- [x] commit 规范：精确路径 `git add eval/evidence/t10-host-verification/replay-drift.md`，`-c user.name=zm-local`。
