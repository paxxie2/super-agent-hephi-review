# 发布流水线 S1–S7（ROADMAP-95 §3.2）

状态（2026-11-08）：S1 脚本已实现；下文保留早期 `73d2862` 的 dry-run/skip-check 结果与限制记录。PR40 在 `0c0b7ac` 记录 545 tests、281 假宿主断言、41 effects-db 检查通过，不能替代真实验收。
当前 main `bc21caca316d6032ebcc3d2bc6387c38e0a3579c` 已部署成功，activation=`verified`，previous=`e490fe34`，部署结束保持暂停；当前版本 A2/A5 完整真实验收仍待执行。
本轮部署保留了首次缺 peer-root、错误目标导致激活缺失/回滚失败及最终修正目标后的成功记录；不能描述为一次无失败通过。原日志 `/tmp/deploy-bc21cac.log` 及其后续编号日志需与最终部署记录一起核对。
部署原件：`/Users/zm/dsh-instances/experiment/logs/deploy-20261107T181639Z-43593.json`（2026-11-07 18:16:39Z / 北京时间 11-08 02:16:39）。
正式 D1/D2/D4/D5 与原两 Ticket 关闭记录见 `../../docs/deployment-prerequisite-decisions-2026-11-07.md`；历史失败不再充作当前缺决策结论。

## 0. 硬边界（先读）

1. **若工作树是宿主实载插件目录**：禁止在该工作树运行 `pnpm build`/`pnpm check`。
   S1 预检只在 `mkdtemp` 临时克隆里构建与测试；手工复核同样必须用独立 clone/worktree。
2. **只改文档/证据的提交不需要重新部署**：不改变运行代码，不产生新构建 SHA，可复用已有构建证据
   （前提是代码树与已验收 SHA 相同）。
3. **任何代码/构建配置/依赖变化 = 新构建 SHA**：即使同一分支后续小提交也必须重新走 S1（必要时 S2–S4）；
   已验收 SHA 的结论只对该构建有效。
4. **实载回读（D4）**：只能用决策日志 `pluginCommit` 或启动日志行证明实载版本；读不到写 `unverified`。
   磁盘哈希/重启时间**不能**替代实载 commit（R3.7/R37 已确认）。
5. **S1 PASS ≠ 真实部署/验收**：S1 只证明候选构建在临时克隆中自测通过；S3 还需 S2 复核通过与外部解阻项。
6. 本文更新不执行宿主操作、推送或部署；实际操作须遵循既有授权及本流水线，失败保留证据。

## 1. 流程总览

| 阶段 | 目的 | 执行者 | 关键命令/入口 | 产物 | 失败处理 |
| --- | --- | --- | --- | --- | --- |
| S1 | 候选构建自测（临时克隆） | 实现方/CI 操作者 | `node scripts/release/preflight.mjs --out <report.json>` | JSON 预检报告（版本、步骤、exit、tail、verdict） | 修候选 → 新提交=新构建 SHA → 重跑 S1；不部署 |
| S2 | 独立复核（必须独立会话/克隆） | 外部复核者 | 见 `hephi/docs/validation/2026-11-07-s2-review-bundle.md` §3 | 复核报告（命令/退出码/发现/是否可合并/是否可进 S3） | Request changes → 回 S1；S2 未通过不得 S3 |
| S3 | 真实部署（停机式排空） | 宿主操作者 | `scripts/host/deploy-hephi.sh --drain effects …` | 部署记录 JSON、releases、健康回读、实载 SHA 回读 | fail-closed/自动恢复 previous/保持 paused/人工接管；不得绕过门禁 |
| S4 | 真实验收 | 操作者 + 复核者 | A5 E2E 矩阵（`hephi/docs/validation/e2e/README.md`）+ A2 H1–H6 | 每场景 E2E 记录（Issue/合同/检查/决策/PR/结论） | blocked/回滚；不得用假宿主/单测补空 |
| S5 | 默认值变更 | 实现方 + 负责人 | 变更默认值（如绑定、executionMode 默认） | 版本/合同变更记录、影响面 | 重新 S1–S4；不得在未验证时改默认 |
| S6 | 合并到 main | 负责人 | 优先 fast-forward；否则 merge commit | main SHA、合并提交构建的冒烟证据 | 合并引入新代码 → 按新构建重跑 S1/S3/S4；否则不合并 |
| S7 | 投入使用 | 负责人/运维 | 切换生产/启用标签/监控 | 投入记录、回滚预案 | 回滚到 previous release；恢复派发由操作者控制 |

## 2. S1：候选构建自测（脚本已实现）

```sh
# 在普通仓库克隆（不是宿主实载工作树）中执行；默认 source=本仓库根，ref=HEAD
node scripts/release/preflight.mjs --out /tmp/s1-preflight.json

# 只看计划，不 clone、不构建：
node scripts/release/preflight.mjs --dry-run --ref HEAD

# 快速验证（跳过 pnpm install/check，仍跑假宿主套件；结果必须如实标注 skip）：
node scripts/release/preflight.mjs --skip-check --out /tmp/s1-skip-check.json
```

- **前置**：source 是普通 git 仓库/克隆且工作树干净；`ref` 可解析（分支/tag/40hex）；
  非 40hex ref 时要求 source `HEAD == ref`；PATH 有 `node`/`pnpm`。
- **步骤**：源校验 → 临时 `git clone --no-hardlinks` + `checkout ref` + 克隆树干净 →
  `hephi/` 下 `pnpm install --frozen-lockfile` + `pnpm check` → 假宿主
  `node scripts/host/test-deploy-hephi.mjs`（PR40 记录 PASS 281；以实际输出核对）+ `node scripts/host/test-effects-db.mjs`（期望 PASS 41）。
- **产物**：JSON 报告 `source/ref/headSha/treeClean/node/pnpm/steps[{name,command,cwd,exit,seconds,tail}]/verdict`；
  `--out` 落盘，否则打印摘要（stdout）+ JSON 报告路径（stderr）。
- **失败处理**：任一步非零/超时 → `verdict=FAIL`、exit 1；修复后**新提交 = 新构建 SHA**，重跑 S1。
  源脏/HEAD 不匹配 → exit 1；参数/环境错误 → exit 2。默认清理临时克隆；`--keep` 保留用于排查（帮助中注明）。
- **本轮真实自测（2026-11-07，Node v22.19.0/pnpm 11.7.0）**：
  - `--dry-run --ref HEAD` 在干净临时克隆上 exit 0，打印 clone/install/check/套件计划，**未 clone、未运行 check**；
  - `--skip-check` 在干净临时克隆（HEAD `73d2862`）上 exit 0：clone/checkout/克隆树干净 PASS，
    `fake-host-deploy-suite` PASS（`PASS: 141 assertions`，约 198s）、`fake-host-effects-db-suite` PASS
    （`PASS: 41 passed, 0 failed`）；install/check 按 `--skip-check` 标 SKIP；
  - 共享工作树（=宿主实载插件目录）当时有他人未提交改动，默认 source 的 dry-run 会因 `treeClean=false` exit 1，
    这是**预期的前置拦截**，不是脚本缺陷；干净候选上 dry-run 为 exit 0。
- **限制**：脚本无法通用识别 source 是否为“宿主实载目录”，运行前人工确认；
  S1 通过不代表真实宿主可用，也不替代 S2/S3/S4；本轮未跑完整 `pnpm install/check`（`--skip-check` 快速冒烟）。

## 3. S2：独立复核（外部）

- 复核者必须使用**独立克隆/工作树**，自行复跑，不得引用实现方结论替代自己的实测；
  送审材料见 `hephi/docs/validation/2026-11-07-s2-review-bundle.md`。
- 产物：复核报告（复跑命令与退出码、失败原文、代码审查发现按严重级、是否可合并、是否可进入 S3）。
- 失败处理：Request changes → 回 S1（新提交=新构建 SHA）；**S2 未通过不得进入 S3**。
- 关联：Z1（R3.8 二次独立复核）属于同一类独立复核门禁；Z1 未关闭前 R3.8/相关证据不得标“真实验证”。

## 4. S3：真实部署（停机式排空）— bc21caca 已部署，S4 待验

```sh
# 形态示例（真实执行前必须满足下方依赖；先 --dry-run 验证参数/门禁）
scripts/host/deploy-hephi.sh \
  --instance <instance-dir> --host http://127.0.0.1:3083 \
  --host-version <正式语义值> --target <40hex-candidate-sha> \
  --drain effects --effects-db <instance>/state/orchestrator.sqlite \
  --stop-command "python3 <instance>/superagent/scripts/dsh-superagent stop --profile experiment --url http://127.0.0.1:3083 --stop-timeout 30" \
  --dry-run
```

**依赖（缺一不可，见计划审查 P0-5/P0-4）**：

| 依赖 | 要求 | 当前状态 |
| --- | --- | --- |
| Z1 | R3.8 二次独立复核通过 | 按候选核对已有独立复核，不以部署成功替代复核 |
| D1 | 排空证据方案（`--drain effects` + H0/H7 探针） | H0/H7 已做，真实有 effect 的等待行为未验证 |
| D2 | 正式 hostVersion 来源 | 正式 D2 已记录；每次核对实际来源 |
| D3 | open Ticket 已处置 | 原 2 个已关闭；再次部署重新检查当时 open Ticket |
| D4 | 实载 SHA 回读方式 | 正式 D4 已确定双入口激活及新任务 `pluginCommit`；当前激活 verified，任务交叉回读待做 |
| D5 | 维护窗口（暂停/停机/恢复派发的人工窗口） | 正式 D5 已归档历史授权/窗口；后续按当前授权执行 |
| S2 | deploy 脚本改动先过独立复核（P1-2/P0-5） | 每次候选核对对应独立复核，历史结果不自动覆盖新增代码 |
| 探针 | H0 停机、H7 SQLite copy 模式通过并记录 | H0/H7 及无待处理 effect 的真实部署已记录；非零等待不外推 |

**执行顺序（P0-4）**：暂停 → 排空/effects 查询 → 记录进程与（可选）Job 标识 → 停止宿主 →
最终查询（`check-effects-db --mode copy`）→ 切换不可变 release → 启动 → 10 项健康 →
**smoke 一次真实工具调用读取 `pluginCommit`（标 SMOKE_ONLY）** → 关闭 smoke Ticket → 再暂停 →
操作者核对后恢复派发。

**产物**：`logs/deploy-*.json`、releases、host.pid/健康回读、实载 SHA 回读记录、smoke Ticket 关闭记录。
**失败处理**：脚本 fail-closed；恢复 previous 并复检；双失败保持 paused、保留两段证据、人工接管；
**不得**默认 0drain 字段、编造 hostVersion 或绕过 open Ticket。真实部署失败/中断后不得“继续切换”。

**历史失败**：早期 dry-run 曾被 2 个 open Ticket 拒绝（exit 1，未停机/未切换），见 `validation/2026-11-07-maintenance-drain-probe.md`。原两项后来关闭并完成 e490fe34 部署，见正式决策记录。
**最新部署**：bc21caca 的部署记录 result=ok、activation=verified、keptPaused=yes；不能由此推导 A2/A5 通过。再次部署仍需重新检查 Ticket/effects。

## 5. S4：真实验收

- **前置**：S3 成功且实载 SHA 已核验；A2 的 H1–H6 已有真实宿主结论（未完成时只能 blocked/unverified）。
- **入口**：`hephi/docs/validation/e2e/README.md` 的 A5 场景矩阵（E1-off/E1-on/E8/E2/E3/E4/E5/E6/E7/E9/E10/E-PR1）；
  每个场景按“检查→创建/更新 PR→ready→交付”执行并写 `e2e/<date>-<scenario>.md`。
- **产物**：每个场景的真实 E2E 记录（Issue/Ticket/Session、contractHash、run.json/output.log、
  decisions.jsonl、PR 状态、候选/实载 SHA、结论）；E9/E5 前置未满足时记 blocked。
- **失败处理**：blocked/fail 如实记录；不得用假宿主/单测/fixture 作为 E2E 通过证据；
  回滚/恢复按 S3 的 fail-closed 流程。
- **当前状态**：历史场景见 `validation/2026-11-07-s4-acceptance.md`，E5/E9 blocked、E1-off partial；当前 bc21caca 的完整 S4 未验证通过。

## 6. S5：默认值变更

- **目的**：在 S4 证据充分后调整默认值（如 `evidence.requireSessionBinding` 默认、executionMode 默认、
  检查/工具默认行为）。默认值变化属于**行为变化**，必须按版本化规则登记。
- **前置**：S4 通过；变更影响面/回退方案明确；负责人批准。
- **命令/产物**：代码/合同版本变更（如合同版本 +1）、版本登记、影响分析；**新提交 = 新构建 SHA**，
  必须重跑 S1–S4。
- **失败处理**：回退默认值/版本；不得在未验证时改默认；不得用未验证默认值做 S3。
- **当前状态**：未做（绑定默认仍关闭；S5 未实施）。

## 7. S6：合并到 main

- **优先 fast-forward**：main HEAD 直接等于已验收 SHA，合并不产生新构建，可直接复用 S3/S4 证据。
- **仓库实际使用 merge commit（P2-7）**：若合并产生 merge commit，**冒烟/验收对象必须是 merge commit 的构建**，
  不是 PR head 构建；至少重跑 S1 + S3 smoke（或按计划“对合并提交再冒烟”并记录）。
- **只含文档/证据的合并**：不改变运行代码，不需重新部署（前提：代码树与已验收 SHA 相同；merge 未引入代码冲突解决）。
- **产物**：main SHA、merge commit 构建的预检/冒烟记录、合并说明。
- **失败处理**：合并引入新代码/冲突解决导致构建变化 → 当作新候选重走 S1/S2/S3/S4；无法则不合入 main。
- **当前状态**：PR37/38/40/41 已合并，main 为 bc21caca；合并不等于完整 S4 通过。

## 8. S7：投入使用

- **前置**：S6 完成；监控/回滚预案/值班人确认；P8 实载回读边界仍为 unverified 时不得声称“实载版本已验证”。
- **步骤**：在维护窗口启用/切换生产标签与派发；观察错误率/健康/load；保留 previous release 与回滚命令；
  恢复派发由操作者手动执行。
- **产物**：投入记录（时间、release SHA、操作者、监控窗口、回滚点）。
- **失败处理**：回滚到 previous release（`deploy-hephi.sh --rollback` 或恢复 previous）；保持 paused/人工接管；
  记录事故与恢复证据。
- **当前状态**：历史 e490fe34 基础交付已有记录；bc21caca 部署结束保持暂停，后续投入及验收另记。

## 9. 版本与证据规则（P2-7 / P0-4）

1. **构建 SHA**：运行中的插件构建 commit；构建/部署/运行若不是同一提交必须分别记录。
2. **文档/证据-only 提交**：不改变运行代码 → 不重新部署，不产生新构建 SHA；不能把文档改动当作新验收。
3. **新代码提交**：即使很小也生成新构建 SHA；已验收 SHA 结论不自动延续。
4. **merge commit**：以合并提交构建为准；PR head 构建通过不能替代 main 构建验收。
5. **实载回读**：只认 `pluginCommit`/启动日志；读不到 → `unverified`，不得用磁盘哈希/重启时间替代。
6. **不可绕过**：不得默认 0 排空字段、编造 hostVersion、绕过 open Ticket 或跳过独立复核。

## 10. 当前状态与未验证项（不得写成通过）

| 项 | 状态 |
| --- | --- |
| S1 预检脚本 | 已实现；历史 skip-check 141/41 保留；PR40 记录完整开发检查通过，仍须按候选核对 S1 报告 |
| S2 独立复核 | 按对应提交核对复核报告；部署成功不替代独立复核 |
| S3 真实部署 | bc21caca 已部署，activation=verified；原两 Ticket 与 D1/D2/D4/D5 已有关闭记录 |
| S4 真实验收 | 当前 bc21caca 完整真实端到端未验证通过 |
| S5 默认值变更 | 未做，强绑定保持关闭 |
| S6 合并 | main=bc21caca，PR37/38/40/41 已合并 |
| S7 投入使用 | bc21caca 部署结束 keptPaused=yes；后续运行另记 |
| 实载 commit 回读 | 当前部署双入口激活 verified；新任务 pluginCommit 交叉回读待核对 |
| A5 E2E / A2 H1–H6 | 历史场景已有记录，H2/H6 fail、E5/E9 blocked；当前候选待复验 |

## 11. 关联

- `ROADMAP-95.md` §3.2（本流水线）与 §4.10（C 线增强）。
- 计划审查 `/Users/…/external-review/ROADMAP95-plan-review.md` P0-4（实载回读）、P2-7（merge commit）、P0-5（S3 依赖）。
- `hephi/docs/validation/2026-11-07-s2-review-bundle.md`（S2 材料与复跑命令）。
- `hephi/docs/validation/2026-11-07-maintenance-drain-probe.md`（H0/H7/drain 真实状态）。
- `hephi/docs/validation/e2e/README.md`（S4 场景矩阵）。
- `scripts/host/deploy-hephi.sh`（S3 部署脚本）、`scripts/release/preflight.mjs`（S1 预检）。
