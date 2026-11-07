# G1 宿主能力探针：自动部分记录（2026-11-07）

本记录只覆盖可自动回读的部分，**不构成 G1 完成**；G1 要求 11 项原编号与 3 项新增能力逐项结论，其余项必须由宿主操作者在真实 Worker / 牺牲性 Session 上人工探测并记录原始输出。

> A2 证据链宿主探针的 path A/path B 识别、`--job-evidence` 运行时证据与限制见 [a2-host-evidence-probe.md](./a2-host-evidence-probe.md)。

## 1. 已自动执行

- 命令：`node hephi/scripts/host-capabilities.mjs --host http://127.0.0.1:3083 --out <evidence>/host-state.json`
- 结果（EXIT=0）：`stateReadable=true`、`paused=false`、`running=0`、`queued=0`；10 项 health 全部 `ready`（runtime/relay/notice/launch/delivery/assessment/reply/evals/models/github）
- 证据文件（本机，不入库）：`/Users/zm/dsh-instances/experiment/evidence/g1-host-probe-20261107/host-state.json`
- SHA256：`d0d99d9ba363e6e6855b0ddc0c478dae2ad1173c79aa92e9f2a1353f101643ea`

## 2. 能力结论（仅限自动可判定项）

| 能力 | 结论 | 依据 |
| --- | --- | --- |
| 宿主状态读取（`/orchestrator/api/state` + `x-orchestrator-request: 1`） | 具备 | 实测 HTTP 200 并解析成功 |
| paused 标记 | 具备 | 字段存在且可读 |
| load 计数（running/queued/maxWorkers） | 具备 | 字段存在且可读 |
| 实载插件版本回读（`describePlugin` 或等价） | **不具备** | 仓库内 `describePlugin` 无调用入口，CLI 仅 `prepare`；宿主无版本查询 API |
| G1 原编号 1、2、3a、3–10 | 未验证 | 需真实 Worker 内部 bash 快照、前台/后台终态、子 Agent 事件、token 用量、相对路径、无标签对照、状态目录写权限、UID/沙箱、操作者独立通道、伪造快照等人工探针 |
| 新增 3 项（工具结果告警通道、实载版本回读、维护排空） | 未验证（第 2 项已按上表判“不具备”） | 需宿主操作者确认；排空能力仅能从 `paused`/`load` 间接观察，未实测 |

## 3. 对照环境现状

- A 实例（`http://127.0.0.1:3082`，无赫菲）：已按用户授权启动并核查（2026-11-07）：host.pid `96013`，状态可读 `paused=false`、`running=0`、`queued=0`；health 中 `runtime/relay/notice/launch/delivery/assessment/evals/models/gitlab` 为 `ready`，`reply=error`；登录 URL 见 `daily/logs/host.log`（含本地 token，不记录）。A 可作为“无插件”对照宿主，但 G1 第 6 项仍需受控 Issue 运行。
- B 实例（`http://127.0.0.1:3083`，加载赫菲）：运行中，状态可读；2026-11-07 完成一次真实部署（`docs/p8-deploy-record.md`）。
- 模型账号：A/B 日志均出现 `deepseek-account /auth-api/v0/users/current 403 network`，但 `/orchestrator/api/models` 仍将 `deepseek-account` 标为 routable、health `models=ready`；真实 Worker 运行（P11 smoke）成功，说明该 403 未阻断模型调用，但属环境风险。

## 4. 未做的事（不得冒充通过）

- 没有伪造 Session 快照、没有执行高风险权限探针、没有创建真实 Issue/Worker 运行。
- 未把状态可读当成“工具结果告警通道具备”；该项必须由真实工具执行后观察。
