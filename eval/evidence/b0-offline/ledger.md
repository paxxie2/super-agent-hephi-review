# B0 离线底稿：g1-exp 18 合同 / 142 决策 / 22 拒绝逐事件核验表

- 任务：task-16（v5.4 清单 B0.1 / T01）。执行者：b0-ledger。日期：2026-11-12。
- 数据源（只读）：`/Users/zm/dsh-instances/g1-exp/state/hephi/`（18 合同目录，各含 activation.json / decisions.jsonl / plan.jsonl / checks/）；源仓 `/Users/zm/dsh-instances/g1-exp/sources/b5-off-*`；工作区 `/Users/zm/dsh-instances/g1-exp/work/*`。
- 统计口径：仅 `pluginCommit.startswith('9c5afb2')`（实载全 SHA `9c5afb21e4b54c2d59795bf57e2353c955dd0b70`）；判定字段 `effectiveDecision`（本批 142 条全部 mode=enforce，wouldDecision==effectiveDecision，无 observe 差异）。
- 经验注入：pack_sha256=`355739b8a43a0ef03eb885738a8c2dfa02233eacc05b6c20bba8d89793ab4df1`（exp-028/029 证据纪律：blocked/未知不写成 pass）。
- 代码语义锚点基于 hephi-review-main HEAD=`25795b8c4f5451ee87dfe1f08c385ae087b03f54`（分支 agent/task-contract-standard-20261111）。注意：g1 实载插件 9c5afb2 与该 HEAD 不同构建；本文引用 HEAD 源码仅用于解释规则语义，逐事件结论一律以 g1 状态目录原始记录为准。
- 配套机读文件：[events.jsonl](events.jsonl)（22 条 deny，含 ticketId/seq/at/rule/reason 原文/分类/依据/证据路径/sourceRecord 行号）。

## 1. 总量核对（T01 整批核对）

实测命令与结果（python3 遍历 18 目录 decisions.jsonl，逐行 json.loads）：

| 项 | Lead 口径 | 本次实测 | 一致 |
|---|---|---|---|
| 合同目录数 | 18 | 18 | ✅ |
| 9c5afb2 决策总数 | 142 | 142 | ✅ |
| allow | 120 | 120 | ✅ |
| deny | 22 | 22 | ✅ |
| 其他 pluginCommit 记录 | — | 0 | ✅（无混入） |

deny 规则分布（实测=Lead 口径）：check.blocked 6、plan.recorded 5、ready.red-missing 3、scope.outside-checkout 3、scope.outside-task 2、asset.unauthorized-modify 2、path-out-of-contract 1。合计 22。

附加一致性核验：142 条决策的 contractHash 与各自 activation.json 的 contractHash 全部一致（mismatch=0）；每条 deny 的 sourceRecord 行号与 decisions.jsonl 实际行号一致。

allow 侧备注：0d8c13c4 有 3 条 `budget.advisory`（seq16/18/19，571 行 > 默认 advisory 400 行，"recorded and does not block delivery"），effectiveDecision=allow——与 B1.1/T03 "无显式 budget 只提示不硬拒"语义一致的历史实证。

## 2. 分类口径与汇总（T01）

四分类：**有效拦截**（拦下真实越界/缺证据交付，含合同缺陷导致的正确拒绝）/ **流程摩擦**（拦截符合规则但由卡路径-授权语义不一致或工具使用习惯引发，交付未受损或经调整完成）/ **预期红态**（v3 code 卡 red-before-green 门的红阶段运行，按设计记为 deny）/ **未知**（缺证据）。

| 分类 | 条数 | 事件（ticketId 前 8 位:seq） |
|---|---|---|
| 有效拦截 | 13 | 62bf37ea:1 · 62bf37ea:7 · aee15371:1 · cfbc528a:1 · cfbc528a:3 · cfbc528a:11 · d24565ef:1 · d24565ef:7 · d24565ef:8 · 6a8b6545:7 · 9ce75453:2 · 9ce75453:5 · f6d7afed:7 |
| 流程摩擦 | 5 | a543a97b:3 · e049c63e:5 · cfbc528a:4 · f6d7afed:5 · f7bd5da4:5 |
| 预期红态 | 4 | 0a8f4cda:3 · 24e98812:3 · 6a8b6545:3 · f7bd5da4:3 |
| 未知 | 0 | — |

计数说明：
- check.blocked 6 条拆为两类：4 条 phase=red（预期红态，junit failures=1/errors=0，before/after 仅测试文件变更）；2 条 phase=None（9ce75453:5、f6d7afed:7，普通 acceptance 跑因基线缺 `app.data` 种子包 exit=1，junit errors≥1/failures=0——环境缺陷，门禁如实拒绝，归有效拦截而非红态）。
- 拒绝事件（22）与实际重做（§4）**分列不相加**；二者有关联（如合同缺陷拒绝→父任务重投）但不合并为"总故障数"。
- 每条 deny 的完整 reason 原文、逐条依据与证据路径见 events.jsonl；本文 §5 给逐事件简表。

## 3. 父任务映射（B0.1：重投沿用父 ID；墙钟按父任务起止）

18 合同 → 10 个父任务。分组依据：activation.task.goal + item.id + 仓库 + PROGRESS.md T1-T10 终态表交叉核对。时间均为 decisions.jsonl 首末条 at（UTC），墙钟=组内最早首条→最晚末条。

| 父 ID | 场景 | 尝试（合同:issue） | 决策数 | deny | 首→末 (UTC) | 墙钟 | 终态 |
|---|---|---|---|---|---|---|---|
| P1 history-default-limit | diagnoses 默认 limit 20→10（history 仓） | 9bc53fd5:#11 | 5 | 0 | 11:51:05→11:52:20 | 75s | ready.pass（T1，PR#12 合） |
| P2 history-limit-max | list limit 上限 100→50 | d43e4fb4:#14 → 79555f15:r2#2 | 5+7 | 0 | 12:15:42→13:06:44 | 3061s | ready.pass（T2 PR#15 + T7 PR#3 均合；r2 为投递层 fresh() 规则重投，非门禁拒绝所致） |
| P3 history-offset-max | offset le=10000（history） | bbcdd899:#16 | 8 | 0 | 12:25:05→12:27:48 | 163s | ready.pass（T3，PR#17 合） |
| P4 health-service-field | health 服务标识（试跑卡） | e049c63e:#6 | 11 | 1 | 12:16:04→12:17:59 | 115s | ready.pass（T4，PR#7 合） |
| P5 health-default-limit | 默认 limit 20→10（health） | 9ce75453:#8 | 5 | 2 | 12:25:39→12:31:19 | 340s | **未 ready**（T5，环境缺陷；base 修复后本地 3/3 过，PR#9 人工复核合入） |
| P6 backend-input-validation | 输入校验（试跑卡） | 0d8c13c4:#7 | 20 | 0 | 12:21:18→12:25:04 | 226s | ready.pass（T8，PR#6 合） |
| P7 backend-offset-max | offset le=10000（backend） | e4b13ee5:#9 | 7 | 0 | 12:47:24→12:50:17 | 173s | ready.pass（T9，PR#10 合） |
| P8 health-offset-max | offset le=10000（health） | f6d7afed:#10 | 7 | 2 | 12:49:14→12:50:38 | 84s | **未 ready**（T10，环境缺陷；base 修复后本地 3/3 过，PR#11 人工复核合入） |
| P9 money-window-helpers | money 窗口辅助（试跑卡） | a543a97b:#7 | 6 | 1 | 12:16:19→12:19:12 | 174s | ready.pass（T6，PR#8 合） |
| P10 evidence-le50 | evidence limit 上限 100→50（四仓各一父需求？否——同一需求四仓复制，见下注） | d24565ef:#12, aee15371:#18, cfbc528a:r2#4, 62bf37ea:#11（4 缺陷卡）→ 0a8f4cda:#14, f7bd5da4:r2#6, 6a8b6545:#13, 24e98812:#19（4 修正卡） | 8+1+11+7+7+8+8+11=61 | 16 | 13:25:32→13:54:39 | 1747s | 4 修正卡全部 ready.pass；4 缺陷卡全部未 ready |

P10 注（重要口径说明）：evidence-le50 是**同一需求在 4 个镜像仓各投一次**（health/history/money-r2/backend 各 1 缺陷卡 + 1 修正卡）。若按"每仓一个父需求"口径则应拆为 4 个父任务（各 2 次尝试）；本表按"同一需求文本+item.id=evidence-le50"归并为 P10 一组 8 尝试，两种口径的尝试数与终态不变，仅分母分组不同。**采用哪种口径需 Lead 定夺**，本文默认归并口径并如实标注歧义。PROGRESS.md 的 T1-T10 表不含这 8 张卡（该表止于 13:06 前的 10 任务；evidence-le50 批次是其后 13:25-13:54 的追加批），故 P10 终态以本表实测为准，不套用 T1-T10。

重投判定（T01：重投只增尝试数，未完成仍进分母）：
- P2：d43e4fb4 已 ready.pass，79555f15 仍计为第 2 次尝试（投递层 fresh() 跳过导致重投，PROGRESS.md L28-30；money-r2 仓 #2）。两次尝试都完成。
- P10：每仓缺陷卡→修正卡为重投对（修正卡 item.paths 补入测试路径）。缺陷卡 4 张全部未完成，**仍进分母**：P10 完成率 4/8（归并口径）或每仓 1/2（分仓口径）。
- aee15371 仅 1 条决策（seq1 plan deny 后无任何后续），checkout HEAD==baseSha、status clean——Worker 未开始实现即终止，终止原因日志无记录，标**未知**（不影响该 deny 本身的分类）。

## 4. 实际重做（与拒绝分列，须有前后 diff 证据）

| 重做 | 类型 | 前→后证据 | 关联拒绝 |
|---|---|---|---|
| P10 四仓缺陷卡→修正卡 | 父任务级重投（新合同新 checkout） | 修正卡终稿 diff（git diff --stat base..HEAD，实测 exit=0）：6a8b6545 eeb7e0ae→35f77616 = diagnoses.py+35/-2 & test_evidence_le50.py+47；24e98812 11787a4d→d5a3c00c = +35/-2 & +12；0a8f4cda bc06b76c→76929c25 = +35/-2 & +37；f7bd5da4 29a07edb→5bbddc99 = +9 & +16 | 62bf37ea:1,7 · aee15371:1 · cfbc528a:1,3,4,11 · d24565ef:1,7,8（10 条） |
| a543a97b 放弃测试改动 | 任务内范围收缩 | b4620d3→0210359 diff --stat 仅 money.py（+18/-8），test_money.py 未动 | a543a97b:3 |
| e049c63e 测试写入重试成功 | 任务内重试 | seq5 write deny → seq6/7 write allow → 终稿 6cbba32 含 test_health_service.py +103 行（4ef6a27→6cbba32 diff --stat） | e049c63e:5 |
| d24565ef 脏工作区清理 | 任务内清理（推断） | seq8 path-out-of-contract 时存在合同外文件；现 checkout e0bd957 status clean 且无该文件。清理动作本身无日志，标推断 | d24565ef:8 |

不计重做的：4 条预期红态后的绿跑是 TDD 正常流程（红→实现→绿），不是"纠正性重做"；9ce75453/f6d7afed 环境缺陷由 Lead 修 base（c43fcd6 "fix(base): track backend/app/data seed package"），属操作者修复，非 Worker 重做。

## 5. 22 条 deny 逐事件简表（完整 reason 原文与依据见 events.jsonl）

| # | ticketId:seq | at (UTC) | tool | rule | 分类 | 一句话依据 |
|---|---|---|---|---|---|---|
| 1 | a543a97b:3 | 12:16:26 | edit | asset.unauthorized-modify | 流程摩擦 | paths 含 test_money.py 但无 authorizes；被拒后放弃改测试，终稿仅 money.py |
| 2 | e049c63e:5 | 12:16:29 | write | asset.unauthorized-modify | 流程摩擦 | 新写测试落盘后再 write 触发"已存在受保护资产"分支；重试后终稿含测试 |
| 3 | 9ce75453:2 | 12:27:41 | edit | scope.outside-task | 有效拦截 | .gitignore 不在 item.paths；环境缺陷自救越权被正确拦 |
| 4 | 9ce75453:5 | 12:31:19 | hephi_check | check.blocked | 有效拦截 | 普通跑 exit=1，conftest ModuleNotFoundError app.data（环境缺陷，非红态） |
| 5 | f6d7afed:5 | 12:49:27 | write | scope.outside-checkout | 流程摩擦 | /tmp/verify_offset_max.py 越 checkout，拒绝正确 |
| 6 | f6d7afed:7 | 12:50:38 | hephi_check | check.blocked | 有效拦截 | 普通跑 exit=1，junit errors=2（app.data 缺失，非红态） |
| 7 | d24565ef:1 | 13:25:32 | hephi_plan | plan.recorded | 有效拦截 | 缺陷卡：tests 引用但 paths 不含 test_evidence_le50.py；base 无此文件确需新写 |
| 8 | aee15371:1 | 13:25:36 | hephi_plan | plan.recorded | 有效拦截 | 同上（history 仓）；此后无决策，Worker 终止原因未知 |
| 9 | cfbc528a:1 | 13:27:59 | hephi_plan | plan.recorded | 有效拦截 | 同上（money-r2 仓） |
| 10 | cfbc528a:3 | 13:28:06 | write | scope.outside-task | 有效拦截 | plan 被拒后 write 绕行，同一 inScope 再拦 |
| 11 | 62bf37ea:1 | 13:28:20 | hephi_plan | plan.recorded | 有效拦截 | 同上（backend 仓） |
| 12 | cfbc528a:4 | 13:32:43 | write | scope.outside-checkout | 流程摩擦 | /tmp/evidence_le50_probe.py 绕验被拦；诱因=合同缺陷 |
| 13 | d24565ef:7 | 13:32:55 | orchestrator_report | ready.red-missing | 有效拦截 | 无 phase=red 记录；running 遗留跑 junit=BrokenPipeError 非红证据 |
| 14 | cfbc528a:11 | 13:33:57 | orchestrator_report | ready.red-missing | 有效拦截 | 4 次 check 均普通跑，验收测试未写 |
| 15 | 62bf37ea:7 | 13:36:41 | orchestrator_report | ready.red-missing | 有效拦截 | 2 次 check 均普通跑，验收测试未写 |
| 16 | d24565ef:8 | 13:38:12 | hephi_check | path-out-of-contract | 有效拦截 | AT-41 启动前检查发现合同外改动文件（测试被写进 checkout） |
| 17 | 0a8f4cda:3 | 13:49:52 | hephi_check | check.blocked | 预期红态 | phase=red，junit failures=1，仅测试文件变更；后续 ready.pass |
| 18 | f7bd5da4:3 | 13:50:35 | hephi_check | check.blocked | 预期红态 | 同上（money-r2 修正卡） |
| 19 | f7bd5da4:5 | 13:51:51 | write | scope.outside-checkout | 流程摩擦 | /tmp/pr_body_evidence_le50.md（PR 正文草稿）被拦；ready.pass 不受影响 |
| 20 | 6a8b6545:3 | 13:51:52 | hephi_check | check.blocked | 预期红态 | 同上（backend 修正卡） |
| 21 | 24e98812:3 | 13:52:06 | hephi_check | check.blocked | 预期红态 | 同上（history 修正卡） |
| 22 | 6a8b6545:7 | 13:52:52 | hephi_plan | plan.recorded | 有效拦截 | 追加计划 test_diagnosis_api.py 不在本合同 item.paths（跨任务蔓延；该文件 base 已存在） |

（表按 at 排序；events.jsonl 同序。）

## 6. 四份 tests 越界合同双条件核验（任务卡③）

对 62bf37ea / aee15371 / cfbc528a / d24565ef 逐一实测：

| 合同 | 仓 | baseSha | item.paths 含测试? | item.tests 引用? | allowedPaths 覆盖? | base 上文件存在? | 双条件成立 |
|---|---|---|---|---|---|---|---|
| 62bf37ea | b5-off-backend-input-validation | eeb7e0ae | ❌（仅 diagnoses.py） | ✅ | ✅ backend/** | ❌ cat-file -e exit=128 | ✅ 需新写+不在可写范围 |
| aee15371 | b5-off-history-page-size | 11787a4d | ❌ | ✅ | ✅ | ❌ exit=128 | ✅ |
| cfbc528a | b5-off-money-window-helpers-r2 | 29a07edb | ❌ | ✅ | ✅ | ❌ exit=128 | ✅ |
| d24565ef | b5-off-health-service-field | bc06b76c | ❌ | ✅ | ✅ | ❌ exit=128 | ✅ |

核验命令（每仓，只读）：`git -C sources/<repo> cat-file -e <baseSha>:backend/tests/acceptance/test_evidence_le50.py` → 4 仓均 exit=128（fatal: path … does not exist）；`git ls-tree --name-only <baseSha>:backend/tests/acceptance` 列出既有测试（不含目标文件）。四张卡的 acceptance[0] 均无 authorizes 字段。

对照组（修正卡）：0a8f4cda/24e98812/6a8b6545/f7bd5da4 的 item.paths **含**该测试路径，同样无 authorizes——新写测试走 scope.allowed 放行（write 创建新文件不触发"已存在受保护资产 modify"分支，worker-mount.ts:470 existsSync 条件），四卡全部红→绿→ready.pass。这证明缺陷仅在缺陷卡的 paths 漏列，而非插件拒绝新写测试本身。

结论：**"测试路径不在 item 可写范围"与"确实需要写（base 不存在）"在 4 份合同上同时成立**，与 Lead 预判一致。这正是 B1.1/T03 合同书写标准要消除的矛盾（tests 引用必须同步进 paths，或只读例外语义）。

## 7. 规则语义锚点（HEAD 25795b8 源码，仅供解释；结论以 g1 原始记录为准）

| 规则 | 位置 | 语义 |
|---|---|---|
| inScope（plan.recorded/scope.outside-task/path-out-of-contract 共用） | hephi/src/control/discipline.ts:11-14 | allowedPaths ∩ 任一 item.paths |
| plan.recorded deny 文案 | hephi/src/control/worker-mount.ts:247 | planned file outside allowedPaths/task scope |
| scope.outside-checkout | hephi/src/control/worker-mount.ts:431 | checkout 外路径一律拒 |
| scope.outside-task | hephi/src/control/worker-mount.ts:436 | 文件不在任务范围 |
| asset.unauthorized-modify | hephi/src/control/worker-mount.ts:470-476 + discipline.ts:70-81 | 受保护资产**已存在于磁盘**时需同 item 显式 authorizes{path,op:modify}；新建文件不触发 |
| check.blocked（红） | hephi/src/control/check-runner.ts:585-590 | phase=red 必然 throw（exit≠0 记"failed as expected"），是设计行为 |
| check.blocked（普通） | hephi/src/control/check-runner.ts:599 | exit≠0 如实拒绝 |
| path-out-of-contract | hephi/src/control/check-runner.ts:410-418 | check 启动前 AT-41：changedFiles+untracked 超出 inScope 即拒 |
| ready.red-missing | hephi/src/control/evidence-verifier.ts:437-440 | 仅 task.version==3 && kind=='code' 要求红证据；v1 卡（本批 10 张）不受此门约束 |

版本佐证：8 张 evidence-le50 卡 task.version=3/kind=code；其余 10 张 version=1（无 kind）——与"只有 v3 code 卡触发 ready.red-missing"完全吻合（3 条 ready.red-missing 全在 v3 缺陷卡；v1 的 9ce75453/f6d7afed 失败后无 ready 尝试记录）。

## 8. 未知项与限制（如实登记，不冒充已验证）

1. aee15371 在 seq1 deny 后无任何后续决策/检查/提交，Worker 终止原因无日志——**未知**。
2. e049c63e seq5 deny→seq6/7 allow 之间的具体操作（删除重建？bash 落盘？）无直接日志——机制细节**未知**；"deny 时文件已在磁盘"由 existsSync 分支语义反推，标推断。
3. d24565ef seq8 之后的脏文件清理动作无日志——清理事实由当前 checkout clean 证实，清理方式**未知**。
4. d24565ef checks/707172fb 永久 status=running（junit 显示 pytest BrokenPipeError internal error）——遗留 running 记录，结果不可作证据；与 A3 resolve 场景吻合，本任务不处置。
5. P10 父任务归并口径（1 组 8 尝试 vs 4 组各 2 尝试）待 Lead 定夺（§3 注）。
6. 本底稿为**离线只读核对**：未重跑任何 check/测试，未启动宿主，未跑付费任务；所有"passed/blocked"均引自 g1 历史记录原文，不代表当前 HEAD 复验。
7. g1 实载插件 9c5afb2 与锚点 HEAD 25795b8 非同一构建；若两版规则语义有漂移，以 g1 记录的行为为准（本文分类均直接基于记录行为，源码仅辅助解释）。
8. 成本/usage：本任务未对接计量（B0.2 范围），父任务表不含 token/费用列——**未知**，不补零。

## 9. 自测证据（命令原文 + 退出码 + 关键输出）

全部在 2026-11-12 执行，只读命令（python3 heredoc 内 subprocess 调 git cat-file/ls-tree/diff/log/status/rev-parse，均无写操作）：

1. 总量提取：`python3`（遍历 18 目录 decisions.jsonl，过滤 pluginCommit 前缀 9c5afb2，Counter effectiveDecision/rule）→ exit=0；输出 `contracts= 18 total= 142 decisions= {'allow': 120, 'deny': 22}`；deny_rules 与 Lead 口径逐项一致；`would_vs_effective_deny= Counter({('deny','deny'): 22})`；`modes= Counter({'enforce': 142})`。
2. 4 仓 base 文件存在性：`git -C sources/<repo> cat-file -e <base>:backend/tests/acceptance/test_evidence_le50.py` → 4 仓均 exit=128，stderr `fatal: path … does not exist in '<base>'`；`cat-file -t <base>` 均 exit=0 out=commit（base 真实存在）。
3. 修正卡 diff：`git -C work/<checkout> diff --stat <base> HEAD` → 4 仓 exit=0，行数见 §4 表。
4. checkout 现状：`git status --porcelain`（62bf37ea/cfbc528a/d24565ef/aee15371/9ce75453/f6d7afed/a543a97b/e049c63e 对应 8 个工作区）→ 全部 exit=0 输出空（clean）；`rev-parse HEAD` 见 §4/§5。
5. 红跑 junit：4 个 phase=red 的 blocked run junit.xml 均 `failures="1" errors="0"`；2 个环境缺陷 run：9ce75453 `errors="1" failures="0"`、f6d7afed `errors="2" failures="0"`，output.log 尾部均 `ModuleNotFoundError: No module named 'app.data'`（conftest.py:41）。
6. events.jsonl 校验：`python3`（逐条与源 decisions.jsonl 记录比对 at/tool/rule/reason/effectiveDecision/wouldDecision/mode/contractHash/pluginCommit/行号；检查分类枚举、basis/evidence 非空、证据路径存在）→ exit=0；输出 `events= 22 unique_keys= 22 problems= []`、`missing_evidence_paths= []`。
7. contractHash 一致性：142 条决策 vs activation.json → `mismatches= 0`。
8. Git 自查与提交：见任务完成报告（git status --porcelain / git add eval/evidence/b0-offline / git commit / git log -1 --stat）。

## 10. 清单勾选（harness-assets/checklists/code-task.md 自报）

- [x] 复述任务目标与验收标准，确认与任务板描述一致（task-16 rev3：22 deny 分类+父映射+双条件+总量，产物 ledger.md+events.jsonl）
- [x] 列出允许修改范围并核对未越界（仅新增 eval/evidence/b0-offline/ 两文件；g1-exp 全程只读）
- [x] 确认未创建范围外额外目录/文件（中间提取件在 /tmp/b0-ledger-work/，系统临时目录，任务结束清理）
- [x] 改动内容无凭据/token/密钥（产物仅含本机路径、公开仓名、commit SHA、决策原文）
- [x] 命令无危险操作（无 rm -rf/git clean/覆盖写；git 仅 cat-file/ls-tree/diff/log/status/rev-parse/add/commit）
- [x] 未覆盖/清理/修改他人既有改动（基线工作树 clean；Devin 4 文件已由 task-17 收编，本任务未触碰）
- [x] 回滚点已记录：HEAD=25795b8c4f5451ee87dfe1f08c385ae087b03f54；恢复步骤：`git -C /Users/zm/repos/hephi-review-main revert <本提交>` 或删除 eval/evidence/b0-offline/ 两文件后提交（纯新增，无既有文件依赖）
- [x] 未执行回滚（不适用）
- [x] 每个产出文件有真实验证命令（events.jsonl：§9.6 逐字段比对；ledger.md：§9.1-7 数据复核 + 人工核对表格与 events 一致）
- [x] 记录命令原文、退出码与关键输出（§9）
- [x] 验证失败如实标记（本任务验证全过；历史 blocked/running/未知项在 §8 如实登记，未写成 pass）
- [x] git status 确认只有预期文件（提交前 porcelain 仅 ?? eval/evidence/b0-offline/）
- [x] 三类 diff 自查（tracked 无修改；untracked 新增两文件逐个查看内容后暂存）
- [x] 未夹带无关改动（git add 精确目录，禁 git add .）
- [x] 提交信息准确描述变更
- [x] 提交后 git log -1 --stat 核对（见完成报告）