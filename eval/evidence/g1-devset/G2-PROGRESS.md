# G2 开发集（T19 门槛）——完成

4 任务（v3 卡 kind:code，修正卡 paths 含测试文件）全部走通 红态(phase=red, exit 1) → 实现 → 双检查绿 → ready.pass → PR 合入：
| ticket | 仓库 | PR | ready |
|---|---|---|---|
| 0a8f4cda | b5-off-health-service-field | #15 | ✅ |
| 24e98812 | b5-off-history-page-size | #20 | ✅ |
| 6a8b6545 | b5-off-backend-input-validation | #14 | ✅ |
| f7bd5da4 | b5-off-money-window-helpers-r2 | #7 | ✅ |

## 门槛结果
- AT-82（有效红态覆盖率）：**4/4=100% ≥90% ✅**（eval/offline-red-check.mjs 逐单对其仓库判定，全部 valid；两处 T18 对接修补见 commit 8620354：裸路径 tests 条目、pytest 无 type 断言）
- AT-83（宿主中断处置）✅：13:29:30Z kill -9 于 acceptance 检查运行中 → 记录停留 running/无退出码（未变成功）→ hephi resolve（host-terminal/terminated，operator-config 0600 + profile 开关）→ Worker 重跑检查通过 → 该单随后以修正卡重投完成
- AT-71/72（先 commit 后检查、不重写历史）✅：决策日志时序与 PR 线性历史佐证
- AT-52b（红绿报告分存）✅：各 run 目录独立 junit.xml/output.log

## 暴露并修复的问题（开发集价值所在）
1. **T17 部署缺口**：SKILL.md 未教 phase=red，首轮 4 Worker 全跳红态（ready 全被 red-missing 正确拒绝）→ 补 5a 节（commit b6fed1c）
2. **卡设计缺陷（Lead）**：首轮卡 paths 未含测试文件 → Worker 写测试被 scope 正确拒绝（"契约缺陷"误判由此而来）→ 修正卡重投
3. **T18↔T13 对接缺口**：tests 裸路径解析、pytest 无 type 断言 → 8620354 修补
4. **重投成本**：首轮 4 Worker 轮 + 重试轮为无效消耗（约 6-8 个 Worker 轮），已如实记录
