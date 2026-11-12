# SA Eval Timeout Bug（3085 新进程无法创建 ticket）

日期：2026-11-12 · 发现者：Lead · 实例：g1-exp (3085)

## 症状

3085 重启后（pid 76945/88527/52999），新 GitHub Issue 能被 SA source 接收（trigger 表有记录），但 **eval 超时**，decision.kind=`unavailable`、reason.code=`timeout`，不创建 ticket。

旧进程（pid 33924）下创建的 Issue（#21/#23）正常处理。

## 证据链

| 步骤 | 结果 |
|---|---|
| trigger 存入 | ✅ `a3d30f5778c2f200cccd0c1cb712c6cc`，human=true，actor=paxxie2 |
| thread 创建 | ✅ `github:26`，pending=[]，subscriptions=[] |
| disposition | ✅ 有 evalId + decisionId（最终生成） |
| decision | ❌ kind=`unavailable`，reason=[{code:`timeout`}]，at=04:27:59Z（trigger at 04:20:18Z → **7min41s 超时**） |
| ticket 创建 | ❌ 未创建（tickets 数保持 24） |

## 根因分析

1. **不是 hephi 插件问题**：hepi-activation 正常（ab5f527），skipping 消息在重启后消失。
2. **不是网络/GitHub 问题**：trigger 已成功接收并存入。
3. **是 SA eval（LLM 调用）超时**：master session 活跃（12:40 更新），但 admission context 构建或 LLM 评估耗时超过内部阈值。
4. **可能原因**：
   - master session prompt 过长（历史 ticket 累积）
   - LLM API 响应慢或限流
   - admissionContextTimeoutMs 未配置（None），使用默认值可能过短
   - 重启后 master session 需要重新加载大量上下文

## 影响

- 新 Issue 无法自动接单 → T02 真实计量只能用已有交付数据
- T10 重跑需新 Issue → 被阻塞
- B3 探查任务投递 → 被阻塞

## 建议修复方向（DSH/SA 侧）

1. 增加 admissionContextTimeoutMs 配置（当前 None → 默认可能过短）
2. master session 上下文压缩或分页加载
3. eval 超时重试机制
4. 日志中记录 eval 超时的具体阶段（context build / LLM call / response parse）

## 临时绕过

- 用旧进程已有交付做 T02 计量（已完成，exp-083）
- 等待 SA/DSH 团队修复后重试

## 根因定位（2026-11-12 补充）

### 超时机制

SA `evals.ts` 的 eval 超时逻辑：
- `policy.evalTimeoutMs` = `settings.eval.timeoutSeconds × 1000` = **120,000ms**（2 分钟）
- 超时后重试最多 `REQUEUES=2` 次（共 3 次尝试）
- 3 次均超时 → `decision.kind='unavailable', reason=[{code:'timeout'}]`
- 理论最大耗时：120s × 3 = 360s（6 分钟）；实测 7min41s，差值 ~100s 为 LLM 调用本身的排队/响应延迟

### 耗时阶段定位

eval 流程：`queueForEval` → `thread.pending` → `assessor.evaluate` → master session `orchestrator_eval` + `orchestrator_eval_decide` LLM 调用 → decision

**超时发生在 master session 的 LLM 调用阶段**：
- trigger 存入和 thread 创建在毫秒级完成（source 层正常）
- disposition 在 7min41s 后才写入（eval 完成后）
- master session 文件在 eval 期间持续更新（12:26 mtime），说明 LLM 调用在进行但未返回
- evalId `2e658f62` 不出现在 master session 事件中（eval 是 SA 内部流程，不在 session 事件流中）

### 可能原因（按可能性排序）

1. **master session prompt 过长**：24 个历史 ticket + 大量工具定义（request/header 中 tools 数组 >100KB），LLM 处理时间超过 120s
2. **deepseek-flash API 响应延迟**：该时段 API 可能限流或排队
3. **重启后首次 eval 冷启动**：新进程需要重新加载所有上下文，首次 LLM 调用比稳态慢

### 建议修复方向

1. **增加 eval timeout**：`settings.eval.timeoutSeconds` 从 120 改为 300 或更高（可通过 `orchestrator_settings_save` API 修改）
2. **master session 上下文压缩**：减少历史 ticket 数量或启用 compact
3. **eval 并行化**：当前 eval 串行执行，多个 trigger 排队等待
4. **日志增强**：在 eval 开始/结束时记录时间戳，便于定位具体耗时阶段

### 验证方法

修复后从**新 Issue** 验证：
1. 创建 Issue → 检查 trigger 存入时间
2. 等待 disposition 生成 → 检查 decision.kind 是否为 accept
3. 检查 ticket 是否创建 → assignment 是否 running
4. 全程耗时应在 timeout 内
