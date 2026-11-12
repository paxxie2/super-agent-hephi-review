# v5.4 自动执行批次状态（evolve 插件驱动）

日期：2026-11-12 · 分支 agent/task-contract-standard-20261111 · 基线 main ab5f527
驱动：dsh-evolve-bundle（task board + teammate + 双席审核 + experience-log v3）

## 已完成（真实证据）

| 清单项 | 交付 | commit | 证据 |
|---|---|---|---|
| B1.1/T03 合同聚焦 | lint-task +3 测试、budget-advisory 9 测试；Devin 4 语义文件收编 | 25795b8 | typecheck exit 0；38/38 pass；Lead 重放 9/9 |
| T08 统计入口 | report.py worst_case_imputation 并列段（+54 纯新增）；t08_worst_case_test.py | d08ac7a | self-test PASS；T08 7/7（实验2/10 对照1/10）；known-answers 9/9 无回归 |
| B0 离线底稿 | events.jsonl 22 条 + ledger.md 182 行（18合同→10父任务P1-P10，双条件核验，实际重做diff证据） | c8435fe | 哈希核对一致；contractHash mismatch=0；22事件逐字段回比 problems=[] |

## 关键实测发现（B0）

- g1 数据真实位置：/Users/zm/dsh-instances/g1-exp/state/hephi（18 合同，插件 9c5afb2，142 决策=120 allow+22 deny）。
- 4 份 tests 越界合同（62bf37ea/aee15371/cfbc528a/d24565ef）：越界测试 backend/tests/acceptance/test_evidence_le50.py 在 4 个 baseSha 上均不存在 → 属"确需新写"而非只读；合同级 allowedPaths 覆盖但 item 级 paths 不覆盖。这证实 v5.4 §1 的合同矛盾假设，且新提示语义（仅需新写才补路径）正确。
- 旧脚本初分（摩擦12/有效6/红态4）与逐事件核验（摩擦5/有效13/红态4）差异显著 → 旧汇总数不可靠，v5.4 要求逐事件核验是对的。

## 外部阻塞（不能自动，须负责人/宿主/预算/真人）

| 项 | 阻塞原因 |
|---|---|
| D-8/D-10/D-11 验收口径 | 待负责人确认；未确认按 v5.3 口径 |
| A1-A5/T10/T11（可信交付门+恢复） | 宿主 3083/3085/3086 全 down；g1 实例目录已删，需重新部署 |
| T02 真实计量 / B3/B4 付费对照 | 需已批额度（B3 暂定 50 元未确认）+ 真实 usage 采集 |
| T09 盲评 | 需一名真人 + 独立 agent 双标注 |
| T12/P6 观察 | 物理 14 天窗口，压缩不了 |
| B1.2 任务构造 | Dubbo 检查配置待负责人批准；大任务原始需求待准备 |

## 审核状态（双席 + 仲裁完成）

- Kimi 执行审 task-17：pass，score 92，pack af8eda9f…（5 条非阻断建议）
- GPT 交叉审 task-17+18：blocking，score 80，pack 0e5afc79…（唯一阻塞 B1：T03 权限/验收路径证据）
- Lead 仲裁（exp-032，分差12<30 但一席 blocking 强制留痕）：B1 部分采纳。GPT 误数 it=10 驳回（实测9，全量611/611绿）；真实权限路径既有覆盖（redteam RT-SCOPE-01/02+LEGAL-01、protected-assets C1-05/06）；T03 端到端集成证据需真实宿主→标 blocked（A线/T10）。task-17/18 交付维持有效。GPT 测试补强建议采纳为 task-19。
- B1.1 出口全量验证：hephi 42 files 611 tests passed exit 0（HEAD d08ac7a，含 redteam+protected-assets 真实权限路径）
- 经验沉淀：exp-030/031/032，validate-log OK 32 行
- P10 口径裁决：按 v5.4 决定7（原始需求父任务评）采用归并口径（1父8尝试），分仓口径作敏感性标注

## 2026-11-12 后续独立核对（PR 头 e282252）

- 宿主端口均拒绝连接，三个实例目录、数据库和启动脚本仍在。三个 profile 的插件链接目标缺失。11 月 8 日部署记录另记载两个 g1 实例为节省轮询配额主动停机。3086 的历史 Ticket d2e19228 在赫菲决策日志最后一条为 ready.pass / allow（实载 6d24e1b），编排器 SQLite 的 ticket.value 未记录顶层 ended；据此无法判定该票仍在运行。3086 为冻结对照，恢复时须保持其独立制品。
- T08 的 11 项为 B4 标签缺失及基线不变性的合成聚焦测试。Q4 正确/错误制品 SHA 两条路径未核验。完整 T08 仍为部分验证。
- D-10、D-11 已受托决定沿用 v5.3。D-8 以 −10pp 作估样依据，正式冻结仍须等 B3 成本与可行性数据，见决定记录末节。
- T02 已补核历史 18 个 Worker 会话的原始 usage。989 条已记录合计 67,178,636 tokens；1 条消息缺 usage、4 个已启动 step 缺消息，审查、人工和实付未覆盖。真实端到端未验证通过。

## 2026-11-12 3085 受控恢复（用户授权，ab5f527 固定候选）

- **目标制品**：ab5f527a11655dd3e935a634d3b5c62f0a265f51（main 基线，Q4 对照同源；C1 尚未冻结，A 线从此基线开始）。
- **发布**：release-meta prepare+check+宿主 Node 导入探针全过；不可变 release 落位 g1-exp/releases/hephi/ab5f527…/（formatVersion 2，zod 4.6.7 随包，3 peer 绝对路径链接）。
- **指针修复**：重建 hephi-review/hephi 指针目录（cordis.patch.yml + package.json + skills + lib→release/lib + node_modules→release/node_modules）；profile symlink 恢复原始相对路径。首次误把 symlink 直指 release 根（缺 cordis.patch.yml）导致 bundle skip + 实载旧 9c5afb2，已纠正。
- **派发暂停**：启动前 append settings-version:20（paused=true，保留 19 不动，SQLite 已备份 orchestrator.sqlite.bak-recovery-1794424012）。原 settings-version:19 paused=False 与 T20 记录不符，如实登记。
- **实载回读**：host.log 两条 [hephi-activation] entry=index/tools commit=ab5f527… pid=21728=host.pid；端口 3085 LISTEN；SA 源码 cd384e7（与计划 L228/L565 核对一致）。
- **3086 未动**：冻结对照 6d24e1b 保持独立制品。
- **未做**：未解除暂停、未派发任务、未开强绑定、未产生实验支出。T03 宿主路径、T08 Q4 正误 SHA 两例仍缺证据；真实端到端未验证通过。
- **待用户决定**：是否解除暂停并从新 Issue 验收自动触发（A1 隔离验证起点）。

## 2026-11-12 A1 真实端到端验收通过（issue #21 → PR #22）

- **解除暂停**：settings-version:21 paused=false，重启宿主 pid 33924。
- **自动触发链路**：GitHub issue #21（evidence offset le=10000）→ trigger 9ff28810 → ticket 46aa3f59 → prepare → 合同（pluginCommit=ab5f527）→ Worker 红绿 → ready.pass → PR #22（OPEN MERGEABLE，head 440712x）。
- **decisions 链**：plan.recorded → scope.allowed(write) → check.blocked(红，exit 1 预期) → scope.allowed(edit×2) → check.pass×2(绿) → ready.pass。唯一 deny 是预期红态，无越界。
- **修复过程问题**：指针目录初缺 scripts/prepare-dubbo.sh → prepare failed；补 scripts 后通过 POST tickets/:id/retry（x-orchestrator-request:1 头）成功重试。failed assignment 不自动重试。
- **A1 隔离证据**：合同 pluginCommit=ab5f527 与实载一致；Worker 在独立 checkout 工作，状态目录由插件写入；diff 仅 diagnoses.py + 验收测试，无越界改动。
- **真实端到端首次通过**（此前所有"未验证"项中，A1 起点现已有真实交付证据）。T10/T11 完整验收（四类无效证据拒绝 + 四种故障恢复）仍待后续。

## 2026-11-12 多 agent-team 并行批次（evolve 驱动，4 任务）

| 任务 | 执行者 | commit | 结论 |
|---|---|---|---|
| T08/Q4 制品 SHA 正误两例 | impl-worker | b7fb5f3 | ✅ 6/6 PASS，无回归 |
| B1.2 两场景探查任务草拟 | hephi-rca | cbe8437 | ✅ 草案落盘，Dubbo 配置缺失证实，5 项待决 |
| T11 四状态恢复验证 | hephi-dev | e845422 | ✅ 18/18 PASS，真实 3085 CLI，状态目录字节不变 |
| T10 四类无效证据拒绝 | hephi-evidence | 0f606c2 | ⛔ **blocked**：binding off 攻击①误放行（一票否决）；binding on 合法前台被 output-unverified 拒（部署约束） |

### T10 关键发现（如实登记，不伪造通过）
- 生产配置（binding off，与 PR#22 一致）：3/4 拒，**①伪造记录误放行 ready.pass** → v5.4 §10 一票否决 → T10 不达标。
- 收紧绑定（binding on）：4/4 拒，但合法前台交付被 ready.output-unverified 拒（真实 Session 结构化 tool/result value=0）→ 部署约束（附录A 明示为设计行为）。
- 后台 Job 合法路径：未验证（零付费红线 + check-runner 仅接受结构化 promoted/background）→ 部署约束。
- **兼得需 H6 隔离 + 宿主 R1 结构化 value**（与 dsh-host-requirements.md 一致）。不据此升级 D1/D2。
- 事故：cpSync git worktree 致误提交 2 个，已 reset --hard 440712d9 恢复（Lead 核验 HEAD/clean），改用 clone --no-hardlinks + 守卫。

### 经验沉淀
exp-037（Q4 SHA）、exp-038（B1.2）、exp-039（T11）、exp-040（T10 blocked），validate-log OK 40 行。

## 2026-11-12 批次 2 完成（PR #92 已合并）

| 任务 | commit | 结论 |
|---|---|---|
| B2 护栏机制验证 | 1dae2f6 | ✅ 7/7（PlanSummary + ChangeSummary + 无误拦） |
| A2/A3 强绑定决策材料 | bb6b050+cc8c7bd | ✅ 档位 L1，四前置未满足，路线图落盘 |
| B1.2 大任务冻结清单 | 54ea9f0 | ✅ 11 张 v3 卡 + 隐藏验收锚点 |
| T08 完整收尾 | 2545de4 | ✅ 87 断言 0 FAIL |

### v5.4 可自动项全部完成总结

**已完成（真实证据）**：B0 离线底稿、B1.1/T03 合同聚焦、T08 统计工具（含 Q4）、B1.2 两场景草案+冻结清单、T11 四状态恢复、A1 真实 e2e（PR#22 已合并）、B2 护栏机制、A2/A3 决策材料。

**外部硬阻塞（如实标 blocked，不伪造）**：
- T10：binding off 攻击①误放行（一票否决）；需宿主 R1 结构化 + H6 隔离
- A2/A3 强绑定开启：四项硬前置均未满足，档位上限 L1
- B3/B4 付费对照：需预算批准 + 真实 usage 采集
- T09 盲评：需真人
- T12/P6：物理 14 天窗口
- Dubbo 检查配置：缺失，待负责人批准补齐

**经验层**：exp-028~044（17 条），validate-log OK 44 行。
**PR 历史**：#91（batch1）+ #92（batch2）均已合并 main；PR #22（A1 fix）已合并 b5-off-history-page-size。

## 2026-11-12 批次 3：双席审核 + 修复轮 + Proposer

### 双席审核结果（均 blocking，已全部修复）

| 轮次 | Kimi | GPT | 处理 |
|---|---|---|---|
| 第 1 轮（batch2 deliverables） | 76 blocking：glob 目录 pattern 不可执行 + 3 卡泄漏隐藏命令 | 72 blocking：同上 + B-03 g-b3-6 隐藏测试责任冲突 + B-04 锚点声明超出记录 | 全部采纳无豁免：task-30（331a141）、task-31（bc90028） |
| 第 2 轮（修复复审） | 82 blocking：K-1 g-b3-3 allowedPaths 扩权 + K-2 Lead 伪回放命令 + K-3 PR#91 笔误 + K-4 140/lint 记录不符 | —（GPT 席未复审） | 全部采纳：task-32（d0f35d5） |

Lead 终审重放：11/11 lint PASS、11/11 allowedPaths==acceptancePaths、隐藏命令 grep 无命中、T10_REPLAY_PR_STATE 计数 0。

### 丢失文档重建（task-28, 63ba85b）
5 份原建于已删除 agent/roadmap95 分支的 validation 文档按现存证据重建，每份标注「重建版，非原始文件」+ 依据清单 + 丢失确证（git log --all 各 0 commits）；68 处 file:line 引用核对 0 problem。

### T10 漂移定性（task-29, 8ca1996）
`ready.pr-mismatch` 属 §11.5 预登记 PR 生命周期漂移，**不是攻击①已修复**；隔离实验（PR 状态回放 OPEN）证明 attack-1-forged-record-binding-off 仍返回 ready.pass → **T10 blocked 不变**。

### 经验层 + Proposer
- exp-045（勘误 exp-043 退出码）、exp-046（重建文档）、exp-047（双席 blocking 仲裁）、exp-048（勘误 exp-044 隔离声明）、exp-049（B-03/B-04 修复）、exp-050（复审轮新发现含 Lead 自身错误）、exp-051（K-1..K-4 修复）、exp-052（Proposer 运行）
- `harness-assets/proposals/2026-11-12-run1.json`：5 条提案（P-001 前提事实状态门 / P-002 逐命令退出码契约 / P-003 授权路径等值与 glob 门禁 / P-004 隐藏验收双向隔离 / P-005 只读复算协议），全部 `status=proposed`，未改生产资产
- validate-log OK 52 行

### 批次 3 补充：丢失产物恢复（task-33/34）

| 产物 | 原建于 | 恢复 commit | 验证 |
|---|---|---|---|
| A7 宿主契约套件（host-contract.test.ts + 文档） | task-15 已删分支 | 090560b | 带 env 1 passed / 不带 env 1 skipped / typecheck 0 |
| H6 检测能力（snapshot-seal.ts + 21 tests + 3 处文档） | task-9 已删分支（a583edc） | 6a51c3e | typecheck 0；snapshot-seal 21 passed；tests/control 519 passed；**全量 639 passed / 1 skipped**；另只读校验 1385 个真实 session 文件全部帧对齐+封存+回环 OK |
| 5 份 validation 文档 | 已删分支 | 63ba85b | 标注重建版 + 68 处引用核对 0 problem |
| A1 验收修复 PR | — | PR#22 已合并 | 真实端到端 ready.pass |

**H6 恢复的边界**：detect-only，adapter 默认未接线（需配置 sessionLogRoot）；同 UID 仍可伪造合法帧 → **H6 根因未变，D1 仍 L1，T10 仍 blocked**，不得据此升级。

### 清理教训（已入 exp-053）
删除分支前须盘点该分支产物的**完整清单**（含 src 实现本体与 tests），本次 snapshot-seal.ts 实现直到重建 A7 套件时才发现缺失，属清理时未做全量产物盘点的遗漏。

## 2026-11-12 第 4 批：DSH 宿主任务单 + T10 真实重跑

### 用户指定四步的执行结果

| 步骤 | 交付 | commit | 状态 |
|---|---|---|---|
| ① DSH 宿主任务单（能力A写权限 + 能力B四元绑定） | `hephi/docs/validation/2026-11-12-dsh-host-task-order.md`（264 行，88 处引用 0 problem） | a5ccbd9 + 781ff0c | ✅ 待宿主负责人受理 |
| ② 3085 部署固定版本记录 | `eval/evidence/t10-rerun/deploy-record.md`（DSH rc.5 / SA cd384e7 / hephi ab5f527 + 生效配置 + OPEN PR 条件） | 5630f87 | ✅ 3086 未动 |
| ③ 新 Issue 重跑 T10 | Issue#23 → ticket b17434f7 → 红→绿→ready.pass → PR#24（OPEN 未合并） | cca0e74 | ⛔ **T10 维持 blocked** |
| ④ B 线并行 | B0/T02 额度申请单 + Dubbo 检查配置可审批清单 | 7ac424b + 17070f9 | ✅ 待负责人批准 |

### T10 重跑核心结论（真实交付，非归档复算）

- **攻击①伪造记录在 binding off 下仍被错误放行**（`ready.pass`，一票否决）——**跨交付复现**，证明不是旧 PR/旧合同特例。
- binding on 下拒（`ready.binding` no native evidence）；②过期证据/③越界/④无害命令在 off/on 均拒。
- **前台合法路径实测通过**；强绑定前台 `ready.output-unverified` = 部署约束；**后台 Job 实际尝试后判部署约束**（3 个 check 均 jobId=null；代码链证明冻结配置下 bash 仅在超时 promoted，promotion 时点=deadline 随即被 kill）。
- 本次交付链另有 **4 条真实拦截**：protected asset 未授权修改 ×2、`scope.outside-task`（.git/PR_BODY.md）×1、预期红态 ×1。

### 结论

T10 要 pass，必须等宿主交付能力 A（Worker 写权限隔离）+ 能力 B（结构化四元绑定）。这不是 hephi 侧能修的。D1/D2 不升级，T10 维持 blocked。

**真实支出**：本次 1 次真实 Worker 交付（用户授权的第 3 步）。

## 2026-11-12 DSH 宿主任务单：进入原生队列

### 查重（提交前）
三个原生队列共 **181 张 Ticket** 逐条检索：
- g1-exp（3085）23 张
- experiment 49 张
- desktop superagent 109 张

**无任何 DSH 宿主能力实施单**；被监听 GitHub 仓亦无对应 Issue。→ 首次提交，非重复建单。

### 提交（Super Agent 原生入口）
| 项 | 值 |
|---|---|
| Issue | `paxxie2/g1-at81#4` |
| Ticket | `1d04c373fe1665d21538c0ceb7f12944` |
| 接单实例 | 3085（DSH 0.2.1-rc.5 / SA cd384e7 / hephi ab5f527） |
| 状态 | `running`（assignment 6bd9c09aafc9，2026-11-11T23:16:51Z） |
| HEPHI 合同 | 无（g1-at81 不在 prepare.sh 匹配范围，符合 AT-81） |

已回填到任务单 §7（commit b8644ae）。

### 交付边界（如实登记）
DSH 宿主以 `app.asar` 分发，本地无源码仓；上游 `deepseek-ai/deepseek-harness` 只读、`paxxie2` 无 fork。→ 该 Ticket 可交付物限定为**参考补丁草案 + 验收 harness**；能力本体须 DSH 团队实施，上游未交付前状态视为 `blocked-on-upstream`。

### T10 维持 blocked（用户确认）
3085 真实交付已到 PR #24；冻结配置下关闭强绑定会错误放行、开启强绑定无法验证合法前台输出 → **当前版本可信交付真实端到端未验证通过**。PR #24 留作本次失败证据，3086 继续冻结。

### 后续（等上游交付固定版本后）
1. 3085 用**实际 Worker 身份**验证：证据目录受保护 + 工作区可写 + 宿主可写；
2. 核对结构化记录能关联本次 Ticket/Session/执行结果/最终 SHA；
3. 两项通过后从**新 Issue** 重跑 T10（四类无效证据 + 合法交付路径逐项）。

### B 线（并行审批，等负责人）
- B0/T02 单次额度申请单：`eval/evidence/b-line/b0-t02-budget-request.md`
- Dubbo 检查配置可审批清单：`eval/evidence/b-line/dubbo-check-config-proposal.md`
- B3 的 50 元与 D-8 界值：继续等实测成本

## 2026-11-12 DSH 宿主 Ticket 产物（PR #5）与 hephi 侧并行开发

### DSH Ticket 1d04c373 的 Worker 产物（PR paxxie2/g1-at81#5，OPEN）

Worker 按其自报状态：**整体 fail/blocked**（因为它无法实施宿主本体），但产出了**限定范围内的高质量交付**：

| 产物 | 内容 |
|---|---|
| `patches/0001-tools-persist-tool-result-message-value.patch` | 能力 B1 参考补丁：`ToolResultMessage.value` 可选字段 + `output.contractValue` 投影器 + bash 声明 `{kind:'foreground',exitCode}` / `{kind,jobId}` 且超时/信号/停止时**省略 exitCode** + agent-loop 单次落入持久化 `tool/result` |
| `patches/0002-guard-worker-evidence-carrier-writes.patch` | 能力 A 参考补丁：新增 `@deepseek-ai/dsh-evidence-write-guard`，默认护 `<dshHome>/sessions` + 可配额外根（如 HEPHI state 目录）；Worker 进程被 shell executor 无条件包裹，macOS 用 Seatbelt `deny-file-write subpaths`、Linux 用 bwrap 只读 bind、**其他平台 fail-closed 而非无守卫运行** |
| `docs/host-capability-ab/b2-binding-record.schema.json` + `.example.json` | 能力 B2 四元绑定记录 schema：`ticket{id,repository,issue}` / `session{id,origin,agentPreset}` / `execution` oneOf(foreground{toolCallId,kind,exitCode} \| bg/promoted{toolCallId,kind,jobId}) / `finalCommit{sha,baseSha,prNumber}` |
| `docs/host-capability-ab/acceptance-runbook.md` + `baseline-2026-11-12.md` | 验收 runbook 与基线（`tag dsh-v0.2.1-rc.5, commit b830ec95`） |

Worker 报告如实标注：A 三项全 `blocked`（无销毁性写入探针）、B1 `fail`（真实快照 163 条 bash result / 0 结构化）、B2 `blocked`（无记录供给）、需人工签署。**未声称宿主已具备能力。**

### hephi 侧并行开发（三个 task）

| task | 内容 | 状态 |
|---|---|---|
| task-38 | h2Ring 全量统计（R1 验收硬前置） | ✅ f901a74+4a7998c（合成 7 条全结构化：旧 fail 5/7 → 新 pass 7/7；真实快照 32 条真无结构化仍 fail，未放宽） |
| task-39 | 增量 diff 反馈 + 计划宽度记录（只记录不拦截） | 进行中 |
| task-40 | 四元绑定记录消费器（binding on 才生效，off 零回归） | 进行中；已按 PR#5 的 schema 对齐（增强字段 optional） |

### 关键契约对齐
hephi 消费器与 PR#5 的 B2 schema 已对齐：最小必填 = 四元核心（`ticket.id`/`session.id`/`execution`/`finalCommit.sha+baseSha`），Worker 增强字段（`repository`/`issue`/`origin`/`agentPreset`/`prNumber`）作 optional 校验。

### 待办
- task-39/40 完成后跑全量回归 + 双席审核
- 上游交付 A/B 能力后：3085 实际 Worker 身份验证 → 新 Issue 重跑 T10

## 2026-11-12 hephi 侧能力批次收口（task-38~43 + 双席审核修复）

### 提交链（main，已推送）

| commit | 内容 | 验证 |
|---|---|---|
| f901a74 | h2Ring 全量统计（R1 验收硬前置） | self-test PASS；合成 7/7 前后对比 |
| bfbc5e7 | 增量 diff 反馈 + 计划宽度记录（只记录不拦截） | 干净 worktree 649 passed |
| 89ee7aa | 四元绑定记录消费器（binding on 才生效） | 干净 worktree 695 passed |
| e1c730d | T10 攻击①新代码复现（结论不变） | 五次对照 run1=run4 逐条一致 |
| 7bc88f6 | GPT-B3：显式 exitCode:null 必须 fail | self-test PASS + 真实快照无回归 |
| **5c216a9** | **Kimi B-1/B-2 + GPT-B1/B2：innerCallId only + kind 逐分支** | **干净 worktree 706 passed / 1 skipped** |

### 双席审核结果

| 轮次 | Kimi | GPT | 处理 |
|---|---|---|---|
| R1（base 4a7998c→89ee7aa） | 68 blocking：toolCallId 放宽 + kind 未比 | — | task-41 修复 |
| R2（base 3bd2351→89ee7aa，含 task-38） | — | 67 blocking：同上两条 + GPT-B3 exitCode null | task-41 + task-43 修复 |
| 修复后 | 5c216a9 全量 706 green | 待复审（可选） | ✅ 全部 blocking 已消除 |

### DSH Ticket 1d04c373 终态
- ended: merged（2026-11-12T02:41:36Z）
- PR#5 MERGED（参考补丁 + B2 schema + 验收 harness）
- Issue#4 标签 `blocked-on-upstream`（能力本体待 DSH 团队实施）

### T10 维持 blocked（不变）
新代码（5c216a9）下攻击①伪造记录在 binding off 仍被错误放行（ready.pass），跨交付复现。binding on 侧 deny ready.binding 未回归。**当前版本可信交付真实端到端未验证通过**，等宿主交付能力 A+B 后从新 Issue 重跑。

### 经验层
exp-064~076（含勘误），validate-log OK 78 行。
