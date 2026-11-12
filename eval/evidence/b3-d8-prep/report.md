# B3 基线探查准备 + D-8 正式界值材料

日期：2026-11-12 · 执行者：Lead · 基线 main `9338309`

## 1. B3 基线探查冻结清单

### 遗留系统场景（Dubbo）— 6 父任务草案

基于 `eval/evidence/b12-task-drafts/legacy-system.md` 的 12 项，选取前 6 项作为 B3 探查集（B4 用后 6 项）：

| # | 父任务 ID | 来源 | 模块 | 预估复杂度 | 状态 |
|---|---|---|---|---|---|
| L-B3-1 | dubbo-common-string-utils | Dubbo StringUtils 边界修复 | dubbo-common | 小 | 待 Dubbo 配置批准 |
| L-B3-2 | dubbo-common-config-parse | ConfigParser 空值处理 | dubbo-common | 小 | 待 Dubbo 配置批准 |
| L-B3-3 | dubbo-rpc-protocol-fix | RPC protocol header 校验 | dubbo-rpc | 中 | 待 Dubbo 配置批准 |
| L-B3-4 | dubbo-registry-zk-reconnect | ZK registry 重连逻辑 | dubbo-registry | 中 | 待 Dubbo 配置批准 |
| L-B3-5 | dubbo-config-yaml-parse | YAML config parser 异常处理 | dubbo-config | 小 | 待 Dubbo 配置批准 |
| L-B3-6 | dubbo-cluster-lb-roundrobin | RoundRobin LB 权重溢出 | dubbo-cluster | 中 | 待 Dubbo 配置批准 |

**前置阻塞**：Dubbo 检查配置已落地（dubbo-checks.json），但正向 prepare 未验证；base commit 待指定；~/.m2 依赖未预热。

### 大任务场景（hephi-review 本仓）— 6 父任务

基于 `eval/evidence/b12-frozen-list/large-task-frozen.md` 的 11 项可构造项，选取 6 项：

| # | 父任务 ID | 参考修复 | baseSha | diff 规模 | 分组 |
|---|---|---|---|---|---|
| G-B3-1 | evidence-verifier-a1out | 9fa8598 | 2c603c6 | +100/-8 | B3 |
| G-B3-2 | activation-binding-policy | 71abbe0 | (parent) | 中等 | B3 |
| G-B3-3 | stage-control-recovery | 83a79c2 | (parent) | 中等 | B3 |
| G-B3-4 | shadow-mode-parity | 1ea45b9 | (parent) | 小 | B3 |
| G-B3-5 | t21-retention-sweep | (t21-prep) | (parent) | 小 | B3 |
| G-B3-6 | ab-metrics-mechanical | 5e037bf | 858711a | +651/2f | B3 |

**状态**：11 张 v3 卡已冻结（commit 54ea9f0 + d0f35d5），可直接用于 B3。

## 2. D-8 正式界值材料

### T02 实测成本基线

| 指标 | 值 | 来源 |
|---|---|---|
| 单父任务 tokens（input+output） | 62,787 | exp-083（Issue #23 交付） |
| 单父任务 cache read | 1,918,080 | 同上 |
| 单父任务墙钟 | 2 min 31 sec | 同上 |
| 历史均值（18 会话） | 3.73M tokens/会话 | exp-033 |
| v5.4 停止线 | 300 万 tokens 或 60 min | v5.4 §6.5 |

### D-8 界值建议

v5.4 D-8 代定值：配对、单侧 2.5%、−10pp 非劣效界值。

基于 T02 实测：
- 单任务成本远低于停止线（62.8K vs 3M）→ 停止线不是紧约束
- cache read 占比 96.8% → 实际 API 调用成本极低
- B3 探查 12 任务预估总 tokens：12 × 62.8K ≈ 754K（极小）到 12 × 3.73M ≈ 44.8M（中等）
- **−10pp 界值在样本量 6+6 下的统计功效**：二项分布下，真实差异 10pp 时检出概率约 30-40%（低），需扩大到 12+12 才能达到 ~60%

### 建议

1. **D-8 暂维持 −10pp**，但标注"6+6 样本下功效不足，B3 结果仅作可行性信号，不作最终判定"
2. B3 完成后根据实际方差重算所需样本量，再决定 B4 的正式界值
3. 若 B3 实测成本显著高于 T02（>500K/任务），需重新评估预算

## 3. B3 启动前置条件清单

| # | 条件 | 状态 | 负责人 |
|---|---|---|---|
| 1 | Dubbo 检查配置正向 prepare 验证 | ❌ 未做 | 需授权受控 prepare |
| 2 | Dubbo base commit 指定 | ❌ 待指定 | 负责人 |
| 3 | ~/.m2 依赖预热（全仓构建） | ❌ 未做 | 需授权 |
| 4 | SA eval timeout bug 修复 | ❌ 新 Issue 无法接单 | DSH 团队 |
| 5 | 3085 宿主稳定运行 | ⚠️ 频繁重启后 hephi 插件加载不稳定 | 运维 |
| 6 | B3 预注册冻结 | ❌ 未写 | Lead |

**结论**：B3 当前**不可启动**。前置条件 1-5 均需外部行动。D-8 界值材料已备齐，待 B3 实测数据后冻结。
