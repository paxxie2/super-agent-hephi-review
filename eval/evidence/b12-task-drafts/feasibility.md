# B1.2 可行性核对记录（两场景前置事实实测）

- 任务：task-23。执行者：hephi-rca。日期：2026-11-12。
- 基线：`agent/task-contract-standard-20261111` @ `93fee341bcfb0c9bab98013efc176150ec0f3949`（回滚点；恢复 = `git checkout 93fee341` 或删除本目录三个新增文件）。
- 性质：只读核对 + 证据落盘。**等待人工/主持决策；未执行任何付费运行。**

## 1. Dubbo 仓可 clone 核对（实测）

命令与结果（2026-11-12，本机）：

```bash
$ git ls-remote --heads https://github.com/apache/dubbo.git | head -3
c80b94bdd9e859030859f02e5cfc4b108b18f459	refs/heads/2.5.x
58d1259cb9d89528594e43db5d8667179005dcfc	refs/heads/2.6.x
36cef60672fb7cf99b11d3d5fb584d89d5317643	refs/heads/2.7.x
# exit=0
```

结论：远端可达、引用可读。**完整 clone 未执行**（大仓体量/磁盘/时长未估，属后续构造任务，非本卡范围）；建议后续用 `--filter=blob:none` 浅化 clone 并实测 `mvn -o -q -DskipTests compile` 的离线可行性（P10 前置）。

## 2. Dubbo 项目检查配置核对（实测：缺失）

```bash
$ grep -in dubbo hephi/docs/project-config.md
# 0 命中（exit 1）
```

结论：与 D-5 一致（`eval/approvals/2026-11-11-unrelated-refactor-track-decisions.md:43`）——**目前没有项目检查配置**。补齐须作为明确任务报负责人批准；legacy-system.md 12 个父任务全部标**待批**。本卡未编造任何 `HEPHI_VERIFICATION_FILE` 内容（该字段语义见 `hephi/scripts/prepare-dubbo.sh:33-36`：配置缺失/不可读时 prepare 直接失败——fail-closed，故配置是硬前置）。

## 3. 训练截止后可用修复数清点（未执行，待批）

- 未执行原因：①所用模型训练截止日期未在任务卡/计划中给出明确日期值；②清点需对 apache/dubbo issue/PR 按「修复 commit 在截止后 + 有可回放回归测试」过滤，属一次性调查任务。
- 影响：v5.4 §7 B1 出口条件「清点 Dubbo 训练截止后的可用修复数」未满足；遗留系统场景可构造数量无法估算（§6.8 可行性门第 386 行）。
- 建议（供决策，不实施）：先定截止日期 → gh api 列近邻修复 PR → 按 `fix` label + 关联测试文件过滤 → 输出候选池与去重计数。

## 4. 大任务种子核对（实测：与计划口径不一致）

```bash
$ for d in eval/tasks/hephi/*/ eval/tasks/site-pnl-diagnosis/*/; do p="$d/reference.patch"; \
    [ -f "$p" ] && echo "$(wc -l < "$p") $p"; done | sort -rn | head -8
1342 .../frontend-form-feedback/reference.patch
1121 .../hephi/record-run/reference.patch
919  .../hephi/daily-export-rework/reference.patch
828  .../restore-health-service-id/reference.patch
679  .../restore-data-package/reference.patch
663  .../hephi/b7-matrix/reference.patch
640  .../hephi/ab-metrics-mechanical/reference.patch
584  .../hephi/repro-manifest/reference.patch
```

- 实测 reference.patch ≥500 行的有 **8 张**；v5.4 §6.5 记「4 张」。差异可能来自统计口径（父任务去重/文件数 vs 行数），**未裁决，登记待负责人确认**。
- 结论：大任务种子充足（≥4 张共识下限），大任务场景**无 Dubbo 式硬阻塞**，12 个父任务草案中 11 个标「可构造」、1 个（G-B2-1）因 v5.4 §3.4 产物未提交钉 SHA 标「待批」。

## 5. 环境与构建核对

- 大任务场景（本仓）：`cd hephi && pnpm check`（tsc + vitest + tsdown）在既有记录中 exit 0（`docs/remediation-r3-validation.md:169`，20 文件/202 tests，Node v22.19.0、pnpm 11.7.0）。本次**未复跑**（本卡红线：只新增 b12-task-drafts，不跑测试套件；标注为历史证据）。
- 遗留系统场景（Dubbo）：Java/Maven 离线构建环境未核对（P10 前置，待批任务）。

## 6. B0 经验复用声明

- 父任务构造/映射口径复用 `eval/evidence/b0-offline/ledger.md` §3（18 合同→10 父任务的分组依据与重投规则）；两组等价卡差异项复用 v5.4 §6.6 表（第 299–327 行）。

## 7. 汇总：待人工/主持决策清单

| # | 决策项 | 影响 |
| --- | --- | --- |
| 1 | Dubbo 项目检查配置补齐方案（D-5 报批） | 遗留系统场景 12 任务能否开构造 |
| 2 | 训练截止日期 + 修复清点任务授权 | 遗留系统场景可构造数量估算 |
| 3 | 「4 张 vs 8 张」>500 行种子口径裁决 | 大任务场景种子统计口径 |
| 4 | v5.4 §3.4 未提交产物（4 文件）先提交钉 SHA | G-B2-1 能否进入构造 |
| 5 | 本清单 12+12 草案冻结与否及 B4 入选规则 | B2/B3 开跑前置（v5.4 §7 B1 出口） |

## 8. 明确未做

- 未 clone Dubbo、未清点 issue、未构造 task.json/issue.md、未跑测试/付费任务、未改任何源码。
- 本目录三个文件为唯一新增（git 精确路径 add，见 commit）。
