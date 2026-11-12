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
