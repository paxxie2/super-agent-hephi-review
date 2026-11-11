# T10 重跑前置：3085 部署固定版本实载记录

日期：2026-11-12 · 记录人：Lead · 基线 main `48cc76f`
用途：T10 重跑前的"固定版本"证据；3086 保留冻结对照不参与。

## 1. 实载三方 SHA（真实回读）

| 组件 | 实载值 | 回读方式与证据 |
| --- | --- | --- |
| **DSH 宿主** | `0.2.1-rc.5` | `node <runtime>/@deepseek-ai/dsh/lib/bin.js --version` → `0.2.1-rc.5`；`package.json.version` 同值（`/Users/zm/dsh-instances/runtime/node_modules/@deepseek-ai/dsh`） |
| **Super Agent** | `cd384e7f8eec217e624615e749e1c3a9f810c08f` | `git -C /Users/zm/dsh-instances/g1-exp/superagent rev-parse HEAD` |
| **赫菲（hephi）** | `ab5f527a11655dd3e935a634d3b5c62f0a265f51` | host.log 两条 `[hephi-activation] entry=index/tools commit=ab5f527… pid=33924`；pid = `host.pid` 内容 33924；不可变 release 位于 `releases/hephi/ab5f527…/`（formatVersion 2，meta.json pluginCommit 同值） |

## 2. 生效配置（回读）

| 项 | 值 | 说明 |
| --- | --- | --- |
| profile bundles | `dsh-base`, `dsh-web-app`, `dsh-superagent`, `hephi-superagent-plugin` | `dsh-home/profiles/g1-exp/package.json` |
| 插件指针目录 | `hephi-review/hephi/`：`lib → releases/hephi/ab5f527…/lib`、`node_modules → releases/…/node_modules`、含 `cordis.patch.yml`/`package.json`/`scripts/` | 指针结构（非工作树），保证制品不可变 |
| 派发状态 | `paused: false`（settings-revision 21） | orchestrator.sqlite kv 回读 |
| executor | `maxWorkers: 3` | 同上 |
| GitHub source | 主仓 `paxxie2/b5-off-history-page-size`，`pollSeconds: 60`，另监听 5 个附加仓 | 同上 |
| 操作者通道 | `operator-config.json` 权限 `-rw-------`（0600），`allowOperatorResolutions: true` | `ls -l` 实测 |

## 3. 3086 冻结对照（未触碰）

- 对照组制品：`releases/hephi/6d24e1b39b75948b02c7dbd5fbac3e1af3c5ff80`
- 端口 3086 未监听（未启动）；本记录未对 3086 做任何部署、启动或写入。

## 4. 符合预登记条件的 OPEN PR（T10 重跑所需）

T10 的 `verify.mjs` 对 PR 的检查是**硬编码到具体交付**的（`pullRequest(realActivation.repository, 22)` + 断言 `pr.headSha === 真实交付 head`），不是"任意 OPEN PR"。

因此重跑的前置条件是：**新 Issue 触发的新交付，其 PR 在核验时点仍为 OPEN，且 head 与该次交付的 `after.headCommit` 一致**。

当前各被监听仓的 OPEN PR 清单（`gh pr list --state open` 实测）：

| 仓库 | OPEN PR 数 | 备注 |
| --- | --- | --- |
| b5-off-history-page-size | 0 | A1 交付 PR#22 已 MERGED（漂移来源） |
| b5-off-health-service-field | 0 | — |
| b5-off-money-window-helpers | 0 | — |
| b5-off-money-window-helpers-r2 | 0 | — |
| b5-off-backend-input-validation | 1 | PR#8 属历史交付，与本次重跑无对应关系 |

结论：**当前没有可直接复用的 OPEN PR**；符合条件的方式是从新 Issue 重新交付一次，并在核验时点保持其 PR 为 OPEN（核验须在合并之前完成）。

## 5. 未执行 / 边界

- 本记录只做只读回读，未改动部署、未重启宿主、未产生 Worker 运行支出。
- 未重新回读 activation markers 之外的运行时内部状态；未验证宿主 `jobs.readAt/lossy` 语义。
- 3085 当前 `paused: false`，若此时有新 Issue 会在 60s 内被接单并产生真实 Worker 运行——重跑 T10 前需明确这一点并按计划投递。
