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

- 宿主端口均拒绝连接，三个实例目录、数据库和启动脚本仍在。三个 profile 的插件链接目标缺失。上表“g1 实例目录已删”已更正；3086 尚有一张无 ended 记录的旧票。
- T08 的 11 项为 B4 标签缺失及基线不变性的合成聚焦测试。Q4 正确/错误制品 SHA 两条路径未核验。完整 T08 仍为部分验证。
- D-10、D-11 已受托决定沿用 v5.3。D-8 以 −10pp 作估样依据，正式冻结仍须等 B3 成本与可行性数据，见决定记录末节。
- T02 已补核历史 18 个 Worker 会话的原始 usage。989 条已记录合计 67,178,636 tokens；1 条消息缺 usage、4 个已启动 step 缺消息，审查、人工和实付未覆盖。真实端到端未验证通过。
