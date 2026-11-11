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
