# 宿主契约与兼容性回归（A7，2026-11-07，草稿）

> 状态：**草案**。本文只固定“赫菲依赖宿主哪些接口/字段、宿主升级前要复跑什么”。
> 历史 A2 结论见 `validation/2026-11-07-a2-final.md`：H2/H6 fail，强绑定保持关闭；H3/H5 的通过有一次性 profile、未覆盖截断的限制。
> `bc21caca` 已于 2026-11-07 18:16:39Z（北京时间 11-08 02:16:39）部署，双入口激活 verified；当前候选 H1–H6 与完整真实端到端仍待复验。

## 1. 依赖的宿主接口

| 接口 | 用途 | 当前证据 | 失败时行为 |
| --- | --- | --- | --- |
| `/orchestrator/api/state` | paused/load/health 回读 | G1 自动部分 + H0 实测 | 读不到 → 阻塞/拒绝 |
| `/orchestrator/api/executor/pause` | 维护暂停 | G1/H0 实测（`{"paused":true}`） | 失败 → 不部署 |
| `/orchestrator/api/tickets?state=open` | 升级前 open Ticket 门禁 | H0 历史曾有 2 个 open；每次部署重新查询 | 读不到/非 0 → 拒绝 |
| `sessionQuery.readSession(id)` | 当前 Session 事件快照（A1-BIND 核心） | 仅历史快照观察（H1/H2 未在当前候选验证） | 不可用 → 绑定不可启用 |
| `jobs.get(jobId, sessionId)` / `jobs.readAt` | 后台检查终态与输出（K3/A1-OUT） | H3 一次性 profile 已验证，生产 ready 调用链未证实 | 不可得 → ready 拒绝 |
| `state/orchestrator.sqlite`（WAL） | 停机后 effect 最终查询 | H0/H7 实测；工具 `scripts/host/check-effects-db.mjs` | 查询失败 → 不切换 |
| `start.sh` / `dsh-superagent stop` | 维护停机与重启 | H0 实测（stop exit 0、restart 11s 健康） | 失败 → 中止并恢复 |
| 实载 commit 回读 | 证明运行的构建 | 双入口激活 + 新任务决策 pluginCommit（D4）；当前部署已激活，任务交叉回读待做 | 记录 `loadedCommitReadback: unverified` |

## 2. 兼容性回归规则

1. **宿主升级（DSH/Super Agent 版本变化）后、部署新插件前**，必须复跑：
   - `node hephi/scripts/check-stage-host.mjs`（staged 夹具，既有）；
   - `node hephi/scripts/check-binding-host.mjs --session <快照> --check-record <run.json> --host <url>`（H1/H2/H4 自动 + H3/H5/H6 人工步骤）；
   - `node scripts/host/check-effects-db.mjs --db <state>/orchestrator.sqlite --mode ro --json`（运行中预检查）；
   - `node scripts/host/test-deploy-hephi.mjs`（PR40 假宿主 281 断言，机制回归；含 F1 meta v2 完整性与 legacy 显式授权）。
   - `--drain effects` 必须显式 `--stop-command`（宿主自己的 stop 脚本）；未验证的默认 SIGINT 路径已删除（fail-closed）；停机后自动重启检测窗口默认 10s（`--auto-restart-wait` 可调）。
2. 任一项 fail → 停止部署，按 A2 记录定位；不得用“健康 ready”替代接口兼容性。
3. 插件侧假设变更（如 Session 事件形状、Job detail 格式）必须同步更新本文与 A1-BIND 的适配分支。
4. 升级前后各记录一次宿主版本（DSH 版本 + composed-config sha256 或 API 提供的版本）；`hostVersion` 正式语义见 `../../docs/deployment-prerequisite-decisions-2026-11-07.md` D2；每次部署重新记录来源。
5. 兼容性记录路径：`hephi/docs/validation/<date>-host-compatibility.md`（本模板只定义规则，不含结论）。

## 3. 已观察到的宿主差异（历史，需在当前候选复验）

| 观察 | 来源 | 影响 |
| --- | --- | --- |
| 内部 dispatch 只留 `job/registered`/`job/settled`，无 innerCallId 的 `tool/call` | A2 历史快照（2026-11-06/07） | A1-BIND 需要路径 B 适配（已实现，待复验） |
| 持久化 `tool/result.message` 无结构化 `value`，退出码只有 `[exit code: N]` 文本 | 同上 | 路径 A 前台输出不可得 → 绑定开时 `ready.output-unverified` 拒绝 |
| 一次性 profile 中 foreign Session 被拒；生产 ready 链路仍未验证 | H3 一次性 profile 已验证，生产 ready 调用链未证实 | 影响后台证据归属判定 |
| 宿主 `load` 只有 running/queued/maxWorkers | G1/H0 | 5 个 drain 字段不可用 → §4.5 停机式排空 |
| clean shutdown 后 `sqlite3 -readonly` 无法打开（无 -shm） | H0/H7 | 停机后必须 copy 模式查询 |

## 4. 未验证 / 待完成

- A2 探针在当前候选插件上的真实复跑（H1–H6 全部）。
- 宿主升级回归记录（尚无升级事件）。
- 当前候选真实任务的 `pluginCommit` 交叉回读；D2/D4 已有正式记录，不再作为缺决策阻塞。
- H6 同 UID 可写的已知边界保持；不以文档更新宣称隔离或强绑定通过。
- 本文不声称任何宿主契约已兼容；所有“实测”仅限所列时点与命令。

本次部署原件：`/Users/zm/dsh-instances/experiment/logs/deploy-20261107T181639Z-43593.json`，target=`bc21caca316d6032ebcc3d2bc6387c38e0a3579c`、previous=`e490fe34dfd13117db2516d9b9c7cb0459c1d219`、result=`ok`、activation=`verified`、keptPaused=`yes`。这是部署结束状态，不证明后续真实任务已通过。
