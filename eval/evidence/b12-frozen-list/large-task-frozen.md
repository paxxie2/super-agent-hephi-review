# B1.2 大任务可构造项冻结清单（正式草案，11 项）+ 1 项待批

- 任务：task-26（v5.4 B1.2）。执行者：hephi-sync。日期：2026-11-12。
- 基线：`agent/v54-batch2-20261112` @ `b4b74ade505b8f605c9b9038259832fcdff3a7c0`（回滚点，main 已合并 PR #91=b4b74ad，历史 commit 均仍在）。
- 上游草案：`eval/evidence/b12-task-drafts/large-task.md`（hephi-rca，task-23）。本文件将其 11 个"可构造"项冻结为正式清单草案；**G-B2-1 维持"待批"不冻结**（依赖 v5.4 §3.4 产物钉 SHA，负责人前置处置项）。
- 性质：清单冻结草案 + v3 任务卡草案；**未跑任何付费任务、未改源码**。正式启用（B2/B3 投跑）仍待负责人批准。
- 经验注入：pack_sha256=4768c226ffac53544196458bb74fc4137678fb996af5f135163beb3552054673。

## 0. 引用 commit 核对结果（本仓 b4b74ad 上实测）

| commit | 存在 | 全 SHA | 父提交（= 该项参考 baseSha） | 规模（`git diff --stat <parent> <commit>`） | 模块跨度 |
| --- | --- | --- | --- | --- | --- |
| `c2cece1` | ✓ | c2cece1e5d6a6fcfbb64a7af1024ec649bc38afa | `88920d3` | 1 file, +1/−1 | eval/approvals（仅决定记录，G-B2-1 待批项） |
| `ea0c544` | ✓ | ea0c5447448f92bf23ad8e953746780cc89f755a | `a5dc826` | 2 files, +887/−0 | hephi/scripts, hephi/docs/validation |
| `c49b992` | ✓ | c49b992262d72f9e05a78a2eee4af81161642842 | `5efbf6a` | 6 files, +1226/−54 | hephi/scripts, hephi/tests/probes, docs |
| `da6a388` | ✓ | da6a38804e6dbe80c59a358e02b3014a43e617e8 | `62ea0b9` | 11 files, +526/−0 | hephi/docs/validation(+e2e) |
| `2409613` | ✓ | 240961395ce0fb323683bab21830fbdc123257d8 | `17d3827` | 3 files, +376/−101 | scripts/host, hephi/tests/control |
| `5e037bf` | ✓ | 5e037bfe55f1ea8d41bacf177e13c1fda3c4febd | `858711a` | 2 files, +651/−0 | eval（B7.md + b7-matrix.mjs） |
| `875624c` | ✓ | 875624c35936c065ecd2d3d450c95e120d50ecdb | `8b4740e`（p1）/ `e0dc82d`（p2，merge） | 214 files, +16608/−413 | eval/{evidence,t21-prep,g1-configs,label,schema,stats} 等 |
| `9fa8598` | ✓ | 9fa8598f2beabe179b28733e484275c3775279d3 | `2c603c6` | 2 files, +100/−8 | docs（部署前置决定，G-B3-1 演化引证） |
| `220e67e`（任务集引入线） | ✓ | —（parent `0b7bada`） | `0b7bada` | 126 files, +14227/−57 | eval/tasks/hephi + eval/tasks/site-pnl-diagnosis |

reference.patch 行数实测（`wc -l`）：record-run 1121、daily-export-rework 919、b7-matrix 663、ab-metrics-mechanical 640、repro-manifest 584（均在 `eval/tasks/hephi/`）；frontend-form-feedback 1342、restore-health-service-id 828、restore-data-package 679（在 `eval/tasks/site-pnl-diagnosis/`）。草案 §0「4 张 vs 实测 8 张 ≥500 行」口径差异仍未裁决（feasibility.md §4 登记），不影响本清单 11 项。

## 1. 冻结清单（11 项可构造；分组互不重叠）

### B2 开发集（5 项冻结 + G-B2-1 待批）

| # | taskId | 参考修复与精确 baseSha | 里程碑 | 隐藏参考验收命令 | 锚点状态 | 卡文件 |
| --- | --- | --- | --- | --- | --- | --- |
| G-B2-2 | `a2-evidence-chain-probe` | ea0c544(base `a5dc826`)+c49b992(base `5efbf6a`)+da6a388(base `62ea0b9`) | M1 探针→M2 模板→M3 夹具→M4 文档 | `node hephi/scripts/check-binding-host.mjs --self-test` + `cd hephi && npx vitest run tests/probes` | **已执行**（§2-A/B：exit 0，SELF-TEST: PASS；probes 含于 140 passed run） | cards/g-b2-2-a2-evidence-chain-probe.json |
| G-B2-3 | `record-run-runbook-chain` | `eval/tasks/hephi/record-run/reference.patch`（1121 行，引入线 220e67e base `0b7bada`） | M1 采集→M2 schema→M3 导出比对 | `node eval/record-run.mjs --self-test` | **已执行**（§2-C：exit 0，26 断言） | cards/g-b2-3-record-run-runbook-chain.json |
| G-B2-4 | `daily-export-rework-cross` | `eval/tasks/hephi/daily-export-rework/reference.patch`（919 行，引入线 220e67e base `0b7bada`） | M1 数据层→M2 导出器→M3 校验器 | 目标交付物自备内建自测（同 record-run 模式） | **待构造**（自测属未来交付物方案，非已执行锚点） | cards/g-b2-4-daily-export-rework-cross.json |
| G-B2-5 | `b7-multi-repo-matrix` | 5e037bf（base `858711a`，eval/B7.md+b7-matrix.mjs，+651） | M1 矩阵定义→M2 环境探测→M3 报告 | `node eval/b7-matrix.mjs --self-test` | **已执行**（§2-D：exit 0，36 assertions） | cards/g-b2-5-b7-multi-repo-matrix.json |
| G-B2-6 | `deploy-suite-hardening` | 2409613（base `17d3827`，deploy-hephi.sh+test-deploy-hephi.mjs+deploy-script.test.ts，+376/−101） | M1 脚本→M2 wrapper 断言→M3 负例集 | `cd hephi && npx vitest run tests/control/deploy-script.test.ts` + `node scripts/host/test-deploy-hephi.mjs`（假宿主） | **部分已执行**：vitest 段未单独运行过（仅含于 §2-F 整目录 498 passed）；test-deploy-hephi.mjs 段**待构造**（假宿主面，投跑前由 hidden-test 落地） | cards/g-b2-6-deploy-suite-hardening.json |

### B3 基线探查（6 项，与 B2 及 site-pnl-diagnosis 22 卡保留集互不重叠）

| # | taskId | 参考实现线与 baseSha 语义 | 里程碑 | 隐藏参考验收命令 | 锚点状态 | 卡文件 |
| --- | --- | --- | --- | --- | --- | --- |
| G-B3-1 | `evidence-verifier-a1out` | `hephi/src/control/evidence-verifier.ts`（末次 38f1cd7，父 790223e）；演化引证 9fa8598 线（base `2c603c6`） | M1 前台 kind 校验→M2 lossy 拒绝→M3 ready 映射 | `cd hephi && npx vitest run tests/control/evidence-verifier.test.ts` | **已执行**（该文件含于 §2-B 140 passed run 与 §2-F 整目录 498 passed，未单独运行） | cards/g-b3-1-evidence-verifier-a1out.json |
| G-B3-2 | `activation-binding-policy` | `hephi/src/control/activation.ts`（末次 71abbe0；a2-final §6.1 引证 activation.ts:221-229 effective 计算） | M1 policy 计算→M2 环境开关→M3 合同冻结 | `cd hephi && npx vitest run tests/control/activation.test.ts tests/control/activation-marker.test.ts` | **已执行**（§2-G：exit 0，Test Files 2 passed，Tests 48 passed——task-31 补跑，覆盖 activation-marker，原 140 run 不含该文件） | cards/g-b3-2-activation-binding-policy.json |
| G-B3-3 | `stage-control-recovery` | `hephi/src/control/stage-mount.ts`（基线导入 83a79c2）+ `hephi/docs/stage-control.md` | M1 状态机→M2 readSession 恢复→M3 preflight | `cd hephi && npx vitest run tests/control`（整目录） | **已执行**（§2-F：exit 0，Test Files 28 passed，Tests 498 passed——task-31 补跑全绿基线记录） | cards/g-b3-3-stage-control-recovery.json |
| G-B3-4 | `shadow-mode-parity` | `hephi/docs/enforcement-modes.md` 已实施部分 + `scripts/experimental/check-shadow-parity.mjs`（末次 1ea45b9） | M1 决策日志→M2 allowUnavailable→M3 parity 比对 | `node scripts/experimental/check-shadow-parity.mjs` 对已导出清单跑通 | **已实现未执行**（脚本在库（1ea45b9），真实对照导出依赖宿主操作者，当前环境无该导出；边界按 enforcement-modes.md:22-23） | cards/g-b3-4-shadow-mode-parity.json |
| G-B3-5 | `t21-retention-sweep` | 875624c（merge，p1 base `8b4740e`）：T01–T20 + T21 prep，eval/evidence/t21-prep/（含 SHA256SUMS 29 行） | M1 manifest→M2 全模扫描→M3 哈希登记 | `cd eval/evidence/t21-prep && shasum -a 256 -c SHA256SUMS` | **已执行**（§2-H：exit 0，29 项全 OK） | cards/g-b3-5-t21-retention-sweep.json |
| G-B3-6 | `ab-metrics-mechanical-plus` | `eval/tasks/hephi/ab-metrics-mechanical/reference.patch`（640 行，引入线 220e67e base `0b7bada`） | M1 指标定义→M2 机械统计→M3 报告 | 公开面：目标交付物内建自测；隐藏面：hidden-test.sh 扩展由**独立验收方**在隔离面完成（B-03 责任划分，Worker 卡不含 hidden-test 写权限） | **待构造**（公开自测与隐藏扩展均为未来交付物，非已执行锚点） | cards/g-b3-6-ab-metrics-mechanical-plus.json |

### 不冻结（1 项待批）

- **G-B2-1 `contract-standard-and-lint`**：参考 c2cece1 线（base `88920d3`，仅 +1/−1 决定记录；实际跨模块产物线见 v5.4 §3.4）。待批原因：§3.4 产物尚未按 v5.4 要求提交钉死 SHA（v5.4 第 132 行），须负责人先处置；处置前不生成卡。

### B4 正式组

- 按 legacy-system.md §1 约定**另选**，不在本清单。分组不重叠的依据**按内容与测试面**声明：B2 项的改动面/测试面在 hephi/scripts+probes、eval/record-run·daily-export·b7-matrix、scripts/host 部署链；B3 项在 hephi/src/control 三个控制模块（evidence-verifier/activation/stage-mount）、shadow parity 实验脚本、t21 归档清点、ab-metrics 指标——两集合无共享 paths/test 文件，且均不复用 site-pnl-diagnosis 22 卡的改动面；taskId 唯一性（`g-*` 新前缀，不占 b5-tasks.json 22 项）仅是辅助标识，不是不重叠的证明。

## 2. 隐藏参考验收锚点实测记录（命令原文 + 退出码 + 关键输出）

已执行锚点（A–H，2026-11-12，main 上实测）：

| # | 命令原文 | 退出码 | 关键输出 |
| --- | --- | --- | --- |
| A | `node hephi/scripts/check-binding-host.mjs --self-test` | 0 | `SELF-TEST: PASS` |
| B | `cd hephi && npx vitest run tests/probes tests/control/evidence-verifier.test.ts tests/control/activation.test.ts` | 0 | `Test Files 7 passed；Tests 140 passed (140)`（覆盖 probes + evidence-verifier + activation；**不含 activation-marker**） |
| C | `node eval/record-run.mjs --self-test` | 0 | `SELF-TEST: PASS（26 条断言…）` |
| D | `node eval/b7-matrix.mjs --self-test` | 0 | `PASS: 36 assertions (b7-matrix self-test)` |
| F | `cd hephi && npx vitest run tests/control` | 0 | `Test Files 28 passed (28)；Tests 498 passed (498)`（task-31 补跑整目录全绿基线） |
| G | `cd hephi && npx vitest run tests/control/activation.test.ts tests/control/activation-marker.test.ts` | 0 | `Test Files 2 passed (2)；Tests 48 passed (48)`（task-31 补跑，覆盖 activation-marker，修正原 140 声明） |
| H | `cd eval/evidence/t21-prep && shasum -a 256 -c SHA256SUMS` | 0 | 29 行全 OK |

（编号保留 A–H 习惯位；E 位无独立运行——evidence-verifier 单文件未单独跑过，只含于 B 与 F，§1 引用如实写"含于 B/F"。）

未执行锚点（如实标注）：

| 命令原文 | 状态 | 原因 |
| --- | --- | --- |
| `node scripts/experimental/check-shadow-parity.mjs` | 已实现未执行 | 依赖宿主操作者导出的真实对照清单，当前环境无该导出（G-B3-4 边界按 enforcement-modes.md:22-23） |
| `node scripts/host/test-deploy-hephi.mjs` | 待构造 | G-B2-6 假宿主面锚点，投跑前由 hidden-test 落地 |

## 3. 卡草案说明

- 每项一张 v3 卡（`version:3, kind:code`，goal/outOfScope/acceptance[].id/text/check/paths/tests），存放于 `cards/`；隐藏验收命令**不写入卡内**（卡是 Worker 可见面），仅登记于本文件 §1/§2。卡内验收文本只写可观察行为（如"内建自测场景全部通过（exit 0）"），不出现具体命令行。
- **task-30 修复（2026-11-12，Kimi blocking）**：① 原 4 处目录 pattern（`hephi/docs/validation/`、`eval/schema/`、`eval/evidence/t21-prep/`、`hephi/tests/control/`）在 allowedPath 的 `node:path.matchesGlob` 语义下不匹配内部文件（Lead 实测 `matchesGlob(file,'dir/')=false`），已全部改为精确文件路径或 `dir/**`；g-b3-5 的清点工具落位约定为 `eval/retention-sweep.mjs`（新文件，登记于 allowedPaths）。② g-b2-2/g-b2-3/g-b2-4/g-b2-5/g-b3-5 卡内文本原先泄漏隐藏锚点命令原文，已改为行为描述，命令原文仅保留在本文件 §1/§2。③ 每张卡补齐 lint 必需的 envelope 字段（`ticketId`/`allowedPaths`/`checks`，check 为真实可跑的 `pnpm test`@hephi 回归），11 张卡全部通过真实 `node hephi/lib/cli.mjs lint-task`（见 §3.1）。
- 里程碑拆分只发生在实验组且须先过 B2 拆卡跑通（v5.4 §3.3 第 123 行）；对照组用平卡。v3 卡 outOfScope 两类（保留行为 + 禁改模块）按 issue-with-task-card.md §7。
- `budget` 均未填写（未获"超出即拒绝"授权）；预估规模记在 §0 表。

### 3.1 lint 实测记录（命令原文 + 退出码，2026-11-12，main @ 63ba85b）

命令：`node hephi/lib/cli.mjs lint-task eval/evidence/b12-frozen-list/cards/<card>.json`，11 张卡逐一执行，**全部 exit 0，输出 `HEPHI task lint: PASS <card> (acceptance=2 checks=1 allowedPaths=N)`**：

| 卡 | allowedPaths 数 | 退出码 |
| --- | --- | --- |
| g-b2-2-a2-evidence-chain-probe | 3 | 0 |
| g-b2-3-record-run-runbook-chain | 2 | 0 |
| g-b2-4-daily-export-rework-cross | 1 | 0 |
| g-b2-5-b7-multi-repo-matrix | 2 | 0 |
| g-b2-6-deploy-suite-hardening | 3 | 0 |
| g-b3-1-evidence-verifier-a1out | 2 | 0 |
| g-b3-2-activation-binding-policy | 1 | 0 |
| g-b3-3-stage-control-recovery | 2 | 0 |
| g-b3-4-shadow-mode-parity | 2 | 0 |
| g-b3-5-t21-retention-sweep | 2 | 0 |
| g-b3-6-ab-metrics-mechanical-plus | 1 | 0 |

glob 修复真实性核对（`node:path.matchesGlob` 实测）：`hephi/docs/validation/x.md`→`hephi/docs/validation/**`=true；`eval/evidence/t21-prep/SHA256SUMS`→精确路径=true；`hephi/tests/control/a.test.ts`→`hephi/tests/control/**`=true；`eval/schema/run.schema.json`→精确路径=true。11 张卡 JSON.parse 全部 OK。

## 4. 明确未做

- 未构造 task.json/issue.md 实体（那是冻结批准后的 B1.3 步骤）；未跑付费任务；未改源码；未裁决「4 张 vs 8 张」口径差异。
- 未执行 merge/rebase/checkout/clean/stash。

## 5. 自测与回滚

- task-26 回滚点：`git reset --hard b4b74ade505b8f605c9b9038259832fcdff3a7c0`；task-30 修复回滚点：`git reset --hard 63ba85b347836a0ea33d3ad36c9d8ca40b86db3e`（main，PR #92 合并后）。
- 两次提交均仅含 `eval/evidence/b12-frozen-list/`（write_scopes 一致），提交后 `git log -1 --stat` 核对。
