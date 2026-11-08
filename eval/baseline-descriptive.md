# T04 八指标的历史描述性基线（B5 开发试跑，2026-11-08）

> **性质声明（必读）**
>
> - 本文件是**描述性基线（descriptive baseline）**，只把仓库内已有证据整理成可比对的参考值。
> - 它**不是锚点**：锚点（含合格交付率的 86% 满分 / 60% 线性等）由 **PREREG 在 T05 锁定**，本文件不定义、不改写任何锚点。
> - 它**不进总分**：`eval/ab-metrics.mjs` 的 T04 总分只使用本批次实测值 + 锁定锚点，不读取本文件。
> - 它**不是实验结果**：8 次运行是开发试跑（`eval/evidence/b5runs/README.md` §1/§5），native/off 配对性弱（off 回退仓库、native 多收 `hephi-task` 合同块、native run1 检查口径不同），不能用于效应结论。
> - **每个数字都注明了来源文件与字段**；无法核对的写"未知/部分可知"并给原因，不补 0、不臆造。

## 1. 数据范围

| 项 | 值 | 来源 |
| --- | --- | --- |
| 任务 | `previous-window-order`（site-pnl-diagnosis，`new-feature`，base `1e166fbe…`） | `eval/evidence/b5runs/README.md` §1；`eval/B5-trial-plan.md` §2 |
| 运行 | 8 次真实开发试跑：native 4（r1–r4）+ off 4（r1–r4）；同批次 `b5-trial-20261108` | `eval/evidence/b5runs/b5-trial-20261108-{native,off}-r{1..4}.json`（8 个文件均 `schemaVersion:1`） |
| 时间 | 2026-11-07 22:35–23:35（UTC）；证据捕获时点 `2026-11-07T23:35:54Z`（native PR 状态） | 各 run 记录 `startedAt/endedAt`；`eval/evidence/b5off/native-reference.json` `note` |
| 状态 | 工具/录入验证通过；**无盲评、无正式实验结论、PR 未合并** | `eval/evidence/b5runs/README.md` §5；`eval/BACKLOG-2026-11-08.md` §1 |

8 条运行记录摘要（`runId / arm / delivery / wallClockSeconds`；全部来自 `eval/evidence/b5runs/*.json` 的 `runId`、`arm`、`delivery`、`wallClockSeconds`）：

| runId | arm | delivery | wallClockSeconds |
| --- | --- | --- | --- |
| `b5-trial-20261108-native-r1` | native | `blocked` | 231.751 |
| `b5-trial-20261108-native-r2` | native | `ready-pr-created` | 120.821 |
| `b5-trial-20261108-native-r3` | native | `ready-pr-created` | 79.542 |
| `b5-trial-20261108-native-r4` | native | `ready-pr-created` | 109.032 |
| `b5-trial-20261108-off-r1` | off | `ready-pr-created` | 129.065 |
| `b5-trial-20261108-off-r2` | off | `ready-pr-created` | 131.740 |
| `b5-trial-20261108-off-r3` | off | `ready-pr-created` | 96.226 |
| `b5-trial-20261108-off-r4` | off | `ready-pr-created` | 134.685 |

> 样本量：**n=8（native 4 / off 4）**，单任务单仓库；`timings.json` §`summary.note` 明确"n=4/组：median/p90 只是描述性统计，4 个样本不能可靠估计 P90"。T04 的 taskId 聚合（AT-60）在这些历史数据中**无法检验**：8 条记录是 1 run ↔ 1 ticket ↔ 1 task，未出现同任务多 ticket（见 §3）。

## 2. 八指标逐项基线

概览：

| # | 指标 | 结论 | 一句话摘要 |
| --- | --- | --- | --- |
| 1 | 合格交付率 | **部分可知 (b)** | 交付完成率 7/8=87.5% 有据；"验收合格"本身无 acceptanceVerdict 记录 |
| 2 | 合并率 | **部分可知 (b)** | 证据捕获时点 0/7 个 ready 运行的 PR 合并；7 天合并结局未观察 |
| 3 | 首审即终审率 | **未知 (c)** | 无 firstReviewCandidate/finalCandidate 记录，PR 捕获时 0 条 review |
| 4 | 7 日返修率 | **未知 (c)** | 观察窗仅约 1 小时（≠7 天），无 sevenDayOutcome 记录 |
| 5 | 队列等待时长 | **有数值 (a)** | n=8：整体中位 **6.609s**（native 中位 7.687s / off 中位 6.114s） |
| 6 | 审查等待时长 | **未知 (c)** | 无审查提交/完成时间；捕获时 PR 均未 review |
| 7 | 任务耗时（wall clock） | **有数值 (a)** | n=8：中位 **124.943s**，P90 163.805s（nativeReady n=3 中位 109.032s） |
| 8 | token 成本 | **部分可知 (b)** | 仅 native n=4：totalTokens 中位 **897,901.5**；off 4 条 usage 未保留 |

### 2.1 合格交付率

- **结论：部分可知 (b)。**
- **可知部分**：
  - `delivery == ready-pr-created` 的运行：**7/8 = 87.5%**（native 3/4 + off 4/4）。
    来源：`eval/evidence/b5runs/b5-trial-20261108-*.json` 的 `delivery` 字段（8 条：7 条 `ready-pr-created`，1 条 `b5-trial-20261108-native-r1` 为 `blocked`）。
  - 隐藏测试在 8 个 PR head 上全部通过（任务目标达成，不等于"验收合格"）：
    来源 `eval/evidence/b5pairing/verification.md` 结果表——base `1e166fb` exit 1（AssertionError），8 个 head 均 exit 0 PASS。
- **缺什么**：T04 口径的 `acceptanceVerdict`（`passed|failed|invalid|unknown`）在 8 条历史记录中**不存在**（这批记录早于 T04 字段；`eval/evidence/b5runs/README.md` §4 的 null 清单也没有该字段），因此"合格交付率"（验收通过占比）**本身未知**；上面的 87.5% 只能作为"交付完成率"代理，不能替代。
- **不可用作**：B5 效果结论或 T04 合格交付率的锚点；`blocked` 的原因是 base 缺 `backend/app/data` 导致 `project-regression` 在 collection 阶段 exit 2（`b5-trial-20261108-native-r1.json` 的 `validationEnvironment.reason`），不是实现缺陷。

### 2.2 合并率

- **结论：部分可知 (b)。**
- **可知部分（证据捕获时点 2026-11-07T23:35:54Z）**：有 PR 的 7 个 `ready-pr-created` 运行中，**合并 0 个（0/7）**，全部 `state=OPEN`。
  - native 侧：`eval/evidence/b5off/native-reference.json` 的 `pulls[]`——#3（draft）、#5、#8、#9 均 `"state":"OPEN"`；捕获时间见其 `note`。
  - off 侧：`eval/evidence/b5off/off-prs-summary.json` 的 `state` 字段——#8、#10、#12、#14 均 `"state":"OPEN"`。
  - 文字结论："8 个 PR 与 Issue 均未修改、未合并"（`eval/evidence/b5runs/README.md` §1）。
- **缺什么/原因**：T04 的 `mergedAt` 字段在历史记录中不存在；证据只覆盖捕获时点，且试跑 PR 本就"由人合并、未启用 auto-merge"（各 PR/报告摘要，如 `eval/evidence/b5off/ticket-10b8b5256d303017ded3187ea1c0ae11.json` 的 `assignments[].report.summary`）。**7 天后的最终合并结局未知**，2 小时内的 0/7 不能当作合并率终值。

### 2.3 首审即终审率

- **结论：未知 (c)。**
- **缺失原因**：T04 的 `firstReviewCandidate`（首次提交审查的 head + submittedAt）与 `finalCandidate` 在 8 条 run 记录中**均无字段**；在 B5 试跑证据（`b5runs/`、`b5off/`、`b5ss/`、`b5trial/`、`b5pairing/`）中也检索不到 `firstReview`/`submittedAt` 记录。
- 旁证（说明为何无法构造）：捕获时 PR 尚无任何 review——例如 `eval/evidence/b5off/ticket-10b8b5256d303017ded3187ea1c0ae11.json` 的报告摘要写明 "no review requests and no reviews yet / Automated-reviewer rounds: 0"；native 侧同样"no PR reviews/comments yet"（`eval/evidence/b5off/hostb-tickets-final.json` 中 native ticket 摘要）。
- **不能做**：用"PR 创建到关闭之间没有新提交"推测首审即终审（无审查事件，无法判定"终审"）。

### 2.4 7 日返修率

- **结论：未知 (c)；按 T04 规则应标"证据不足"。**
- **缺失原因**：
  1. 8 次运行的开始/结束都在 `2026-11-07T22:35–23:35Z`（§1 表），证据捕获也在同一小时级窗口；**观察期远小于 7 天**。
  2. 历史 run 记录没有 `sevenDayOutcome` 字段，B5 试跑证据（`b5runs/`、`b5off/`、`b5pairing/`）中也没有这 8 次运行的 7 天后返修/返工事件证据。
  3. `eval/BACKLOG-2026-11-08.md` 第 9 项明确"B8 正式观察：当前仅开发期快照……无 PREREG 观察窗口数据"。
- **不能做**：把"没有观察到返修"写成 0% 返修率（观察窗未开启，0% 无意义）。

### 2.5 队列等待时长

- **结论：有数值 (a)。**
- **值（n=8；T04 `queueWaitSeconds` 口径 = ticket `createdAt` → assignment `startedAt`）**：
  - 整体中位 **6.609s**；最小 5.747s、最大 95.855s；8 个值：native 8.527 / 6.846 / 6.774 / 95.855，off 6.444 / 5.747 / 6.327 / 5.901。
  - 分组中位（文件给出）：native **7.687s**（n=4，p90 69.657s）、off **6.114s**（n=4，p90 6.409s）。
  - 方法：`workerSeconds = report.at - startedAt`、`queueSeconds = startedAt - createdAt`（`eval/evidence/b5ss/timings.json` 的 `method` 字段）。
- **来源**：
  - `eval/evidence/b5ss/timings.json`：`runs[].durations.queueSeconds`（8 条逐 run 值）；`summary.native.queueSeconds.median/p90`、`summary.off.queueSeconds.median/p90`（分组中位/P90）。
  - 原始时间戳来源：`eval/evidence/b5ss/native-tickets-raw.json`（native 4 个 ticket 的 `value.timestamps.createdAt/startedAt`）、`eval/evidence/b5off/ticket-*.json`（off 4 个 ticket 的 `createdAt` 与 `assignments[].startedAt`）。
- **说明**：最大值 95.855s 是 native run3 因 `maxWorkers` 排队（ticket 22:50:48 创建、22:52:24 才启动）；n=8 且无重复，仅描述。

### 2.6 审查等待时长

- **结论：未知 (c)。**
- **缺失原因**：T04 `reviewWaitSeconds`（候选提交 → 审查完成）需要"审查提交时间"和"审查完成时间"；历史证据里**两者都没有**：8 条 run 记录无该字段；PR 在捕获时 `state=OPEN` 且 0 review（见 §2.3 旁证）；`eval/evidence/` 无 `review`/`reviewWait`/`submittedAt` 事件。
- **不能做**：把"PR 创建到当前"或"ticket reportAt 到 idleAt"冒充审查等待（后者是 worker 收尾，不是审查）。

### 2.7 任务耗时（wall clock）

- **结论：有数值 (a)。**
- **值（n=8）**：
  - 全部 8 条 `wallClockSeconds` 中位 **124.943s**、P90 **163.805s**（`timings.json` `summary.all.workerSeconds`）；均值 129.108s（= 1032.862 / 8，`cost.json` `duration.observed8Runs.totalWorkerSumSeconds = 1032.862`）。
  - 分组：native n=4 中位 **114.927s**（p90 198.472s，含 `blocked` run1）；native 仅 ready n=3 中位 **109.032s**（p90 118.463s）；off n=4 中位 **130.403s**（p90 133.802s）。
  - 范围：最小 79.542s（native r3）、最大 231.751s（native r1 `blocked`）。
- **来源**：`eval/evidence/b5ss/timings.json` 的 `summary.*.workerSeconds`（`values/median/p90`）与 `runs[].durations.workerSeconds`；逐条记录字段 `eval/evidence/b5runs/b5-trial-20261108-*.json` 的 `wallClockSeconds`；交叉核对 `eval/evidence/b5ss/cost.json` `duration.observed8Runs`（native 541.146 + off 491.716 = 1032.862）。
- **口径说明**：`timings.json` 的 `workerSeconds = report.at - startedAt`，与 run 记录 `wallClockSeconds` 一致；若需要"创建到报告"的端到端口径，`timings.json` 另有 `summary.all.endToEndSeconds.median = 136.498s`（不要与本指标混用）。

### 2.8 token 成本

- **结论：部分可知 (b)。**
- **可知部分（仅 native，n=4）**：
  - 逐 run `totalTokens`：run1 **1,884,642**；run1-retry **779,524**；run2 **667,037**；run3 **1,016,279**。
  - 汇总：`totalTokens` 中位 **897,901.5**、P90 **1,624,133.1**、总和 **4,347,482**；去掉 cacheRead 的 `nonCacheInputOutput` 中位 **40,301.5**、P90 66,245.8、总和 191,194。
- **缺什么/原因**：off 4 条 **usage 不可得**——`eval/evidence/b5ss/native-usage.json` 的 `note` 与 `off[]` 明确：off 实例 `DSH_HOME`（`/tmp/hephi-off-b5`）已被清理、`off-host.log` 无 usage，**按 unknown 处理、不补 0**；`cost.json` `tokens.off.value="unknown"`。
- **口径注意**：`totalTokens = input+output+cacheRead+cacheWrite`，**包含缓存读取**，不必然等于供应商计费口径（`native-usage.json` 各条 `notes`）；8 条 run 记录自身 `tokens` 字段全部为 null（`b5runs/README.md` §4），本节的 token 数来自独立 session 日志证据，不是 run 记录字段。
- **来源**：`eval/evidence/b5ss/native-usage.json` 的 `native[].usage.*`、`nativeAggregate.*`、`off[].available/reason`、`note`；`eval/evidence/b5ss/cost.json` 的 `tokens.native.aggregate`、`tokens.off.value/reason`（与前者一致）。

## 3. 这些历史数据还缺什么（与 T04 的对应关系）

| T04 字段/能力 | 历史数据 | 影响 |
| --- | --- | --- |
| `ticketIds[]` 与按 taskId 聚合（AT-60） | 8 条 run 均为 1 run ↔ 1 ticket，无同任务多 ticket | 无法给出"多 ticket 合并后"的基线；聚合逻辑只能等新批次 |
| `acceptanceVerdict` | 不存在 | 合格交付率只能给交付完成率代理（§2.1） |
| `firstReviewCandidate` / `finalCandidate` | 不存在 | 首审即终审率未知（§2.3） |
| `mergedAt` | 不存在；PR 捕获时全 OPEN | 合并率只有捕获时点 0/7（§2.2） |
| `sevenDayOutcome` | 不存在，且观察窗 <7 天 | 7 日返修率未知/证据不足（§2.4） |
| `queueWaitSeconds` / `reviewWaitSeconds` | 队列可用（§2.5）；审查事件缺失（§2.6） | 队列有数、审查等待未知 |
| `tokens`（run 记录） | 8/8 null；native 可从 session 日志补，off 缺失 | token 只有 native 部分（§2.8） |

## 4. 使用边界

1. 本文件是**描述性参考**，不得当作锚点，也不得写进 T04 总分计算（总分=本批次实测值 + T05 锁定的 PREREG 锚点）。
2. 不得引用本文件的数值声称任何 B5/native-off 对照效应：配对性弱、无盲评、样本 n=8 且单任务（`eval/evidence/b5runs/README.md` §5；`eval/evidence/b5pairing/verification.md` "解释与限制"；`eval/BACKLOG-2026-11-08.md` 第 4/5/7 项）。
3. 任何比例都附带样本量；n=4 的 P90 不可靠（`timings.json` `summary.note` 原文）。
4. 后续批次补齐 T04 字段后，应重新生成本基线并标注版本；本文件不自动更新。

## 5. 复算方式（只读）

```sh
# 8 条 run 的 delivery / wallClockSeconds
node -e 'const fs=require("fs");for(const f of fs.readdirSync("eval/evidence/b5runs").filter(f=>f.endsWith(".json"))) { const j=JSON.parse(fs.readFileSync("eval/evidence/b5runs/"+f)); console.log(j.runId,j.arm,j.delivery,j.wallClockSeconds) }'

# 队列/worker 时长与分组中位
node -e 'const j=require("./eval/evidence/b5ss/timings.json");console.log(JSON.stringify(j.summary,null,1))'

# native token 与 off unknown
node -e 'const j=require("./eval/evidence/b5ss/native-usage.json");console.log(j.nativeAggregate,j.off.map(x=>x.available),j.note)'
```

> 证据文件哈希见各目录 `SHA256SUMS`（`eval/evidence/b5runs/`、`eval/evidence/b5ss/`、`eval/evidence/b5off/`、`eval/evidence/b5trial/` 等）。
