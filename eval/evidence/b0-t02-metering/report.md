# B0/T02 单次真实计量报告

日期：2026-11-12 · 执行者：Lead（teammate subagent 模型路由失败，直接执行）
数据来源：Issue #23 / ticket b17434f7 / PR #24（T10 重跑交付，3085 ab5f527）

## 1. 计量结果

| 指标 | 值 |
|---|---|
| Session | worker-b17434f743a24cab31575b737ea482a0 |
| Usage 记录数 | 46 |
| Input tokens | 45,175 |
| Output tokens | 17,612 |
| Cache read tokens | 1,918,080 |
| Cache write tokens | 0 |
| **Total tokens (input+output)** | **62,787** |
| **Total tokens (含 cache read)** | **1,980,867** |
| 墙钟时间 | 2 分 31 秒（22:20:05Z → 22:22:36Z） |
| 终态 | ready.pass → PR #24 OPEN |
| Decisions 链 | plan.recorded → scope.allowed(write) → asset.unauthorized-modify(deny×2) → scope.allowed(write×2) → check.blocked(red) → scope.allowed(edit×2) → scope.outside-task(deny) → check.pass(×2) → ready.pass |
| 人工时间 | 0（全自动） |

## 2. 对账

本次为单 Session 直接提取，无采集器中间层。usage 记录从 session.v4.jsonl.zstd 解压后逐行解析 `usage` / `message.usage` / `data.usage` 字段。

与历史基线对比（exp-033：18 Worker 会话 989 条 / 67,178,636 tokens）：
- 本次单 Session 62,787 tokens（input+output），远低于历史均值 3.73M/会话
- 原因：本次任务极小（单文件 offset 校验），历史含多文件跨模块任务
- cache read 占比极高（1,918,080 / 1,980,867 = 96.8%），说明模型大量复用上下文

## 3. 宿主状态异常记录

重启 3085 后（pid 76945 → 88527），新 Issue（#25/#26/g1-at81#6）均无法被 SA 接单：
- trigger 表有记录，disposition 缺失或无 decisionId
- thread subscriptions=[]（未关联 ticket）
- 旧进程（pid 33924）下创建的 Issue #23 正常处理
- **结论**：新宿主进程的 SA eval/dispatch 逻辑存在缺陷，可能是 DSH 0.2.1-rc.5 的 bug

因此 T02 使用旧进程已有交付数据，未产生新的 Worker 运行支出。

## 4. B3 预算建议

基于本次实测：
- 单父任务（极小）：62,787 tokens / 2.5 min
- 历史均值（中等复杂度）：3.73M tokens / ~30 min
- v5.4 停止线：300 万 tokens 或 60 min

建议 B3 探查预算（6 父任务 × 2 场景 = 12 任务）：
- 下限：12 × 62,787 ≈ 753K tokens（全极小任务）
- 上限：12 × 3.73M ≈ 44.8M tokens（全中等任务）
- **建议暂定 50 元**（与 v5.4 D-6 一致），按实际消耗调整

## 5. 未覆盖

- 审查/人工时间：本次为 0，复杂任务需补采
- 实付金额：需 LLM provider 账单 API（未接入）
- 多轮重投成本：本次无重投
