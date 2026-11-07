# A5 端到端验收脚手架（场景矩阵 + 记录规范）

状态：**脚手架 v0.1；现状更新于 2026-11-08**。本目录已有历史真实 E2E 记录，汇总见
[`../2026-11-07-s4-acceptance.md`](../2026-11-07-s4-acceptance.md)。当前 `bc21caca` 已部署并有双入口激活回读，
但尚无该候选的完整 A2/A5 复验；历史 `e490fe34` 的成功不能作为当前构建通过证据。
本文件提供 A5 场景矩阵、证据采集规范与记录脚手架；任何场景的执行都由操作者在真实宿主上用真实 Issue 完成，
本文件与 `hephi/scripts/e2e-record.mjs` **都不执行**验收、不创建 Issue/PR、不读写宿主状态。

> **总声明（适用于全部场景，不得省略）：假宿主 / fixture / 单元测试通过 ≠ E2E 通过。**
> E2E 只指：真实宿主 + 真实 Issue/Ticket/Worker + 真实 git/PR 链路的一次运行；
> 夹具测试只证明机制，不能填入本目录作为通过证据。

## 1. 不可协商的门槛

1. **E9（后台检查）与 E5（检查中宿主中断）前置未满足前，禁止执行、禁止声称通过。**
   - E9 依赖 A1-BIND 后台分支 + **H3 真实宿主探针**（`jobs.get` 终态/`detail`、错误 Session 行为、`readAt.lossy`）；
   - E5 依赖 A3（已合并）+ 真实宿主中断/停机探针 H0、SQLite 停读方案 H7、A3 真实宿主验证；
   - 已有 `hephi/docs/validation/2026-11-07-a2-final.md` 历史结论：H1/H4 pass、H2/H6 fail，H3 仅一次性 profile 验证，H5 仅无截断分支；生产 ready 调用链和当前候选复验不足，强绑定保持关闭。H0/H7 历史探针已做，不替代 A3 真实恢复验证；因此 **E9/E5 仍为 `blocked`，不得 pass**。
2. **`--status pass` 的机器强制条件**（`e2e-record.mjs` 实现）：
   - 至少 **3 条 `--evidence`**（真实证据路径/SHA/命令输出，不是描述性文字）；
   - `--loaded-sha` 不能是 `unverified`（磁盘哈希不得替代实载 commit 回读）；
   - E9/E5 即使满足上述条件也拒绝 pass（前置未满足）；
   - **结论字段永远为“待填写”**，脚本不预填通过；结论由复核者按证据填写。
3. **记录不可覆盖、不可事后改写**：同一场景同一天的新运行另建文件；历史记录保留
   （`e2e-record.mjs` 拒绝覆盖已存在文件）。原始证据按 P14 留在宿主/证据目录，不提交生产数据。
4. **版本流水线（P2-7）**：每次运行记录**运行中的构建 SHA**；任何新提交按 S1–S4
   重新执行对应阶段并重跑相关场景；**只改文档不重新部署**。S1–S4/S6 的具体定义见外部
   实施计划与审查报告（`ROADMAP95-plan-review.md`），仓库内不复刻。
5. **实载回读（P0-4）**：部署候选后必须回读实载 SHA（见 §4）；读不到写 `unverified`，
   不得把磁盘哈希、重启时间或“看起来加载了”当实载证据。

## 2. 记录规范

- 路径：`hephi/docs/validation/e2e/<date>-<scenario>.md`
  （日期 `YYYY-MM-DD`，场景 id 见矩阵；例如 `2026-11-07-E1-on.md`）。
- 生成：用脚手架生成骨架，再由操作者/复核者填写“待填写”字段：

  ```sh
  node hephi/scripts/e2e-record.mjs \
    --scenario E1-on --candidate-sha <40hex> --loaded-sha <40hex|unverified> \
    --out hephi/docs/validation/e2e/2026-11-07-E1-on.md \
    --issue <n> --pr <n> --contract-hash sha256:<hex> \
    --evidence <path-1> --evidence <path-2> --evidence <path-3>
  ```

- 记录必须包含：宿主版本/实例、命令与退出码、脱敏原始输出、Issue/Ticket/Session、
  contractHash、run.json/output.log、decisions.jsonl、PR 状态、候选 SHA、实载 SHA、结论。
- 状态取值：`pending`（未完成）/ `pass`（全部证据齐备且人工复核）/ `fail` / `blocked`。
- 同一记录中“状态”与“结论”都必须有；`--status pass` 落盘后仍需人工填写结论，二者一致才有效。

## 3. 通用证据采集（所有场景）

| 证据 | 位置/命令 |
| --- | --- |
| 宿主版本/状态 | `curl -s http://127.0.0.1:3083/orchestrator/api/state`（只读；记录 `paused`/`load`/`health`/版本来源） |
| 激活合同 | `<state>/hephi/<ticketId>/activation.json`（contractHash、baseSha、allowedPaths、verification、evidence） |
| 检查记录 | `<state>/hephi/<ticketId>/checks/<runId>/run.json` + `output.log`（状态/exitCode/sessionId/callId/innerCallId/前后指纹/outputHash） |
| 决策日志 | `<state>/hephi/<ticketId>/decisions.jsonl`（ready 规则：`ready.pass`/`ready.evidence-missing`/`ready.pr-mismatch`/`ready.binding`/`ready.job-unavailable`/`ready.output-unverified`/`ready.plugin-build`/`ready.other`） |
| A3 解除记录 | `<state>/hephi/<ticketId>/resolutions.jsonl`（仅 E5/A3 使用；不构成通过证据） |
| PR 状态 | `gh pr view <n> --repo <repo> --json number,state,baseRefName,headRefOid,url` |
| 最终 diff/工作区 | `git status --short`、`git diff --stat <baseSha>..HEAD`、`git rev-parse HEAD` |
| 实载回读 | `decisions.jsonl` 最后一条的 `pluginCommit`（D4(a)）或启动日志行（D4(b)，需产品改动走 S1/S2） |

脱敏：不写 token/凭据；路径可用 `$HOME/<state>`；Session/Job id 可保留（验收需要关联），
但不得把宿主凭据、完整账号信息写入记录。

## 4. 版本流水线与实载回读（P2-7 / P0-4）

**运行中的构建 SHA**：记录构建该插件的完整 commit SHA（候选 SHA）。构建/部署/运行若不是
同一提交，必须分别记录，不得混写。

**实载回读序列（P0-4，缺一不可）**：

1. 部署候选（S3）→ 启动 → 10 项健康 ready；
2. 解除暂停 → 跑一条受控 smoke（标 `SMOKE_ONLY`，复用 R3.7 第 6 项模式）；
3. 读取该 Ticket 的 `decisions.jsonl` 最后一条 `pluginCommit`（D4(a)）或启动日志行（D4(b)）；
4. **关闭 smoke Ticket**（否则下一次部署被 open-ticket 门禁拒绝）→ 再暂停；
5. 读不到 → 记录 `unverified`；不得用磁盘哈希/重启时间替代。

边界（R3.7/R37 已确认）：决策日志 `pluginCommit` 需要至少一次真实工具调用，日志可被
同用户 Worker 写入，因此它只是**运行时证据**，不能替代 A1/A2 的完整证据链。

**新提交**：任何代码/构建配置变化都按 S1–S4 重新执行对应阶段并重跑受影响场景；
**只改文档不重新部署**，也不得用旧构建的运行记录冒充新提交的 E2E。

**合并提交（P2-7）**：本仓库用 merge commit 合并 PR。若最终验收对象是 `main`，冒烟/验收
必须针对 **merge commit 的构建**；仅验证 PR head 构建不足以声称 main 已验收，除非按计划
对合并提交再冒烟并记录。

## 5. A5 场景矩阵

> 历史场景状态见 §6 及逐场景记录：E1-off 为 **partial**，E9/E5 为 **blocked**；其他已有通过记录仅适用于所记历史构建。
> 当前 `bc21caca` 已部署，真实 A2/A5 复验仍未完成。**E1-on 表示启用插件，不表示绑定开启；E1-off 表示无插件对照。**
> 每个场景都必须按“检查 → 创建/更新 PR → ready → 交付”的顺序执行，并在记录中逐项留证。

### E1-off｜对照组：不开赫菲

- **前置**：真实 Issue + 与 E1-on 逐字节相同的任务卡；不打 `hephi/delivery`、不挂载插件；
  off 组任务卡投递方案已批准（见 `eval/RUNBOOK.md` §4）。
- **执行顺序**：创建 off Issue（同文任务卡）→ 原生 Worker 实施 → 原生 PR → 核对无 HEPHI 合同。
- **操作命令/入口**：`gh issue create --repo <repo> --title <title> --body-file <issue.md>`（不打标签）；
  不触发 prepare/合同。核对：`test -e <state>/hephi/<ticketId>` 及 `checks/`、`decisions.jsonl` 不存在。
- **必须采集的证据**：Issue 编号/URL 与任务卡 sha256；PR 编号/HEAD/state；无合同/检查/决策日志的检查输出。
- **通过条件**：原生交付完成且**没有任何** HEPHI 合同/检查/决策日志。
- **失败/blocked**：出现 HEPHI 合同/检查/决策记录（off 组被误启用）；或原生交付失败。
- **声明**：假宿主/单测 ≠ E2E；E1-off 是 A5 对照组，**不计入赫菲场景通过数**，不能代替 E1-on。
- **记录路径**：`e2e/<date>-E1-off.md`（写入 `hephi/docs/validation/e2e/`）。
### E1-on｜正常修复（范围内改动）

- **前置**：候选构建与实载回读可用（P0-4）；绑定默认关闭（若开启绑定，还需 A2/H1–H5 结论）；H4（记录 sessionId 与 Session 头 id 一致性）未确认时 ready 可能拒绝，应记录 blocked 并保留证据，不得改记录绕过。
- **执行顺序**：Issue（`hephi/delivery`+任务卡）→ prepare 冻结合同 → Worker 修改+`hephi_check` →
  推送并创建 PR → `orchestrator_report(ready, pr_number=N)` 通过 → 交付。
- **操作命令/入口**：真实 GitHub Source Issue；Worker 工具序：`hephi_get_contract` → 修改 → `hephi_check` →
  `git push` + `gh pr create` → `orchestrator_report(state=ready, pr_number=N)`。
- **必须采集的证据**：Issue/Ticket/Session；`activation.json`（contractHash/baseSha/allowedPaths）；
  `run.json`（passed/exit 0/sessionId/callId/innerCallId/finishedAt/前后指纹）+ `output.log` sha256；
  `decisions.jsonl` 的 `ready.pass`；PR（open、HEAD == before.headCommit）；候选/实载 SHA。
- **通过条件**：检查 passed/exit 0；ready 通过；PR open 且 HEAD 与被验证 HEAD 一致；实载 SHA 可核验；无越界。
- **失败/blocked**：检查未 passed、ready 拒绝、PR HEAD 不一致、实载 SHA unverified、越界改动。
- **声明**：假宿主/单测 ≠ E2E；绑定关闭时 ready 仍要求 Session id（A1-K4），H4 未确认前不得声称绑定通过。
- **记录路径**：`e2e/<date>-E1-on.md`（写入 `hephi/docs/validation/e2e/`）。
### E8｜Issue 缺任务卡

- **前置**：prepare 脚本默认 `HEPHI_REQUIRE_TASK=1`（插件侧 env 默认 false，必须由 prepare 设置），任务卡校验为当前构建。
- **执行顺序**：创建带 `hephi/delivery` 但不含 `hephi-task` 块的 Issue → 观察 prepare → 核对无合同。
- **操作命令/入口**：`gh issue create ...`（正文不含 ```hephi-task``` 块）；触发 prepare。
- **必须采集的证据**：Issue 编号；prepare 拒绝输出与退出码；`activation.json` 不存在的检查输出。
- **通过条件**：prepare 拒绝，不创建合同，不启动 Worker。
- **失败/blocked**：prepare 成功或创建合同。
- **声明**：假宿主/单测 ≠ E2E；不得用纯单测的 prepare 负例代替真实 Issue 拒绝记录。
- **记录路径**：`e2e/<date>-E8.md`（写入 `hephi/docs/validation/e2e/`）。
### E2｜Worker 尝试编辑范围外文件（直接工具）

- **前置**：合同 allowedPaths 明确；`edit`/`write` 守卫按实际路径解析（A4）。
- **执行顺序**：任务卡只允许 `src/**` → Worker 用 edit/write 改范围外文件 → 观察当场拒绝 → Worker 改回或报 blocked。
- **操作命令/入口**：Worker 工具调用 `edit`/`write` 指向 allowedPaths 之外；观察 guard 拒绝消息。
- **必须采集的证据**：拒绝消息/Session 事件（agent 与 path）；最终 `git status/diff`；run.json/ready 结果；Ticket 回复状态。
- **通过条件**：越界编辑当场被拒；Worker 改回或 blocked；最终无越界文件。
- **失败/blocked**：越界编辑进入最终 diff，或 ready 未拒绝越界证据。
- **声明**：假宿主/单测 ≠ E2E；该场景验证 A4 守卫，不验证 shell 写入（见 E3）。
- **记录路径**：`e2e/<date>-E2.md`（写入 `hephi/docs/validation/e2e/`）。
### E3｜Worker 用 shell 写范围外文件并提交

- **前置**：最终 diff 校验与 ready 的 `checkDiscipline` 生效。
- **执行顺序**：任务卡范围 `src/**` → Worker 用 bash 写范围外文件并 commit/push → `hephi_check`/ready 应拒绝。
- **操作命令/入口**：`bash` 写 `outside/**` 并提交；随后 `hephi_check` + `orchestrator_report(ready)`。
- **必须采集的证据**：shell 命令与 Session 事件；`run.json` 前后指纹/变更文件（含越界）；拒绝 reason 与 `decisions.jsonl`；PR HEAD/工作区状态。
- **通过条件**：检查与 ready 均拒绝（检查在启动前检测已有越界/检查期间 `source changed during check`；ready 用最终 diff 兜底），理由指向范围外改动；不得交付。
- **失败/blocked**：越界 shell 改动被检查或 ready 任一放行（未拒绝）。
- **声明**：假宿主/单测 ≠ E2E；E2 守卫拦不住 shell，E3 验证最终 diff 兜底。
- **记录路径**：`e2e/<date>-E3.md`（写入 `hephi/docs/validation/e2e/`）。
### E4｜检查目录配置错误（check not started → 修正后重试）

- **前置**：合同冻结检查的 cwd 校验（`contained`）；blocked 记录保留可重试；重试需重新 prepare（同一 Ticket 会生成新合同并覆盖 `activation.json`，不手工改旧合同/旧记录）。
- **执行顺序**：prepare 合同含错误 cwd → `hephi_check` 记 blocked（`check not started:`）→ 修正配置并重新 prepare → 重跑检查成功 → 核对历史记录保留。
- **操作命令/入口**：`HEPHI_VERIFICATION_FILE` 中 `check.cwd` 指向不存在目录；修正后重新 prepare（生成新合同；不手工改旧合同/旧记录）。
- **必须采集的证据**：首个 `run.json`（blocked，reason 前缀）；修正后的新 contractHash/activation；重试 `run.json`（passed）；旧 `run.json/output.log` 未变。
- **通过条件**：首次确定未启动记 blocked；修正后新合同重试通过；历史证据原样保留。
- **失败/blocked**：错误记成 passed/unknown；历史证据被覆盖/删除；无法重试。
- **声明**：假宿主/单测 ≠ E2E；合同冻结配置，修 cwd 通常需要新 prepare，不能就地改旧合同。
- **记录路径**：`e2e/<date>-E4.md`（写入 `hephi/docs/validation/e2e/`）。
### E5｜检查执行中宿主中断（A3 前后两段）— **BLOCKED**

- **前置**：A3 已合并（`resolutions.jsonl` + runner 跳过 + `hephi resolve`）；**真实宿主停机探针 H0、
  SQLite 停读 H7 已有历史证据（见 `docs/deployment-prerequisite-decisions-2026-11-07.md`），但 A3 可信操作者边界及当前候选真实恢复验证仍未完成**。
- **执行顺序**：检查执行中让宿主中断/连接断开 → 记录遗留 `running`/`unknown` → ready 拒绝 →
  操作者用 `hephi resolve` 解除 → 重新检查 → 核对旧记录不变。
- **操作命令/入口**：中断宿主（或模拟连接断开）；恢复后
  `hephi resolve --ticket <id> --run <runId> --basis host-terminal|operator-risk-accepted --status ... --operator <name>`，
  再重跑检查；开关 `HEPHI_ALLOW_OPERATOR_RESOLUTIONS=1` 由宿主配置接线（默认关闭）。
- **必须采集的证据**：中断前后宿主状态/进程记录；`run.json`（running/unknown）+ output.log；ready 拒绝 reason；
  `resolutions.jsonl`（basis/hostQuery/operator/at）；重跑记录与最终交付。
- **通过条件**：遗留执行记 running/unknown 且 ready 拒绝；经 A3 resolve 后重新检查通过；旧记录不被改写。
- **失败/blocked**：遗留执行被放行；resolve 被当通过证据；旧记录被编辑；无法恢复。
- **声明**：假宿主/单测 ≠ E2E；**前置未满足前禁止执行/禁止声称通过**——当前只能记 `blocked`。
- **记录路径**：`e2e/<date>-E5.md`（写入 `hephi/docs/validation/e2e/`）。
### E6｜ready 之后又提交了改动

- **前置**：ready 证据粘滞在检查时的 HEAD/patch（before/after 指纹）。
- **执行顺序**：检查+首次 ready → ready 之后追加提交/改文件 → 再次 ready 应拒绝过期证据。
- **操作命令/入口**：首次 ready 通过后在同一 Worker 追加 commit（或改工作区），再 `orchestrator_report(ready)`。
- **必须采集的证据**：首次 ready 的 run.json/decisions；追加 commit 的 HEAD/diff；第二次 ready 拒绝 reason（stale evidence/source changed）；decisions 记录。
- **通过条件**：第二次 ready 拒绝，理由为证据过期/源码变化。
- **失败/blocked**：第二次 ready 仍通过（旧证据被复用）。
- **声明**：假宿主/单测 ≠ E2E；不得用“重新跑一次 ready 通过”覆盖第一次证据过期的事实。
- **记录路径**：`e2e/<date>-E6.md`（写入 `hephi/docs/validation/e2e/`）。
### E7｜PR HEAD 与本地不一致

- **前置**：ready 使用 PR API 核对 state=open/baseRef/headSha。
- **执行顺序**：完成检查 → 创建/更新 PR → 再次推送改变 PR HEAD → ready 应拒绝 PR mismatch。
- **操作命令/入口**：ready 前在远端给同一 PR 追加 commit；`orchestrator_report(ready, pr_number=N)`。
- **必须采集的证据**：PR 编号与远端 HEAD；本地被检查 HEAD/`before.headCommit`；拒绝 reason（PR/base/HEAD mismatch）；decisions。
- **通过条件**：ready 拒绝且理由为 PR/base/HEAD mismatch。
- **失败/blocked**：Head 不一致仍 ready 通过。
- **声明**：假宿主/单测 ≠ E2E；与 E-PR1 区分：E-PR1 验证首次创建，E7 验证不一致拒绝。
- **记录路径**：`e2e/<date>-E7.md`（写入 `hephi/docs/validation/e2e/`）。
### E9｜后台检查正常完成（Job 终态绑定）— **BLOCKED**

- **前置**：A1-BIND 后台分支已有实现；**H3 真实宿主 ready 路径**（`jobs.get` 终态/detail、错误 Session 行为、`readAt.lossy`）尚未证明。历史一次性 profile 的 H3 通过不能替代当前生产 ready 链路，H6 fail 下强绑定保持关闭。
- **执行顺序**：长检查提升为后台 Job → 等待完成 → ready 通过并绑定 Job 终态/输出 → 交付。
- **操作命令/入口**：合同检查超时被提升（`promoteOnTimeout`）或显式后台；ready 时 `ctx.jobs` 可用。
- **必须采集的证据**：`run.json` 的 jobId/status/exitCode/outputHash；`job/registered`/`job/settled` 与 Session 快照；
  H3 结论；ready decisions（job 绑定/输出校验）；PR/交付状态。
- **通过条件**：ready 通过，且 Job 终态、detail 退出码、`readAt` 输出哈希全部核对通过。
- **失败/blocked**：Job 终态/输出不可得却放行；lossy 被忽略；绑定失败仍通过。
- **声明**：假宿主/单测 ≠ E2E；**前置未满足前禁止执行/禁止声称通过**——当前只能记 `blocked`。
- **记录路径**：`e2e/<date>-E9.md`（写入 `hephi/docs/validation/e2e/`）。
### E10｜行为保持型重构任务

- **前置**：任务卡验收项引用行为检查（`kind=test`）；项目检查表达“行为保持”的可机械验证部分。
- **执行顺序**：Issue 任务卡为重构 → prepare → Worker 重构 + `hephi_check` → PR + ready → 交付。
- **操作命令/入口**：真实 Issue（重构任务卡）；检查命令覆盖重构前后行为等价性中可机械验证部分。
- **必须采集的证据**：Issue/任务卡与 contractHash；重构前后检查 output + run.json；PR HEAD 与被验证 HEAD；
  decisions；如声称行为保持，需说明检查覆盖范围。
- **通过条件**：检查通过、ready 通过、PR 创建且绑定一致。
- **失败/blocked**：检查/ready 失败，或行为回归未被项目检查捕获。
- **声明**：假宿主/单测 ≠ E2E；机制只证明合同检查通过，**不能证明语义完全等价**或排除未覆盖的行为漂移。
- **记录路径**：`e2e/<date>-E10.md`（写入 `hephi/docs/validation/e2e/`）。
### E-PR1｜首次创建 PR

- **前置**：`requirePullRequest=1`；ready 要求 `pr_number` 且 PR state=open/baseRef/headSha 匹配。
- **执行顺序**：Worker 完成修改与检查 → 首次创建 PR（无既有 PR）→ `orchestrator_report(ready, pr_number=N)` → 交付。
- **操作命令/入口**：`gh pr create`（首次，同分支无既有 PR）；随后 ready。
- **必须采集的证据**：PR 首次创建事件/编号/URL/HEAD/state/baseRef；run.json `before.headCommit`；ready 通过记录；Issue 回复/交付。
- **通过条件**：首次 PR 创建成功；ready 核对的 pr_number/HEAD/base 全部一致并通过。
- **失败/blocked**：无法创建 PR、pr_number 缺失、PR state/HEAD/base 不一致仍通过。
- **声明**：假宿主/单测 ≠ E2E；E-PR1 不覆盖更新既有 PR 的场景（归 E7/常规流程）。
- **记录路径**：`e2e/<date>-E-PR1.md`（写入 `hephi/docs/validation/e2e/`）。
## 6. 当前状态与 A5 完成判定

| 场景 | 当前状态 | 解除条件 |
| --- | --- | --- |
| E1-on / E2 / E3 / E4 / E6 / E7 / E8 / E10 / E-PR1 | 历史记录 pass（各自范围内） | 见 [S4 汇总](../2026-11-07-s4-acceptance.md) 及逐场景记录；当前候选仍需真实复验。E1-on 为等价清理；E-PR1 沿用同一 run 的首次 PR 创建流程 |
| E1-off | **partial** | 补齐干净 off 环境、无插件挂载/提示/工具和任务卡 provenance；无 HEPHI state 本身不足 |
| E9 | **blocked** | A1-BIND 后台分支 + H3 真实宿主探针通过并记录；且 H1/H2 编码问题按 A2 结论处理 |
| E5 | **blocked** | H0/H7 已有历史记录；仍须满足 A3 可信边界并补当前候选真实中断、解除和重跑验证 |

A5 完成判定（D5 可评 L1 的前提）：矩阵中**全部应执行场景**都有真实 E2E 记录且人工复核通过；
E9/E5 在解除条件满足前不得计入完成；**不得用单测/fixture 补空**。人类负责人签收前，
A5 与 D5 均不得记为验收通过。

## 7. 关联

- 场景来源：`ROADMAP-95.md` §A5。
- 版本流水线/合并提交：`external-review/ROADMAP95-plan-review.md` P2-7。
- 实载回读序列：同报告 P0-4（D4）。
- 记录脚手架：`hephi/scripts/e2e-record.mjs`（`--help`；`--self-test`）。
- 宿主证据链：`hephi/docs/validation/2026-11-07-evidence-chain-host.md`（模板）；`hephi/docs/validation/2026-11-07-a2-final.md`（历史定案与限制）。
- 当前候选部署：`<instance>/logs/deploy-20261107T181639Z-43593.json`（target=bc21caca、activation=verified；不是 A5 通过证据）。
- A1 绑定边界：`hephi/README.md`「证据链核对（A1-BIND / A1-OUT）」。
