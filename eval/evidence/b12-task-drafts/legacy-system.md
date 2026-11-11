# B1.2 遗留系统场景：Dubbo 探查父任务清单草案（12 = B2×6 + B3×6）

- 任务：task-23（v5.4 B1.2）。执行者：hephi-rca。日期：2026-11-12。
- 基线：`agent/task-contract-standard-20261111` @ `93fee341bcfb0c9bab98013efc176150ec0f3949`。
- 性质：**草案，等待负责人批准；不构成任务冻结。** 本文档不执行任何付费运行。
- 判据口径：v5.4 §6.5「遗留系统：Dubbo，优先训练截止后的修复」、§7 B1 行（`git show docs/hephi-plan-v5.4:docs/hephi-95-plan-v5.4-20261112.md` 第 294、404 行）；D-5（`eval/approvals/2026-11-11-unrelated-refactor-track-decisions.md:43`）。

## 0. 前置阻塞（先读，决定本清单整体状态）

| # | 前置 | 现状 | 结论 |
| --- | --- | --- | --- |
| 1 | Dubbo 项目检查配置 | `hephi/docs/project-config.md` 无 Dubbo 条目（本次 `grep -in dubbo` 0 命中，实测 2026-11-12） | **缺，待批**（D-5：须作为明确任务补齐并经负责人批准，不自动编造） |
| 2 | Dubbo 仓可 clone | `git ls-remote --heads https://github.com/apache/dubbo.git` exit 0（heads 2.5.x/2.6.x/2.7.x 可见，2026-11-12 实测）；完整 clone **未执行** | 远端可达；浅 clone 可行性高，全量 clone 体量未测 |
| 3 | 训练截止后可用修复数清点 | **未执行**（需先明确所用模型的训练截止日期，再经 GitHub issue/PR 清点；本任务卡未给截止日期） | 待核对，见 feasibility.md §3 |
| 4 | Java/Maven 构建环境（前置 P10） | 未核对（不属本卡范围） | 待核对 |

**在 1/3 补齐前，本清单全部 12 个父任务状态为「待批」，不得进入任何运行。**

## 1. 清单结构约定（与 v5.4 §6.5/§6.6 对齐）

- 每场景 12 个探查父任务 = B2 开发集试验 6 个 + B3 基线探查 6 个，**两组互不重叠**（v5.4 第 297 行：三组任务各自独立）。
- 每个父任务须交付：任务来源（Dubbo issue/commit）、两组等价需求卡（实验组=任务卡 v3：`outOfScope` 必填两类（v5.4 §3.1 第 85 行）+ 硬预算；对照组=同需求不带合同增强的等价卡，两组正文差异只允许是合同标准项）、环境（base commit、Maven 离线构建）、隐藏参考验收（`hidden-test.sh` 约定按 `eval/tasks/README.md` §1/§3：只依赖任务仓库已有工具链、不访问网络）。
- 目录落位：`eval/tasks/dubbo/<taskId>/`，先过 `eval/check-task.mjs` 结构校验（`eval/tasks/README.md` 头部约定）。
- 复用 B0 经验：父任务构造口径 = `eval/evidence/b0-offline/ledger.md` §3（activation.task.goal + item.id + 仓库 + PROGRESS 终态交叉核对；重投沿用父 ID、墙钟按父任务起止）。

## 2. B2 开发集试验（6 个父任务草案）

选型原则：训练截止后的真实修复优先；六类任务按 `eval/tasks/README.md` §2 类别枚举分层（defect-fix / behavior-preserving-refactor / new-feature / cross-module 各至少 1）；模块覆盖 dubbo-common / dubbo-config / dubbo-remoting / dubbo-registry / dubbo-cluster / dubbo-qos（模块名以实际 clone 后的仓结构核对为准，**未经 clone 核对前按 Apache Dubbo 公开结构假设标注**）。

| # | taskId（草案） | 类别 | 目标模块（待核对） | 任务来源（待清点） | 两组等价需求 | 环境 | 隐藏参考验收 | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| L-B2-1 | `dubbo-config-default-override` | defect-fix | dubbo-config / dubbo-api | 训练截止后的真实 issue（URL 参数/默认值覆盖顺序缺陷类） | v3 卡（outOfScope：必须保留的对外行为=配置键兼容；不得改动=dubbo-remoting 序列化）vs 等价平卡 | base=修复前一 commit；Maven 离线（P10） | 参考修复回放 + 该 issue 的回归测试（hidden-test.sh，baseMustFail/referenceMustPass=true） | **待批**（前置 1/3） |
| L-B2-2 | `dubbo-common-url-params` | defect-fix | dubbo-common（URL 参数处理） | 同上 | v3 vs 平卡 | 同上 | 同上 | **待批** |
| L-B2-3 | `dubbo-registry-notify-order` | defect-fix | dubbo-registry-api（通知顺序/重试） | 同上 | v3 vs 平卡 | 同上 | 同上 | **待批** |
| L-B2-4 | `dubbo-serialization-compat` | behavior-preserving-refactor | dubbo-remoting（序列化兼容层） | 构造：以真实兼容性 commit 为参考修复（保留对外行为） | v3 卡 outOfScope 两类=序列化格式契约；平卡 | 同上 | 旧格式回放用例（隐藏） | **待批** |
| L-B2-5 | `dubbo-cluster-fallback-policy` | new-feature | dubbo-cluster（新 fallback 策略配置项） | 构造：仿既有策略新增 | v3 vs 平卡 | 同上 | 新策略行为测试（隐藏） | **待批** |
| L-B2-6 | `dubbo-qos-command-flags` | new-feature | dubbo-qos（命令行参数扩展） | 构造 | v3 vs 平卡 | 同上 | qos 输出断言（隐藏） | **待批** |

注：B2 需用真实审查退回/硬预算误拦等机制试验（v5.4 §7 B2 行），故 6 张偏机制可复现的中小粒度真实修复，尽量覆盖 deny 规则分布（B0 ledger §1：check.blocked/plan.recorded/ready.red-missing/scope.* 等）。

## 3. B3 基线探查（6 个父任务草案，与 §2 互不重叠）

选型原则：只跑对照组口径的基线探查；粒度允许略大；同样优先训练截止后修复。

| # | taskId（草案） | 类别 | 目标模块（待核对） | 任务来源 | 两组等价需求 | 环境 | 隐藏参考验收 | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| L-B3-1 | `dubbo-filter-chain-order` | defect-fix | dubbo-common filter 链 | 训练截止后真实 issue | v3 vs 平卡（探查只跑对照口径，但两卡都先备好） | 同 §2 | 隐藏回归测试 | **待批** |
| L-B3-2 | `dubbo-metadata-report-sync` | defect-fix | dubbo-metadata-report | 同上 | 同上 | 同上 | 同上 | **待批** |
| L-B3-3 | `dubbo-remoting-timeout` | defect-fix | dubbo-remoting-timeout | 同上 | 同上 | 同上 | 同上 | **待批** |
| L-B3-4 | `dubbo-config-center-nacos` | cross-module | dubbo-config-center（适配层） | 同上 | 同上 | 同上 | 同上 | **待批** |
| L-B3-5 | `dubbo-proxy-protocol-mapping` | cross-module | dubbo-proxy + dubbo-remoting-api | 同上 | 同上 | 同上 | 同上 | **待批** |
| L-B3-6 | `dubbo-benchmark-harness` | behavior-preserving-refactor | dubbo-benchmark | 构造 | 同上 | 同上 | 行为保持断言 | **待批** |

## 4. 每父任务的交付物 checklist（构造完成判据）

- [ ] `task.json`（schemaVersion=1、40 位 base SHA、category、checks.baseMustFail/referenceMustPass=true，`eval/tasks/README.md` §2）
- [ ] `issue.md` 两版（实验/对照，`## 任务/## 验收/## 合法范围` 三节）
- [ ] `hidden-test.sh`（离线、无网络、退出码语义）
- [ ] `review.md`（两名评审者 + 裁决）
- [ ] `reference.patch` + 在自己合同下能完成的自证（v5.4 §7 B1 出口条件）
- [ ] 重投沿用父 ID、墙钟按父任务起止（B0 口径）

## 5. 明确未做

- 未 clone Dubbo、未清点训练截止后修复数、未编造任何 issue 编号；模块名与类别落位以 clone 后核对为准。
- 未构造任何 task.json/issue.md 实体文件（本卡只出清单草案；构造属 B1 后续且需前置 1/3 补齐）。
- 未执行任何付费运行。
