# T21 准备阶段偏差登记与成本台账（外部审查整改）

依据：外部模型对 PR #90 的审查意见（2026-11-09 01:48），逐项整改并如实登记。

## 1. D-9 对照对象偏差（正式登记）

**事实**：D-9 一致性校验中，native 侧对照读取的是**既有** B5 试跑投递
（`paxxie2/b5-native-site-pnl#2`，只读），不是与 off 侧同批次的新投递。原因：新建 native
Issue 会触发宿主 B（3083，paused）产生真实 ticket/Worker 运行，超出校验窗口的授权范围。

**影响**：taskCard.sha256 一致性判定仍然成立（两侧卡部分逐字节相等）；但"两组同批投递
机制一致性"未验证，正式实验首轮执行时须做一次同批投递并复验哈希（已写入运行前检查项）。

**处置**：不重做校验（避免触发宿主）；作为已知限制随 PR #90 供审查。

## 2. 成本漏记（台账补登）

**事实**：D-9 校验窗口（2026-11-08T16:05–16:11Z）内，off 组 Worker 真实完成了
`previous-window-order` 任务并创建 PR `paxxie2/b5-off-site-pnl#16`（open，未合并）。
该运行的模型费用（deepseek-flash）**未计入** PREREG §5 的 100 元总预算账。

**补登**：token/费用数值未采集 → 记 `unverified`；按单次运行保守上界（PREREG 单次停止线
3,000,000 token）预留。正式实验开账时首笔登记此项，防止预算口径漂移。PR #16 保持 open
不合并，不作为任何实验数据点。

## 3. 任务清单冻结

`taskset-manifest-v1.0.json`：40 任务（site-pnl 28 + hephi 12），逐任务
taskJsonSha256/issueSha256/validationOk，绑定 PREREG preregSha256
`267d4069…`；变更须按 PREREG §9 升版本。

## 4. 语料结构覆盖（测试覆盖补强）

全量 dry-run sweep：**40 PASS / 0 FAIL**（2026-11-09 01:50，命令见交接包 §4 口径）。
变体卡的 agent 辅助评审局限仍如实保留（各卡 review.md），不在本轮整改范围内冒充双人评审。

## 5. 统计参数同步

`eval/stats/report.py` 默认值对齐 PREREG v1.0：`DEFAULT_SEED 20261107→20261108`、
`DEFAULT_MIN_PAIRS 5→67`；`--self-test` exit 0（Python 3.14.2 实测）。
`b6_known_answers.py` 的 SEED 为该工具自身已知答案的固定种子，不属于预注册默认值，未改动。

## 6. PR 标题范围更正

PR #90 标题由 "T01–T23" 更正为 "T01–T20 + T21 prep"（T22/T23 未开始，交接包 §5 已列）。
