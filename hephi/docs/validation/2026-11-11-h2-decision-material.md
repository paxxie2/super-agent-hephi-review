# H2 修复决策材料：判据修订 vs 宿主结构化（2026-11-11）

> **重建版（2026-11-12 重建），依据：`hephi/docs/validation/2026-11-07-a2-final.md` L55/L68-69、`hephi/docs/validation/2026-11-07-evidence-chain-host.md` L147-156、`eval/evidence/t10-host-verification/report.md` L23/L98-111/L129-139/L171-187、`eval/evidence/a2a3-binding-decision/material.md` L8-27/L56-60/L103、v5.4 计划附录 A（`git show docs/hephi-plan-v5.4:docs/hephi-95-plan-v5.4-20261112.md` L576-594）、exp-log exp-040/043，非原始文件。**
> 原文件建于已删除分支 `agent/roadmap95`；`git log --all -- hephi/docs/validation/2026-11-11-h2-decision-material.md` = 0 commits（2026-11-12 实测）。
> 状态：**决策材料，不实施修复，不改判据/开关默认值**。决策权在负责人/主持。
> 经验注入：Lead 给定 `pack_sha256=4768c226…`（本地不可复现，日志已 append 至 45 行，见文末）；按任务卡点名 exp-028/029/040/043 读取。

## 1. H2 现状（现存证据逐条核对）

### 1.1 判据原文

`hephi/docs/validation/2026-11-07-evidence-chain-host.md:152`（§7 H1–H6 判定表 H2 行）：

> 前台 `tool/result.message.value` 有结构化 `kind`；`foreground` 带整数 `exitCode`；`promoted/background` 带 `jobId` 且无最终退出码

判据要求"自动（需要 session）"，失败判定为"缺结构化 value、kind 未知、promoted 带最终退出码或前台无 exitCode"。

### 1.2 定案与复现

- **A2 历史定案 fail**（`2026-11-07-a2-final.md:55`）：`bashResultCount=16`、`structuredValueCount=0`、`kinds=[]`；退出码只以文本 `[exit code: N]` 出现；`:68-69` 记 16 条前台 bash result 全部 `hasStructuredValue=false`。
- **2026-11-12 T10 在新真实快照复现**（`eval/evidence/t10-host-verification/report.md:23`）：264 个事件、`tool/result` 结构化 value = 0，`job/registered` 22 + `job/settled` 22。
- **消费方已按结构化契约实现**：`hephi/src/control/check-runner.ts:468-469`（foreground+整数 exitCode 才接受）、`:574`（未知 kind 抛错）；A1-BIND path A 要求 `message.value`（`hephi/src/control/evidence-verifier.ts:133-135`，宿主真实形状仍以 `:45` 的 `FI-FIXME(H2)` 标注）。

### 1.3 文本编码的实际后果（T10 §3.2）

- path-B（`job/registered`+`job/settled`）**不持久化 stdout**（`report.md:103-105`），因此 binding on 时 A1-OUT 无法重建权威输出 → 合法前台交付被拒 `ready.output-unverified`（`report.md:98-111`）。
- v5.4 附录 A 明文（`git show docs/hephi-plan-v5.4:docs/hephi-95-plan-v5.4-20261112.md:585-586`）：「前台检查没有结构化结果的路径会被正确拒绝，这是设计行为；项目只有这条路径可用时，该项目不能用强绑定交付，须写明为部署约束。」
- A2/A3 决策材料把"R1 结构化"列为硬前置 P-2，当前**未满足**（`eval/evidence/a2a3-binding-decision/material.md:22`）。

## 2. 两条候选路径

### 2.1 路径 A：判据修订（等效判据：文本标记 + Job 事件交叉验证）

**内容**：不要求宿主改编码；在指定宿主版本上把 H2 pass 判据改为"末位文本 `[exit code: N]` 与同 Session 的 `job/registered`→`job/settled.detail` 交叉一致"。

- **改动面**：判据表 H2 行 + 探针判定分支（`hephi/scripts/check-binding-host.mjs` 的 `h2Ring`，`:589-624`）+ 自测夹具。
- **优点**：宿主零改动、可立即实施；在已观测样本上可判 pass。
- **风险**：
  1. 文本标记是**约定格式而非契约**，宿主换版改文案即静默失效（版本耦合债务）；
  2. 文本可被 Worker 的 bash 输出内容伪造（输出里打印 `[exit code: 0]`）；交叉验证只能检出与 Job 事件**不一致**的伪造；
  3. 与 Job 事件同时一致的伪造属快照/事件篡改，H2 检出不了，**依赖 H6 结论**（H6 仍 fail，`2026-11-07-a2-final.md:59`）。
- **证据强度**：中（仅在已观测样本上成立；**原版对路径 A 的扫描样本量与不一致样本数已随原文件丢失，未知/待补**）。
- **对 D1 的影响**：H2 转 pass 可解除 A1-BIND 的一个阻断项，但 D1 上限仍由 H6 决定（附录 A L589-594：隔离未验证 → L1/L2 且须完整证据链+默认开启，otherwise L1；`material.md:56-60` 当前判定 **L1**）。

### 2.2 路径 B：等待/推动宿主结构化 `message.value`（R1）

**内容**：不改判据。向 DSH 宿主提需求：Session 持久化 `tool/result.message` 携带结构化 `value`（`kind`/`exitCode`/`jobId`），与判据原文对齐；宿主落地 + A2 复跑 H2 pass 前，A1-BIND 强绑定保持关闭。

- **改动面**：本仓库零代码改动；成本转移到宿主仓库与排期；需要一次新的 A2 复跑（真实生产 Session 快照 + 一次性 profile 双环境）。
- **优点**：结构化字段是显式契约，免疫文本文案变更与文本注入伪造；判据原文不动，无判据债务。
- **风险**：排期不可控（外部依赖）；宿主结构化后仍需处理新旧编码混编（旧快照无 value）；期间强绑定前台合法交付不可用（部署约束）。
- **对 D1 的影响**：与路径 A 相同——H6 不解决则档位不变（`material.md:56-60`）；但 R1 与 R2（隔离）可同批向宿主推进，一次升级解决两个阻断项。

### 2.3 对比总结

| 维度 | A 判据修订 | B 等宿主结构化（R1） |
| --- | --- | --- |
| hephi 侧改动 | `h2Ring` + 判据表 + 夹具（中） | 零（判据不动） |
| 宿主依赖 | 显式标注宿主版本依赖 | 需宿主新功能 + 排期 |
| 证据强度 | 中（约定文本 + Job 交叉验证） | 高（结构化契约，若落地） |
| 防伪（结合 H6 fail） | 文本可被命令输出伪造 | 结构化字段伪造门槛更高，但 H6 未解仍非安全边界 |
| T10 合法路径影响 | 不能解决 path-B 无 stdout（`report.md:98-111`） | 可恢复前台权威输出，解除"部署约束" |
| D1 档位 | 不变（H6 决定） | 不变（H6 决定） |
| 债务/成本 | 版本耦合 + 混编判定 | 无判据债务，有等待成本 |

**共同前提**：H6 fail → 强绑定保持关闭（`2026-11-07-a2-final.md:59`；附录 A L578-584 开启顺序第 1 步=隔离验证）。无论 A/B，均不改变该结论。

## 3. 现状与决策状态

- **决策未决**：A2/A3 材料把"R1/R2 宿主需求单文件补录与推进授权"列为待决策项（`material.md:103`）；T10 结论要求（a）H6 隔离 +（b）R1 结构化或可用后台 Job 路径才能同时满足攻击侧与合法侧（`report.md:181-184`）。
- **当前可声称**：路径 A 在现存证据下**不能**提供可与 H6 解耦的防伪保证；路径 B 是判据原文口径但与宿主排期绑定。
- **不得**据本材料把 H2 记为 pass 或上调 D1/D2（T10 §5：不得据 T10 升级 D1/D2，`report.md:181`）。

## 4. 引用清单与重放命令

```bash
cd /Users/zm/repos/hephi-review-main
sed -n '55p;68,69p' hephi/docs/validation/2026-11-07-a2-final.md        # H2 定案与逐项补充
sed -n '147,156p' hephi/docs/validation/2026-11-07-evidence-chain-host.md  # H1–H6 判据
sed -n '16,111p;129,139p;171,187p' eval/evidence/t10-host-verification/report.md
sed -n '8,27p;56,60p;103p' eval/evidence/a2a3-binding-decision/material.md
git show docs/hephi-plan-v5.4:docs/hephi-95-plan-v5.4-20261112.md | sed -n '576,594p'
sed -n '589,624p' hephi/scripts/check-binding-host.mjs                   # h2Ring
sed -n '45p;133,135p' hephi/src/control/evidence-verifier.ts              # path A 要求
```

## 5. 明确未做 / 未知待补

- 未修改任何代码、判据、判据表或测试；未复跑 A2 探针；未向宿主提需求或评估宿主工作量；未决策 A/B（决策权在负责人/主持）。
- **未知/待补**：原版材料的章节结构与措辞原文；原版路径 A 的扫描样本数字（本机快照批量统计）与不一致样本数；原版是否已实现/登记等效判据修订的提交信息（现行仓无该提交）。
- 经验注入：Lead 给定 `pack_sha256=4768c226ffac53544196458bb74fc4137678fb996af5f135163beb3552054673`；因 experience-log 为 append-only 且已 45 行，本地无法复现该 pack，按任务卡点名 exp-028/029/040/043 读取，不虚构注入。
