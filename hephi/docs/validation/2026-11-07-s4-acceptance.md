# S4 验收记录（A 线，2026-11-07）

> 状态：**partial（F1 由 PR38、F2–F5 由 PR40 修复并合并；E5/E9 blocked；E1-off partial；人类签收未做）**。E1-on 正式场景已于 2026-11-08 真实验收通过（等价清理，非缺陷修复）。本文件只记录已真实执行并有证据的事项；
> 未执行/未验证项显式列出。**不是最终验收通过证明；人类负责人签收前不得记 A5/D5 为通过。**
>
> 更新（2026-11-08）：当前 main 为 **`bc21caca`**（包含 PR40 F2–F5 和 PR41 记录更新）。部署记录证明该候选已于北京时间 02:16:39 完成 S3，双入口激活 verified；
> 本文件尚未收录当前候选完整 S1 报告及 A2/A5 复验，以下 E2E 成功仍属历史构建；**S4 仍为 partial**。

## 1. 对象

| 项 | 值 |
| --- | --- |
| main（代码） | **`bc21caca316d6032ebcc3d2bc6387c38e0a3579c`**（包含 PR37、PR38 F1、PR33、PR39、PR40 F2–F5、PR41 记录更新） |
| 历史验收时点 | 证据采集于旧 main `9fa8598f2beabe179b28733e484275c3775279d3`（PR30 merge `2c603c6` + PR31 docs）；当前候选的 A2/A5 复验另记 |
| 当前部署构建 | `bc21caca316d6032ebcc3d2bc6387c38e0a3579c`（部署记录的双入口 activation verified，PID 44914；新任务 `pluginCommit` 交叉核对及 A2/A5 仍待补验） |
| 历史 E2E 构建 | `e490fe34dfd13117db2516d9b9c7cb0459c1d219`（历史 activation markers PID 95240；以下已执行 E2E 不自动变为当前候选证据） |
| 当前部署记录 | `deploy-20261107T181639Z-43593.json`，sha256 `bb2dd8b6d6c9dd240d30df261afe06c5ef949c0d8488854b22d3ab0f45dc69b5`；`result=ok`、`activation=verified`、`keptPaused=yes` |
| 历史部署记录 | `deploy-20261107T141210Z-57984.json`，sha256 `804ba302d373da5b2613d3a6a986180149715b8c35d9d76844e4c3df060d7454` |
| 宿主 | B `http://127.0.0.1:3083`，DSH 0.2.1-rc.5，Node v26.1.0（宿主运行）/v22.19.0（本地验证工具） |

## 2. S1 预检（**旧 main@9fa8598**；当前候选报告待核对）

> ⚠️ 本节是**对 `9fa8598` 的 S1 预检**，不是对当前 `bc21caca` 的复跑。合并 PR37/PR38/PR40 后代码已变化
> （尤其 F1/F2–F5 与 host 脚本），**须核对当前候选的完整 S1 报告**；本节不能当作新 main 的预检结论，S3 成功也不能替代 S1 证据。

命令：`node scripts/release/preflight.mjs --source /tmp/main-s1-review --ref 9fa8598 --out /tmp/main-s1-report.json`
结果：**PASS（旧 main）**。`check` exit 0（**459 tests**，36+ 文件，Build 1649ms）；假宿主套件 **174 assertions**；effects-db **41**；克隆树干净。原始报告见 `external-review/evidence/roadmap95/`（本轮落档）。

## 3. 独立代码复核（PR30 合并后）

`external-review/PR30-post-merge-review.md`：verdict **request changes**——0 blocker / **1 major（F1：激活门禁可被 legacy 降级绕过）** / 5 minor / 6 nit。F1 未修复前，activation fail-closed 门禁不能作为 issue #26 关闭依据。本 S4/后续真实部署不得忽略该发现。

**F1 状态（2026-11-08，d9d70b1）**：PR38 已 fast-forward 合并修复——release-meta 使用 `formatVersion=2`；
legacy 元数据只在显式 `--allow-legacy-rollback` 的回滚/恢复目标上接受；默认激活门禁拒绝 legacy 降级
（`test-deploy-hephi.mjs` 覆盖 F1-A..G 负例，且 `d9d70b1` 把 F1 套件接入默认 full fake-host run）。
**F2–F5 已由 PR40 合并整改**：F2 依赖完整性、F4 双形状拒绝、F5 marker 回归已修复；F3 是 peer 绝对路径稳定性要求及告警，未消除迁移限制。F1/F2–F5 修复不等于 S4 通过。D1/D2/D4/D5 正式记录见 `docs/deployment-prerequisite-decisions-2026-11-07.md`；本次 S3 已有记录，当前 S1/A2/A5 证据仍须分别核对。

## 4. A2 证据链（定案）

见 `hephi/docs/validation/2026-11-07-a2-final.md`（含独立复核 F4 口径风险追加说明）：
H1 pass(path-B)、H2 fail、H3 pass（disposable profile）、H4 pass、H5 pass（无截断分支）、H6 fail。
结论：**A1-BIND 不启用（强绑定保持关闭）**，按“检测已列举伪造”交付；A1-OUT fail-closed。总体 incomplete。

## 5. A5 场景状态

以下状态对应各条历史记录的构建，不代表当前 `bc21caca` 已复验。E1-on 指启用插件，**不等于 `binding=true`**；E1-off 指无插件对照。

| 场景 | 状态 | 证据 |
| --- | --- | --- |
| E2/E3/E6/E7 | **pass**（外部模型执行；Lead 已核对 decisions） | `e2e/2026-11-07-E2/E3/E6/E7.md`：scope.outside-task deny、ready.other deny、ready.evidence-missing deny、ready.pr-mismatch deny；PR #53 |
| E8 | pass（预期准备拒绝） | Issue #52 / ticket `c9ea328e…` failed |
| E1-off | **PARTIAL（对照；前置/provenance 无法核验）** | `e2e/2026-11-07-E1-off.md`：Issue #54、PR #55、无 HEPHI state |
| E4 | **PASS（两阶段）** | `e2e/2026-11-07-E4.md`：Issue #56/57、ticket c231654e/13af322b、run.json blocked→passed、PR #58 |
| E10 | **pass** | `e2e/2026-11-07-E10.md`：Issue #60、ticket 1612ffac、run passed、PR #61（2 文件） |
| E1-on | **PASS（正式场景，流程级）** | `e2e/2026-11-08-E1-on.md`：Issue #62 / ticket `e2419b28…` / run `9ffe2a11…` passed/exit0 / ready.pass / PR #63；改动为等价清理（非缺陷修复） |
| E5/E9 | **blocked** | 前置未满足（H0 停机已做、H3 真实宿主探针 manual） |
| E-PR1 | **PASS（正式场景，来自 E1-on run）** | `e2e/2026-11-08-E-PR1.md`：PR #63 首次创建、ready.pass、HEAD=run before/after head |

## 6. P8 / D1 / D2 / P2 / P5 现状

- P8：部分（部署机制与实载回读已验证；真实 S3/S4 完整链路未完成；F1 已由 PR38、F2–F5 已由 PR40 合并整改；当前 S3 已有记录，S4 未完成）。
- D1：不通过（A1-BIND 未启用；H6 fail；绑定关闭）。
- D2：hostVersion 语义有正式记录（PR31），但“实载源码可证明”仍不成立。
- P2/P5：不变（本文件不重评；以原记录为准）。

## 7. 未验证 / blocked（不得计入通过）

- 真实 A2 H1–H6 未在生产实载构建上复跑（生产快照 check record pluginCommit=efdd406）。
- 真实 supervisor 自动重启行为、非零 effect 等待、运行期网络隔离。
- C3 review→Trigger、C4.2 真实工具可见性、C1 真实 E2E。
- E5/E9；E1-off 的干净 off 环境。E1-on 仅等价清理（未验证真实缺陷修复类型）；E-PR1 依赖同一 run，仅证明首次 PR 创建→ready 成功，未证明“无 PR 时先 ready 拒绝”的负向步骤。
- F1/F2–F5 已合并整改；当前 `bc21caca` 已部署，但本文件未收录其完整 S1 报告及 A2/A5 复验。F3 仍要求 peer 路径稳定。
- B 线实验（B5/B7/B8）未开始。

## 8. 结论

A 线本轮完成了：旧 main S1 PASS、PR30 独立复核（request changes）、A2 定案、E4/E10 真实验收、E1-on 正式场景验收、E1-off 对照（partial）。
**S4 仍为 partial**：F1/F2–F5 均已修复并合并（PR38/PR40），但 E1-off partial、E5/E9 blocked，
且当前候选完整 S1 报告与 A2/A5 复验尚未在本文件核验归档。当前 S3 成功不替代这些证据；不得将本记录当作 A5/D5 通过或 S4 验收通过。

## 9. 更新（E10 完成后）

- A5 非 blocked 场景均已有记录：E1-off / E1-on / E2 / E3 / E4 / E6 / E7 / E8 / E10 / E-PR1；其中 **E1-on/E-PR1/E4/E10/E2/E3/E6/E7/E8 为 pass**，**E1-off 为 partial**（前置限制）。
- E5/E9 保持 blocked；E1-off 前置/provenance 无法核验；E1-on/E-PR1 来自同一等价清理 run；E2/E3/E6/E7 为外部模型执行（决策日志已由 Lead 核对）——A5 仍缺 E1-off 干净环境与负责人签收，**不得记为通过**。
- PR30 复审 F1（activation legacy 降级绕过）**已由 PR38 修复**（`formatVersion=2` + legacy 仅 `--allow-legacy-rollback`，F1-A..G 负例）；
  F2–F5 **已由 PR40 合并整改**，F3 保留路径稳定性限制；当前 S3 已有成功记录，不能代替当前 S1/A2/A5 证据。

## 10. 证据索引

| 证据 | 位置 | 说明 |
| --- | --- | --- |
| S1 预检报告/日志 | `external-review/evidence/roadmap95/main-s1/main-s1-report.json`、`main-s1.log` | **旧 main@9fa8598**，verdict PASS（459 tests / 174 / 41）；**不能作为 bc21caca 的 S1 证据** |
| PR30 独立复核 | `external-review/PR30-post-merge-review.md`；`external-review/evidence/pr30-review/` | request changes（F1 major） |
| F1 修复 | PR #38（merge `d9d70b1`，`f078f72` + `d9d70b1`）；`test-deploy-hephi.mjs` F1-A..G | **已修复**；F2–F5 已由 PR40 合并整改，F3 保留路径稳定性限制 |
| A2 定案 | `hephi/docs/validation/2026-11-07-a2-final.md` | H1–H6 + 哈希核对 + F4 口径风险 |
| E4 记录 | `hephi/docs/validation/e2e/2026-11-07-E4.md`；stateDir `…/state/hephi/c231654e…`、`13af322b…`；PR #58 | blocked→passed 两阶段 |
| E10 记录 | `hephi/docs/validation/e2e/2026-11-07-E10.md`；stateDir `…/state/hephi/1612ffac…`；PR #61 | passed，2 文件 |
| E1-off 记录 | `hephi/docs/validation/e2e/2026-11-07-E1-off.md`；Issue #54 / PR #55 | partial（前置/provenance 无法核验） |
| E1-on 正式记录 | `hephi/docs/validation/e2e/2026-11-08-E1-on.md`；Issue #62 / ticket `e2419b28…` / run `9ffe2a11…` / PR #63 | PASS（等价清理，非缺陷修复） |
| E-PR1 正式记录 | `hephi/docs/validation/e2e/2026-11-08-E-PR1.md`；PR #63 / run `9ffe2a11…` | PASS（流程级，来自 E1-on run） |
| E1-on/E-PR1 历史记录 | `e2e/2026-11-07-E1-on.md`、`E-PR1.md`；Issue #49 / ticket ad3d5016 / PR #50 | partial（SMOKE_ONLY，已被正式记录取代） |
| E2/E3/E6/E7 记录 | `e2e/2026-11-07-E2.md`、`E3.md`、`E6.md`、`E7.md`；stateDir `…/state/hephi/90150d23…`；PR #53 | 外部执行，决策日志已核对 |
| 历史部署记录 | `<instance>/logs/deploy-20261107T141210Z-57984.json`（sha256 804ba302…） | e490fe34 的 D1/D2/D4/D5 证据 |
| 当前部署记录 | `<instance>/logs/deploy-20261107T181639Z-43593.json`（sha256 bb2dd8b6…） | bc21caca，result=ok、activation=verified；不是当前 A2/A5 通过证据 |
| 记录 PR | `paxxie2/super-agent-hephi-review` PR #34（docs-only） | 本文件与 e2e 记录所在分支 |
