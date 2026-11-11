# B1.2 大任务场景：跨模块/多里程碑探查父任务清单草案（12 = B2×6 + B3×6）

- 任务：task-23（v5.4 B1.2）。执行者：hephi-rca。日期：2026-11-12。
- 基线：`agent/task-contract-standard-20261111` @ `93fee341`（回滚点）。
- 性质：**草案，等待负责人批准；不构成任务冻结。** 本文档不执行任何付费运行。
- 判据口径：v5.4 §6.5「大任务：新构造的跨模块、多里程碑需求」、§3.3 大任务拆卡、§6.2「隐藏参考验收测试为主判据」（`git show docs/hephi-plan-v5.4:docs/hephi-95-plan-v5.4-20261112.md` 第 110–126、174–194、294–297 行）。

## 0. 来源与构造方式

- 主来源：**本仓（hephi-review-main）自身历史中已合入的真实跨模块改动**——参考修复天然存在（历史 commit 即参考 patch），环境即本仓（Node/pnpm，`cd hephi && pnpm check` 已知可跑，见 `docs/remediation-r3-validation.md:169` 的既有实测），无 Dubbo 式前置阻塞。
- 种子参考：v5.4 §6.5 记「现有只有 4 张参考修复超过 500 行」；本次实测 `eval/tasks/` 下 reference.patch 行数 ≥500 的有 **8 张**（frontend-form-feedback 1342、record-run 1121、daily-export-rework 919、restore-health-service-id 828、restore-data-package 679、b7-matrix 663、ab-metrics-mechanical 640、repro-manifest 584）——**与「4 张」口径不一致，差异如实标注，待负责人确认口径**（可能按父任务/文件数去重）。
- 每个父任务 = 一个原始需求（v5.4 §6.1 计数单位），按里程碑拆卡只发生在实验组且须先过 B2 拆卡跑通（§3.3 第 123 行）；对照组不拆卡。
- B4 入选规则、两组等价卡差异（v3 卡 outOfScope 两类 + 硬预算 vs 等价平卡）同 legacy-system.md §1 约定。

## 1. B2 开发集试验（6 个父任务草案）

选型原则：优先跨 ≥2 模块、历史确有参考修复、能写隐藏参考验收（最终合成 HEAD 上跑 `cd hephi && pnpm check` + 定向 vitest）的需求；B2 中须有 ≥1 个用于跑通 §3.3 拆卡串联与机械合成（v5.4 第 123–126 行）。

| # | taskId（草案） | 里程碑拆分（实验组） | 参考修复来源（本仓历史，已核对 commit 存在） | 两组等价需求 | 隐藏参考验收（草案） | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| G-B2-1 | `contract-standard-and-lint`（合同标准 + lint 提示落地） | M1 cli.ts 结构校验 → M2 project-config.md 模板 → M3 issue-with-task-card 模板 → M4 approvals 决定记录 | `c2cece1`（v5.4 §3.4 记录的 4 文件跨模块改动线） | v3 卡（outOfScope：不改既有合同哈希算法；不得动 activation.ts 生效逻辑）vs 平卡 | `pnpm check` + lint 14 项用例集 | **待批**（§3.4 产物尚未按 v5.4 要求提交钉死 SHA，见 v5.4 第 132 行；须先由负责人处置） |
| G-B2-2 | `a2-evidence-chain-probe`（只读探针 + 模板 + 定案） | M1 探针脚本 → M2 判定模板 → M3 自测夹具 → M4 验证文档 | `ea0c544` + `c49b992`（path-B 识别）+ `da6a388`（A 线验收记录） | v3 vs 平卡 | `node hephi/scripts/check-binding-host.mjs --self-test` exit 0 + vitest probes 套件 | **可构造**（参考修复在历史中、环境本仓可跑；正式启用仍待批） |
| G-B2-3 | `record-run-runbook-chain`（运行记录→schema→导出） | M1 采集 → M2 schema 校验 → M3 导出比对 | `eval/tasks/hephi/record-run/reference.patch`（1121 行）+ 对应历史线 | v3 vs 平卡 | record-run 任务既有 hidden-test.sh 扩展 | **可构造** |
| G-B2-4 | `daily-export-rework-cross` | M1 数据层 → M2 导出器 → M3 校验器 | `eval/tasks/hephi/daily-export-rework/`（919 行，cross-module） | v3 vs 平卡 | 同上模式 | **可构造** |
| G-B2-5 | `b7-multi-repo-matrix`（多项目/多模型准备矩阵） | M1 矩阵定义 → M2 环境探测 → M3 报告生成 | `5e037bf`（B7: multi-project/multi-model preparation matrix） | v3 vs 平卡 | b7-matrix 任务 hidden-test.sh 扩展 | **可构造** |
| G-B2-6 | `deploy-suite-hardening`（部署脚本 + 门禁 + 回滚） | M1 脚本 → M2 wrapper 断言 → M3 负例集 | `2409613`（PR #20 返修：3 文件，69 断言，实测见 `docs/remediation-r3-validation.md:169`） | v3 vs 平卡 | `test-deploy-hephi.mjs` 69+ 断言全过 | **可构造**（注意排空门禁在真实宿主 fail-closed 的既有 blocked 史，测试面用假宿主即可） |

## 2. B3 基线探查（6 个父任务草案，与 §1 互不重叠）

| # | taskId（草案） | 里程碑拆分（实验组） | 参考修复来源 | 两组等价需求 | 隐藏参考验收（草案） | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| G-B3-1 | `evidence-verifier-a1out`（A1-OUT fail-closed 链） | M1 前台 kind 校验 → M2 jobs.readAt lossy 拒绝 → M3 ready 映射 | `hephi/src/control/evidence-verifier.ts` 现势由 `9fa8598` 线演化（`docs/host-runtime-probe-record.md` §3/§9 引证） | v3 vs 平卡 | hephi/tests/control 对应 vitest 套件 | **可构造** |
| G-B3-2 | `activation-binding-policy`（绑定开关 + 合同哈希） | M1 policy 计算 → M2 环境开关 → M3 合同冻结 | `hephi/src/control/activation.ts`（effective 计算线，a2-final §6.1 引证 `activation.ts:221-229`） | v3 vs 平卡 | activation vitest | **可构造** |
| G-B3-3 | `stage-control-recovery`（staged 阶段控制 + 快照恢复） | M1 状态机 → M2 readSession 恢复 → M3 preflight | `hephi/src/control/stage-mount.ts` + `hephi/docs/stage-control.md` 既有实现线 | v3 vs 平卡 | stage-control 测试套件 | **可构造** |
| G-B3-4 | `shadow-mode-parity`（P4 shadow 观察面） | M1 决策日志 → M2 allowUnavailable → M3 parity 比对脚本 | `hephi/docs/enforcement-modes.md` 已实施部分 + `scripts/experimental/check-shadow-parity.mjs` | v3 vs 平卡 | parity 脚本对已导出清单跑通 | **可构造**（真实对照导出依赖宿主操作者，未实施部分按 enforcement-modes.md:22-23 标注边界） |
| G-B3-5 | `t21-retention-sweep`（22 卡保留集冻结与清点） | M1 manifest → M2 全模扫描 → M3 哈希登记 | PR #90 线（`875624c`，T01–T20 + T21 prep） | v3 vs 平卡 | manifest 哈希一致性校验 | **可构造** |
| G-B3-6 | `ab-metrics-mechanical-plus`（AB 度量机械统计扩展） | M1 指标定义 → M2 机械统计 → M3 报告 | `eval/tasks/hephi/ab-metrics-mechanical/`（640 行） | v3 vs 平卡 | 既有 hidden-test.sh 扩展 | **可构造** |

## 3. 与既有保留集的不重叠声明

- `eval/tasks/site-pnl-diagnosis` 22 张 = Q1 小修复保留集（v5.4 §6.5「已冻结，不动」），本清单 12 个父任务**不复用**其 taskId；hephi 目录下被引为参考修复来源的 4 张（record-run/daily-export-rework/b7-matrix/ab-metrics-mechanical）在保留集中属 B5 试验用途，大任务父任务将以新 taskId（`g-*` 前缀）落位 `eval/tasks/hephi/`，不与 b5-tasks.json 22 项冲突（同名不占用；正式冻结前由负责人终审）。

## 4. 每父任务的交付物 checklist

同 legacy-system.md §4（task.json / 两版 issue.md / hidden-test.sh / review.md / reference.patch / 合同下自证）。大任务额外：里程碑拆分表 + 串联合成脚本约定（§3.3：合成按脚本完成，验收按父任务整份改动评）。

## 5. 明确未做

- 未构造任何 task.json/issue.md 实体文件；未跑任何付费运行。
- 「4 张 vs 实测 8 张 >500 行」口径差异未裁决（feasibility.md §4 登记）。
- G-B2-1 依赖 v5.4 §3.4 未提交产物先钉 SHA，属负责人前置处置项。
