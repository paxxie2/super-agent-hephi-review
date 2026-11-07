# P8 插件部署记录（2026-11-07，实验宿主 B）

按用户授权由 Agent 代操作，在实验实例 B（`http://127.0.0.1:3083`）执行一次真实部署。
记录文件（本机）：`/Users/zm/dsh-instances/experiment/logs/deploy-20261107T035710.json`。

## 流程与实测

| 步骤 | 结果 |
| --- | --- |
| 部署前状态 | `paused=false`、`running=0`、`queued=0`、runtime `ready` |
| 暂停 | `POST /orchestrator/api/executor/pause {"paused":true}` → `{"paused":true}`，负载保持 0/0 |
| 构建 | `pnpm install --frozen-lockfile && pnpm check`（插件目录 `<instance>/hephi-review/hephi`）→ 175 tests 通过、tsdown 构建完成（**该轮时点**；当前为 20 文件 / 202 tests） |
| 重启 | 终止旧 host.pid → 调用 `start.sh` → 新 pid `95434` |
| 实载回读 | 状态 API `ready`；**插件版本回读仍无入口**（`docs/g1-host-probe.md` 已记录“不具备”） |
| 部署记录 | `repoHead=185f5e96f4762284ef0a163ac563051c6f5a2146`；before/after 均为 `running=0, queued=0, paused=true, runtime=ready` |
| 恢复 | `POST executor/pause {"paused":false}` → 10 项 health 全 `ready`、`paused=false` |

## 不可变构建与回滚（2026-11-07 第二轮）

部署脚本增加：部署前快照当前 `lib` → 构建 → 发布不可变构建 `<releases>/<sha>/lib` + `meta.json` → 重启；`--rollback` 恢复最近快照并重启。

实测三轮（B 实例，暂停状态下）：

| 轮次 | 动作 | 结果 |
| --- | --- | --- |
| 1 | 部署 | 快照 `live-20261107T042937`（入口 `54bce386…`）；发布 `releases/hephi/dde783a…`（入口 `a9f7dbfe…`）；重启 ready |
| 2 | `--rollback` | 恢复快照，入口回到 `54bce386…`，重启后 `runtime=ready` |
| 3 | 再次部署 | 快照 `live-20261107T043051`，重新发布 `dde783a…`，入口回到 `a9f7dbfe…`；恢复后 10 项 health 全 `ready`、`paused=false` |

记录（本机）：`logs/deploy-20261107T043029.json`、`logs/rollback-20261107T043045.json`、`logs/deploy-20261107T043140.json`。
回滚失败保护：脚本先备份回滚前 `lib`，健康检查失败则恢复该备份并保持暂停（本轮未注入故障验证）。

## 升级前置：进行中 Ticket 保护（2026-11-07）

部署脚本在暂停/排空检查之后新增“进行中 Ticket”保护：`GET /orchestrator/api/tickets?state=open` 计数 >0 时拒绝升级，需显式 `--allow-open-tickets` 才跳过（对应 P5“有进行中赫菲工单时禁止升级”）。

实测（B 实例暂停状态下）：存在 3 个进行中 Ticket → 不带 flag 输出“仍有 3 个进行中的 Ticket，禁止升级”；带 `--allow-open-tickets` → dry-run 检查通过；随后恢复实例，health 全 ready。

## 全量健康门禁缺口（历史事实保留，R4 追记）

`logs/deploy-20261107T054720.json`（`at = 2026-11-06T21:47:20Z`，release `fba676e89ee19b2cbcf685cdb8b2a350504021fc`，用于 P11 smoke 重启）的 `after.health` 中 **`github.state = "starting"`**（其余 9 项 ready）。当时脚本只以 `health.runtime.state == ready` 判成功，因此该次部署仍按成功结束——这是**原始事实，保留不改**，也正是独立复核 F1.3 指出的健康门禁缺口。

| 项 | 值（原始记录） |
| --- | --- |
| 记录文件 | `/Users/zm/dsh-instances/experiment/logs/deploy-20261107T054720.json`（评审副本：`external-review/evidence/logs/`） |
| `github.state` | `starting`（detail 为空） |
| 其余 health | runtime/relay/notice/launch/delivery/assessment/reply/evals/models 均 `ready` |
| 脚本判定 | 成功（旧脚本只看 `runtime`） |

## R3：不可变部署、自动回滚与全量健康门禁

### 假宿主验证（原实现时点通过，提交 `0d58bc3`；**独立复核判定不通过**）

`scripts/host/deploy-hephi.sh` 已由 R3 重写：`--host-version` 必填（单行非空）、`git archive <sha>` 到独立临时目录构建、`releases/<sha>/` 不可变（`.incoming-<sha>-<pid>` + 校验 + 原子 `mv`）、`$hephi/lib` 用同文件系统临时 symlink 原子 rename 切换、10 项全量健康门禁（`runtime relay notice launch delivery assessment reply evals models github`，`starting`／`error`／缺失均失败）、切换后失败自动恢复 previous 并再次全量健康检查、失败两次保持 `paused=true`、`--allow-open-tickets` 作为未知参数拒绝、drain 字段缺失按 `unverified` 拒绝。

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 假宿主 R3-T01–T17（含清单外 R3-T07b） | 原实现时点 **PASS: 44 assertions**，退出 0；`real 50.22s`（实现者）／`49.55s`（R4 复核）。**该结果不能证明 R3 通过**：独立复核新增 5 组负例全部复现缺陷 | `scripts/host/test-deploy-hephi.mjs`；44 条断言原文见 `docs/remediation-r3-validation.md` §5 |
| vitest 入口 | 1 passed，约 `50s` | `hephi/tests/control/deploy-script.test.ts` |
| 指定的全量测试 | **20 文件 / 202 tests passed**（Node `v22.19.0`、pnpm `11.7.0`） | 本轮复跑；时点链见 `docs/implementation-index.md` §6.1 |
| 独立复核 | **Request changes**：R3 不通过（R3-F1–F6）；PR #20 不批准合并，不得进入 R3.7 | `external-review/PR20-independent-review.md`（仓库外） |
| 返修后套件（含 N1／N1b／N2／N3／N4／N5，提交 `2409613`） | **`PASS: 69 assertions`，FAIL 0，exit 0**；`real 84.23s`（Lead 复跑；实现者 `83.15s`／`83.35s`）；Node `v22.19.0`／pnpm `11.7.0`。构成：主套 46 + 负例 23 | `scripts/host/test-deploy-hephi.mjs`；登记见 `docs/remediation-r3-validation.md` §9 |
| 返修后全量测试 | **20 文件 / 202 tests passed**；`deploy-script.test.ts` 1 test 约 `85.7s`（假宿主门禁等待变长，属预期；不新增测试文件） | `cd hephi && pnpm test`（Node `v22.19.0`／pnpm `11.7.0`）；`pnpm check` 构建段待干净树复跑 |
| 旧提交对照（新套件 × `17d3827`，独立克隆 `/tmp/pr20-verify-old`） | **exit 1；PASS 50 / FAIL 19**；复跑 FAIL 集合逐条一致 → **negative direction 成立**（旧实现不能通过新负例） | `external-review/evidence/pr20-fix/`（仓库外：`old-commit-negative-fails.log`、`.run2.log`、`fail-list.txt`、`README-phase1.md`、`artifact-hashes.txt`）；逐组 FAIL 见返修登记 §3.2 |

### 复核发现与返修（2026-11-07，提交 `2409613`）

独立复核发现原脚本 6 个缺陷，已按条返修（逐条根因、负例与行为差异见 [`docs/remediation-r3-validation.md`](remediation-r3-validation.md) §9）：

| 复核缺陷 | 原行为（旧脚本） | 返修后行为 | 对应负例 |
| --- | --- | --- | --- |
| **F1 普通 `lib` 目录首迁 EISDIR** | 旧 `$hephi/lib` 是普通目录时，`set_pointer()` 直接 `renameSync` symlink → `EISDIR`，exit 1，部署无法完成 | **普通目录迁移事务**：先把旧目录原子 `mv` 到 `$hephi/.migration-<UTC>-<pid>`，再 rename 新 symlink；第二步失败则把旧目录 `mv` 回原位、删临时 symlink、非零退出并写 `failed-pointer` 记录（带 `migration` 备份路径） | N1（成功 + 备份保留旧内容）、N1b（第二步失败恢复旧目录） |
| **F2 rollback 隐式 HEAD** | `target` 先被默认成 `git rev-parse HEAD`，再做 rollback 参数检查 → 缺 `--target` 也 exit 0 并切到 HEAD | `target_set`／`previous_set` 标记；**任何 HEAD 默认值之前**校验：rollback 必须有显式 `--target` 且为完整 40 位 SHA，`--previous` 若给出也须完整 SHA；否则非零退出且指针/进程/记录零副作用 | N2（缺参、空值、非法 SHA 均拒绝并无副作用） |
| **F3 无恢复却记 restored** | 无论是否执行恢复都写 `failed-restored-previous` 并输出 `previous build restored`；rollback 恢复用 `current` 而非显式 `previous`，记录 `previous` 常为空 | 拆成 `failed-no-previous`／`failed-restored-previous`／`failed-twice`；**rollback 显式 target 语义**：恢复目标 = 显式 `--previous`（已 `release_validate`）否则通过校验的 `current`，两者皆无只记 `failed-no-previous`；只有指针真恢复 + 全量健康通过才写 `failed-restored-previous` | N3 |
| **F4 恢复 rename 失败绕过双失败** | 恢复 `set_pointer` 无错误捕获，`set -e` 下 rename 失败直接以原始码（负例 42）退出，零记录、指针停在失败目标 | 所有 `set_pointer` 调用 `if ! set_pointer ...` 捕获；恢复失败写 `failed-twice`（含 `targetFailure` + `restoreFailure` 真实错误）后非零退出 | N4（注入第 2 次 rename 失败） |
| **F5 paused 硬编码 true、健康证据缺失** | `record()` 无条件 `paused:true`；双失败写 `health:"not-checked"` | **真实 paused 回读**：`record()` 写盘前 `read_state`，保存真实 `paused`（读不到为 `unverified`）、`load`、`healthReadback`；成功/回滚成功后 `paused_now()` 复核，非 `true` 写 `failed-not-paused` 并非零退出 | N5（假宿主真实返回 `paused=false`）；主套 T17/T08 记录真实性断言 |
| **F6 current 校验被忽略** | `[ -n "$current" ] && release_validate ... \|\| true` 吞掉失败，校验不过的 current 仍可能被当恢复目标 | 单独计算 `current_valid`；恢复 current 必须 `current_valid=yes`，显式 `--previous` 先校验 | **无专属动态负例**（静态保证，标 unverified-by-test） |

**双失败证据字段**（返修后记录中用于“保留现场”的字段，`record()` 统一写入）：

| 字段 | 含义 |
| --- | --- |
| `targetFailure` | 目标阶段（切换/重启/健康）最后一次可读宿主状态或错误摘要 |
| `restoreFailure` | 恢复阶段真实失败原因（如 `pointer restore to <path> failed`） |
| `restoreHealth` | 恢复阶段全量健康结果（成功恢复时为 `all-required-ready`） |
| `paused` / `load` / `healthReadback` | 写记录时的真实宿主回读；不可读为 `unverified`（不再硬编码 `true`） |
| `pointerBefore` / `pointerAfter` / `migration` | 切换前后指针与普通目录迁移备份路径，便于人工接管 |

> 返修改 3 文件（提交 **`240961395ce0fb323683bab21830fbdc123257d8`**，父提交 `17d3827`）：`scripts/host/deploy-hephi.sh`、`scripts/host/test-deploy-hephi.mjs`、`hephi/tests/control/deploy-script.test.ts`（wrapper 断言 44→69），**未在真实宿主执行任何部署/回滚**。双向均已实测：修复提交上 69 断言全绿 + 全量 `pnpm test` 20 文件 / 202 tests；旧提交上 `PASS 50 / FAIL 19`。**`pnpm check` 的 typecheck+test+build 最终输出`cd hephi && pnpm check` → **exit 0**：`tsc --noEmit` 通过、`vitest run` **20 文件 / 202 tests passed**、`tsdown` 构建成功（`Build complete in 2943ms`）；Node `v22.19.0`、pnpm `11.7.0`，在隔离克隆 `/tmp/hephi-lead-check` @ `2409613` 上执行（原始输出：`external-review/evidence/pr20-fix/lead-clean-tree-pnpm-check.log`）。**
>
> 旧提交实测的重要细节（不得省略，**按日志区分两个时点，不得混写**）：N1 复现 `EISDIR`（与复核一致）；**N4 的退出码有两个不同时点的日志**——早期改前快照日志（`external-review/evidence/pr20-fix/old-commit-negative-fails.log`、`.run2.log`，2026-11-07T07:35/07:40）中 N4 为 **`exit 0` + 写 `result:"ok"`**（恢复分支未被走到）；而**最终套件日志**（`old-commit-final-suite.log`、`old-commit-final-4664e96-suite.log`、`old-commit-final-7f50c13-suite.log`）中 N4 为 **`code=42`**（`FAIL N4 recovery rename failure exits nonzero without raw 42 :: code=42`）——两者都说明旧实现无法通过 N4 断言；19 FAIL 总数不受此更正影响。N5 旧脚本在假宿主真实 `paused=false` 时仍 exit 0 并输出 `deploy complete`、记录硬编码 `paused:true`。
>
> **本次只关闭复核 R3-F1–F6 与 N1–N5 自动化**：R3.7 真实宿主（A→B→A、实载 commit 回读、真实故障注入、真实 drain 语义）在此时点仍未验证（2026-11-07 09:18 已尝试 → **blocked**，见下方“真实宿主验收”节）；**P8 仍为部分**；PR #20 已于 2026-11-07 合并为 `main@bc3386cd65fee16b1777294929389db5a710bb29`（PR #20），其后 PR #21（`5b6fb6e`）与 PR #22（`8fd199d`）已合并，**审查基准 `main@8fd199d`（PR #23 合并后以 `git log` 为准）**。

### 真实宿主验收（2026-11-07 09:18 已尝试 → **blocked**，未通过）

2026-11-07 09:18（Asia/Shanghai）对宿主 B（`http://127.0.0.1:3083`，pid `29031`）执行了 R3.7 的暂停→排空→部署尝试→恢复流程。**部署在排空门禁被 fail-closed 拒绝，未发生构建、指针切换或重启**，因此 A→B→A、故障注入回滚等项仍无法执行。**R37 独立复核（2026-11-07，审查 `8fd199d`）确认该 blocked 判定正确**（报告 §5）：脚本拒绝与既定方案一致，不是“脚本过严”；且即使排空解阻，2 个 open Ticket 也会在下一道门禁拒绝。

| 项 | 状态 | 说明 |
| --- | --- | --- |
| R3.7 第 2 项：暂停 + 真实排空 | **部分（blocked）** | 暂停 1s 内生效（`paused=true`、load `0/0`、10 项 health ready）；但真实 `load` API 只有 `running/queued/maxWorkers`，其余 5 个排空字段不存在 → 脚本拒绝升级（见下行） |
| R3.7 第 3–5 项：A→B→A、实载回读、故障注入 | **未执行（blocked）** | 被排空门禁阻断；未构建/未切换/未重启（副作用核对：host.pid 不变、releases 数 6、logs 数 8、`hephi/lib` 类型与树哈希不变） |
| 真实部署尝试（dry-run，target `main@5b6fb6e`） | **exit 1（预期 fail-closed）** | 输出：`unverified drain field: startupReservations; …effects; jobs; subagents; unknown` → `drain check failed; refusing to upgrade`；证据 `external-review/evidence/r3.7-real-host/deploy-attempt.txt` |
| 进行中 Ticket 门禁（下一道） | **存在 2 个 open Ticket** | `b3a7d823…`（person/answer）、`24983dd7…`（person/failed）；即使排空通过也会拒绝升级（无 `--allow-open-tickets` 绕过） |
| drain 真实 API 字段语义 | **未验证** | 实测真实 API 不提供 `startupReservations/effects/jobs/subagents/unknown`；脚本按 `unverified` 拒绝，不按 0 |
| 真实 `hostVersion` 取值来源 | **未验证** | 无固定宿主版本快照定义；本轮尝试仅用实验性标识 `dsh-0.2.1-rc.5+composed-config-4b20291e9ba9`（dsh 版本 + `logs/composed-config.yml` sha256 前缀），**未被采纳为正式语义** |
| 真实宿主上的普通 `lib/` 目录迁移 | **未验证** | 真实实例 `hephi/lib` 当前仍是普通目录（非 symlink），迁移会在首次真实部署时发生；本轮未执行 |
| 恢复派发 | **已完成** | 2026-11-07T01:18:09Z `{"paused":false}` → 1s 内 `paused=false`、10 项 health 全 ready、load `0/0`；证据 `resume.txt` / `state-after-resume.json` |

**额外发现与纠正（如实记录）**：本轮 PR 验收在 `<instance>/hephi-review/hephi` 里跑过 `pnpm check`，而该目录正是宿主 profile link 的实载插件目录，构建改写了其 `lib/`；宿主进程 05:47:12 启动后未重启，导致**磁盘 lib ≠ 已部署 release**（磁盘 index.mjs `5ff4b59b…`，release entry `fe404c0d…`）。已把被重建的 lib 移到 **仓库外** `/Users/zm/dsh-instances/experiment/evidence/live-lib-rebuilt-20261107T011829Z`（保留审计；若留在仓库内会成为未跟踪文件，实测会触发 R2「refusing to build from a dirty working tree」），并从 `releases/hephi/fba676e…/lib` 恢复：恢复后 live `lib/index.mjs` = `fe404c0d…`，live lib 树哈希 = release 树哈希 = snapshot 树哈希 = `10b49b7b…`，宿主 health 不变。**该事件再次说明文件哈希 ≠ 实载 commit**（宿主无实载回读入口）。

**R37 复核对本节的边界确认（§6）**：磁盘哈希证据成立，但**不能扩大为“运行中的插件已恢复到该 commit”**——宿主没有实载版本回读，且进程未因这次复制而重启；恢复时宿主为 `paused=false`，“移动旧目录 + 从 release 复制”是**非原子**过程，不能作为标准回滚步骤；健康回读不能排除复制窗口内的动态加载风险。运维整改建议（R37 §6）：开发工作树与实载目录彻底分离（禁止在实载工作树跑 `pnpm check`/`build`）、实载只指向已校验不可变 release、若必须恢复先暂停排空停宿主后原子切换、保留“实载 commit unverified”直到宿主提供版本查询入口。**本节即本轮不在工作树运行 `pnpm check`/`pnpm build` 的原因。**

证据目录：`/Users/zm/Documents/kimi/tasks/2026-11-07/02-08-22-85063b14/external-review/evidence/r3.7-real-host/`（`README.md`、`preflight.txt`、`state-before.json`、`state-paused.json`、`deploy-attempt.txt`、`resume.txt`、`state-after-resume.json`、`live-lib-restore.txt`）。

> 本文件上方全部真实部署记录（`03:57`、`04:29`–`04:31`、`05:47`）均为 **R3 之前的旧脚本**行为，不代表 R3 结论。P8 真实验收在 R3.7 完成并保存原始输出前保持**未通过**；R3 返修（假宿主 N1–N5 已双向实测）**不改变 P8 仍为部分**。

### R3.8 复核返修（2026-11-07，提交 `cfb5a18`，待二次独立复核）

R37 独立复核（审查 `8fd199d`）在 69 断言之外动态复现 3 个失败语义缺陷（X1 双失败仍称 kept paused；X2 恢复阶段复用目标状态；X3 旧目录恢复失败仍称 restored/preserved），并验证 P1–P3 行为正确但当时只在仓库外测试。**返修提交 `cfb5a187ad950170b1900b302c0d1f54530f3fe0`**（父 `8fd199d`；3 文件 +265/−39）已完成：

| 项（实测） | 结果 | 证据 |
| --- | --- | --- |
| 扩展套件 | **97 断言** = 原 69（未改未删）+ 新 28（X1 5／X2 7／X3 7／P1 3／P2 2／P3 4）；`cfb5a18` 上 **PASS: 97 assertions、exit 0**（r38-tests `2m12.4s`／`2m13.7s`，Lead `real 133.24s`） | `external-review/evidence/r3.8/` |
| 旧实现对照 | `8fd199d` × 新套件（独立克隆）→ **exit 1、10 FAIL，全为 X1–X3 断言**；原 69 + P1–P3 全 PASS | `old-8fd199d-suite-10fail.log` |
| 完整 `pnpm check` | 隔离克隆 `/tmp/hephi-r38-fix` @ `cfb5a18` → **exit 0**：20 文件 / 202 tests、`Build complete in 1840ms`；`git diff --check 5efd708..cfb5a18` exit 0 | `fix-cfb5a18-pnpm-check-and-suite.log` |
| 二次独立复核 | **未做（待外部复核）**：R37 报告是上一轮、不能替代对 `cfb5a18` 的复核 | — |

**结论边界**：本轮只关闭 X1–X3 的假宿主自动化与 P1–P3 自动化，**不等于 R3 或 P8 真实验收通过**；真实宿主 A→B→A、实载 commit 回读、真实 drain 5 字段、正式 hostVersion、open Ticket 解阻、二次独立复核**全部未完成**。**R3.7 不重启、P8 不得记 done。** 逐条根因、§8 门槛对照与未验证边界见 [`docs/remediation-r3-validation.md`](remediation-r3-validation.md) §12。

## 已证明 / 未证明

- 已证明：暂停→构建→重启→状态恢复的真实链路；构建产物时间 `03:57`；实例以新进程运行且监听正常。R3 的**脚本机制**只由假宿主证明（原 44 断言 + 返修后 69 断言全绿，全量测试 20 文件 / 202 tests）；**这不等于真实宿主验收**。
- 未证明：**实载插件 commit**（无回读入口，只能确认进程/构建产物时间与 live lib 入口 sha256，不能确证加载了哪个 commit）；**竞态 Trigger**（本记录未创建新 Issue 测试；后由 `docs/p8-race-record.md` 单独验证，结论 partial）；**故障注入下的自动恢复**（假宿主原 T08–T10 与返修 N1b/N3/N4/N5 只证明脚本机制，**真实宿主未验证**；R37 追加的 X1–X3 表明部分失败语义仍需返修，已由 R3.8 `cfb5a18` 修复（假宿主），待独立复核）；**全量健康门禁**（假宿主覆盖，**真实宿主未验证**；旧脚本只看 `runtime`，`deploy-20261107T054720.json` 已记录 `github=starting` 仍判成功）；**普通 `lib/` 目录首迁事务**（返修 N1/N1b 仅在临时夹具验证，**真实实例 `hephi/lib` 是普通目录（plain-directory，非 symlink）**，真实旧布局迁移未执行）。
- 已知限制：重启窗口内服务不可用；本记录中的 `lib` 切换在停机状态下用 `mv` 完成，非热切换（R3 改为 release 目录 + 版本指针，尚未验收）；`meta.json` 只有 sha256，没有签名；R3 原实现被独立复核判定不通过（F1–F6），返修提交 `2409613` 已关闭 F1–F6 并补 N1–N5；**R37 二次独立复核（2026-11-07，审查 `8fd199d`）确认 F1–F6 直接修复有效、69 断言独立复跑通过，但新发现 X1–X3 失败语义缺陷 → R3.8 返修提交 `cfb5a18`（97 断言、双向实测）已完成，待对 `cfb5a18` 的二次独立复核**；R3.7 仍 blocked。
- 状态口径：**P8 仍为部分（未通过）**。假宿主套件（含返修负例与 R3.8 新增用例）即使全绿也不等于 R3.7 真实宿主验收。
- 备注：脚本新增 `--hephi`/`--repo` 以适配本机 `<instance>/hephi-review` 布局（提交 `185f5e9`）。

## T1 发布依赖与插件激活门禁（issue #26，2026-11-07）

本节记录**脚本机制**与假宿主自测；**未在真实宿主执行部署**（本任务只提交 PR，由主助手在候选 SHA 上重新部署验收）。

### 实现

- 发布包依赖：`build_release` 在 `pnpm install --frozen-lockfile && pnpm check` 后用**同一冻结 lockfile**
  执行 `pnpm install --prod --frozen-lockfile --offline`，把生产依赖 `node_modules`、`package.json`、
  `pnpm-lock.yaml` 一起放进 incoming；不依赖源码工作区 `node_modules`。
- peer 解析显式化：新增 `--peer-root <dir>`。声明的 peerDependencies 只在 incoming 内链接到宿主
  peer 根；若生产安装已放入同名包（autoInstallPeers/同时是生产依赖），**只在 incoming 内替换**该入口，
  不改构建目录/宿主，并在 `meta.dependencies.peersReplaced` 记录。
- 停机前导入探针：新增 `--node <宿主 Node>`；在目标 release 路径实际 `import index.mjs/tools.mjs`，
  校验所有生产依赖与 peer 可解析、`describePlugin().commit` 等于目标 SHA；失败发生在停机前并删除 incoming。
- 激活标识：两个 bundle entry 在注册完成后各写一行
  `[hephi-activation] entry=<index|tools> plugin=… commit=<sha> pid=<pid>`。
  部署记录启动前 `host.log` 偏移，健康 ready 后只认该偏移之后、新 host.pid、目标 SHA 的两条标识；
  缺失任一 → `activation-missing`，走既有恢复/回滚。
- 回滚边界：旧格式 meta（无 `entries/dependencies/activation`）按历史字段校验，启动按 health-only，
  记录 `activation=unverified-legacy`、`importProbe=skipped-legacy`；新格式 meta 缺少 activation
  **fail-closed**（拒绝，不静默退回 health-only）。
- meta 新增 `entries{index,tools}`、`activation`、`dependencies{lockfileSha256,nodeModulesSha256,resolved,peers}`、
  `node{command,version}`；`release-meta.mjs check` 重新计算入口/依赖树哈希与 peer 目标可用性。

### 自测（假宿主，聚焦）

`scripts/host/test-deploy-hephi.mjs` 扩展为 **174 断言全绿**（原 142 + T1 32），套件明确标注为假宿主；
`hephi/tests/control/deploy-script.test.ts` 同步断言 174 并把超时提高到 900s。新增场景：

- T1-A/T1-B：健康 10 项 ready 但缺任一激活标识 → 目标失败、恢复旧版本、记录 `targetFailureKind=activation-missing`；
- T1-C：旧格式 release 回滚成功并记录 `unverified-legacy`；
- T1-D：release 导入时缺运行依赖 → 停机前拒绝，宿主/指针不变、无发布；
- T1-E：package.json 声明未写入冻结 lockfile 的依赖 → 构建阶段拒绝；
- T1-F：声明 peerDependencies 但无 `--peer-root` → 停机前拒绝；
- T1-G：生产安装已包含同名 peer 时，只在 incoming 内替换为显式宿主 peer 链接，宿主版本生效；
- T1-H：新格式 release 缺 activation 元数据 → 拒绝，不回退 health-only。

真实 `pnpm --prod` 实测（本机 store，离线）：对本仓库真实 package，peer 包（`@deepseek-ai/*` 同时是
devDependencies）在 `--prod` 后**不存在**于 `node_modules`；因此真实部署仍需显式 `--peer-root`
（实验宿主 B 的宿主 peer 根为 `/Users/zm/dsh-instances/runtime/node_modules`）。T1-G 专门覆盖
“路径已存在”的边界。

### 状态口径

- 已证明：发布包依赖/peer/导入/激活/回滚边界的**脚本机制**（假宿主 + 真实 pnpm 离线安装）；
- 未证明：真实宿主上的重新部署、实载 pluginCommit 回读与激活标识采集（本任务不执行部署）；
  P8/R3.7 结论不变，仍为部分。
