# 威胁模型（A4，2026-11-07，草稿）

> 状态：**草案 / 部分未验证**。本文按 ROADMAP-95 §A4 编写，用于固定信任边界与已知防线；
> 2026-11-08 同步：已有 [A2 历史核实记录](validation/2026-11-07-a2-final.md)，但 H2/H6 为 fail，
> H3/H5 仅有一次性 profile 的有限证据；强绑定保持关闭。本文不能证明“宿主已隔离”或“证据不可伪造”。
> 代码对象为 `bc21caca`；该构建已部署并完成双入口激活回读（见 §4），当前版本完整真实验收仍未通过。

## 1. 资产与攻击者

| 项 | 说明 |
| --- | --- |
| 资产 | 检查记录（`run.json` + `output.log`）、决策日志、激活合同、ready 判定结果、真实宿主执行结果 |
| 攻击者 A：Worker（模型/被劫持的工具调用） | 能在工作区读写、能执行 bash、能请求 `hephi_check` 与 `orchestrator_report`；**一次性 profile 已观察到可写 Session 快照和检查状态（H6 fail）；生产 B 未执行写入尝试** |
| 攻击者 B：同机非特权用户 | 若与插件同 UID，可读写宿主状态目录（G1 第 7、8 项未验证） |
| 攻击者 C：恶意/被篡改的插件构建 | 本模型不覆盖：构建来源由 P2/部署控制；磁盘哈希 ≠ 实载 commit（L5） |

## 2. 信任边界（当前事实）

| 边界 | 状态 | 证据/限制 |
| --- | --- | --- |
| 状态目录 `<stateDir>/hephi/` | **可被 Worker 所在进程写入**（同一宿主进程/同一 UID） | 无 OS 隔离证据；A2 的一次性同 UID profile 已观察到状态写入，不能外推为生产伪造交付成功 |
| Session 快照（`sessionQuery.readSession`） | 只读 API 不等于磁盘不可写；**H6 在一次性 profile 为 fail** | 快照追加/状态写入成功；未证明伪造事件能被采信；生产未写测，A1-BIND 保持关闭 |
| Job 接口（`jobs.get/readAt`） | 一次性 profile 中 own Job 终态可读，foreign Session 的 get/readAt 被拒绝 | H3 的生产探针仍为 manual；该证据不证明生产 ready 实际调用了接口 |
| 操作者解除入口（A3 `resolutions.jsonl`） | 默认关闭；`HEPHI_ALLOW_OPERATOR_RESOLUTIONS` 只是策略开关，**不是安全边界**（Worker 的 shell 会继承宿主 env） | 可信边界待 G1 第 9 项 + 宿主配置字段；关闭时 runner/verifier 均不采信 |
| 输出绑定（A1-OUT） | 绑定生效时从 Session 结果/Job 输出重算哈希；不可得即拒绝 | 历史 H2 的持久化 Session 缺结构化 value，不等于运行期检查全部失败；权威输出不可得时仍拒绝。H5 只覆盖无截断分支，截断/lossy 原生 E2E 未通过 |

## 3. 防线与对应攻击

| 攻击 | 当前防线 | 能声称的边界 |
| --- | --- | --- |
| 手写 `run.json` + `output.log`（无真实执行） | 绑定生效时要求 Session 中唯一 bash 调用/结果（或 job/registered+settled）与合同重算命令一致；K4 无条件要求 session 归属 | 绑定关闭时仍可能通过（K7 #3 已知限制）；绑定开时仅覆盖已列举伪造方式 |
| 只改 `output.log` | `outputHash` 与日志哈希比对 | 能发现未同步修改 |
| 同时改日志和哈希 | A1-OUT 从权威来源重算 | 仅对 A1-OUT 生效的分支；权威输出不可得时 ready 拒绝 |
| 后台换 Job/跨 Session Job/仍在运行 | jobId 严格相等 + `jobs.get` + completed + 退出码 | 依赖 H3 语义；Job 清除即拒绝 |
| 旧 HEAD/旧合同/旧构建证据 | git 指纹、contractHash、pluginCommit 校验 | 已实现并有测试 |
| shell 越界写入 / 符号链接逃逸 | 范围与工作区 containment 检查 | 机械检查；真实宿主路径未验证 |
| 已解除的 run 当证据 | 解除记录只跳过阻塞，不改变记录 status；verifier 仍要求 passed | 已实现 |
| 仍在运行时解除 | CLI `--status running` 拒绝；`--accept-risk` 不适用 | 依赖操作者如实提供 `--status` |

## 4. 已知缺口（未验证，不能写成已解决）

1. 宿主隔离（G1 第 7、8 项）：若 Worker 能写状态目录，伪造记录/日志仍可能，只有 A1-BIND/A1-OUT 能发现一部分。
2. H6：历史一次性 profile 的快照追加与状态写入成功，结论为 fail；生产 B 未执行写入尝试。按已批准回退保持强绑定关闭，不据此新增隔离架构，也不宣称已成功伪造 ready。
3. A3 的可信边界：操作者配置必须 Worker 不可读/不可继承；本轮只有默认关闭 + 文档告警。
4. 实载回读已具备：[正式 D4 记录](../../docs/deployment-prerequisite-decisions-2026-11-07.md) 归档了历史 `e490fe34` 的双入口激活与新任务 `pluginCommit`。2026-11-08 02:16:39（北京时间）部署记录 `/Users/zm/dsh-instances/experiment/logs/deploy-20261107T181639Z-43593.json` 为 `target=bc21caca316d6032ebcc3d2bc6387c38e0a3579c`、`result=ok`、`activation=verified`，新 PID `44914` 的 index/tools 各一条、同 SHA。该次部署完成时保持 paused；不等于当前版本 A2/S4 已通过，也不构成不可篡改证据。磁盘哈希和健康仍不能单独替代激活回读。
5. `hephi_check` 期间的文件改动又改回（K7 #1）：指纹只能证明前后一致。
6. H2/H3/H5 的历史结论不能充当当前构建验收：A2 的生产快照对应 `efdd406`，H3/H5 通过来自一次性 profile；H5 的 `lossy=true` 只有真实子进程 + Job 注册表组件集成证据，截断/超长 spill 的原生链路仍未验证。

## 5. 需要宿主/负责人决定的事项

- 是否采用 OS 级隔离（独立 UID、只读状态目录、操作者凭据）——属外部资源与安全审批。
- A3 操作者配置的存放位置与权限（仅操作者可写、Worker 不可读）。
- H6 已按现有方案回退为强绑定关闭；若要改变隔离方式或能力目标，须另行明确范围，不能以此次文档同步作授权。

> 本文只同步已有证据及限制，不改默认策略；部署与激活成功不等于完整 S4、A1-BIND 或安全隔离通过。当前版本真实端到端未验证通过。
