# DSH 宿主任务单：能力 A（Worker 无权改写交付证据）+ 能力 B（结构化交付绑定记录，Ticket↔Session↔执行结果↔最终提交 SHA）（2026-11-12）

> **状态：宿主任务单（host task order），可交办、可验收。**
> 任务来源：team task-35（最高优先级；用户要求先派 DSH 宿主任务解决 T10）。执行者：hephi-req。基线：`/Users/zm/repos/hephi-review-main` @ `48cc76f`（任务开始时 main，工作树干净；提交时 HEAD 已前进到 `5630f87`，该提交仅新增 `eval/evidence/t10-rerun/deploy-record.md`，**本文引用的文件均未改动**——已用 `git diff --name-only 48cc76f..HEAD` 核对）。
> **本文不承诺排期、不指定/不虚构宿主团队联系人**；只固定**可观察需求 + 验收口径 + 证据形态**。宿主侧实现方式（UID 模型、写入通道拆分、记录落盘/查询接口、字段命名）由宿主负责人决定，本文给出语义最小值。
> **基线关系**：本文在已重建的 `hephi/docs/validation/2026-11-11-dsh-host-requirements.md` 的 R1（结构化 `tool/result.message.value`）与 R2（证据载体只读）基础上扩展 **B2 四元绑定记录**；R1/R2 契约仍有效（该文件 §2.2 `:39-49`、§2.4 `:56-74`、§3.1 `:84-91`、§3.3 `:98-108`）。
> 红线：本任务单不改任何源码；文中所有引用均在 `48cc76f` 工作树核对存在（核对命令见 §8）。

## 0. 摘要

| 能力 | 用户口径 | 最小可观察契约 | 验收门（都必须有正反向对照） |
| --- | --- | --- | --- |
| **A 写权限** | Worker 无权改写宿主保存的交付证据 | Worker 会话进程（bash 及其子进程、工具执行进程）对自身 Session 持久化快照与 hephi 状态目录**无写权限**；拒绝必须是 **OS 级**（非 PATH/工具白名单/沙箱策略开关）；**宿主进程写通道保留** | 用**实际 Worker 身份**执行写入尝试（不是操作者身份）：拒绝 + 前后哈希不变 + OS 拒绝原文；同时宿主正常落盘三项（新检查记录/`decisions.jsonl` 追加/快照正常增长）全部成立；人工结论签署 |
| **B 结构化记录** | 宿主能输出结构化记录，把本次 Ticket、Session、执行结果、最终提交 SHA 四者对应起来 | **B1**：持久化 `tool/result.message.value` 携带契约级 `{kind, exitCode?, jobId?}`；**B2**：可核验的四元绑定记录（Ticket↔Session↔执行结果↔最终 commit SHA），ready 门禁无需文本解析 | B1：真实 Session 上结构化 value 覆盖全部 bash result（探针 `rings[H2]=pass`）；B2：四元关系逐项等于权威来源（合同/Ticket、Session 头、检查记录、PR/最终 commit），且 record 稳定可读；人工结论签署 |

**不做的后果**：D1 上限卡 L1（`ROADMAP-95.md:59` + V4 `:109`）；T10 保持 blocked（`eval/evidence/t10-host-verification/report.md:171-187`）；两类合法路径 0/2（`eval/evidence/a2a3-binding-decision/material.md:60`）；A1-BIND 强绑定保持关闭（`hephi/docs/validation/2026-11-07-a2-final.md:163-167`）。

## 1. 背景：两个阻断项（每条引用 file:line）

### 1.1 H6：Worker 可写自己的 Session 快照与 hephi 状态目录（当前 fail）

- **判据**（`hephi/docs/validation/2026-11-07-evidence-chain-host.md:156`）：Worker 无法让 Session 快照/检查记录出现未发生的可信事件；任一自影响成功即 fail；判定方式 **人工（一次性实例）**。
- **fail 定案**（`hephi/docs/validation/2026-11-07-a2-final.md:59`）：一次性 profile 中 Worker 用 bash 原生 `>>` 追加快照（`append_exit=0`）并写伪造 `state/hephi/.../run.json`（`state_write_exit=0`）；**生产 B 未做写入尝试**（按方案禁止）；无"追加前"哈希对照（`:210` 登记未做）。
- **现状信任边界**（`hephi/docs/threat-model.md:20-21`）：状态目录可被 Worker 所在进程写入（**同一宿主进程/同一 UID**），Session 快照 H6 fail（一次性 profile 实测）；`:49` 明确"同用户 Worker 可以伪造 run.json/追加 Session 快照"。
- **检测 ≠ 防护（hephi 侧已恢复的 detect-only 不能替代本任务单）**：`hephi/src/control/snapshot-seal.ts` 自述 "This is a **DETECTION** mechanism, not a protection"（`:5-23`），实现前缀封存 + 帧流尾部校验（`:36` 的 64MiB 上限）；其边界在 README 已知限制第 4 条（`hephi/README.md:95`）与决策规则（`hephi/docs/decisions-format.md:44`）中明确：**同 UID 仍可改写快照/检查记录、合法伪造帧不可区分**。恢复提交为 `6a51c3e`（任务卡点名 exp-054；`git log -1 6a51c3e` 存在）。
- 结论：**能力 A 未满足，H6 仍 fail**；检测层只把"已列举篡改形态"变得可观察，不改变"Worker 同 UID 可写"的根因。

### 1.2 H2：前台结果无结构化 `message.value`（当前 fail，B1 的来源）

- **判据**（`hephi/docs/validation/2026-11-07-evidence-chain-host.md:152`）：前台 `tool/result.message.value` 有结构化 `kind`；`foreground` 带整数 `exitCode`；`promoted/background` 带 `jobId` 且无最终退出码。
- **历史定案 fail**（`hephi/docs/validation/2026-11-07-a2-final.md:55`）：`bashResultCount=16`、`structuredValueCount=0`、`kinds=[]`；退出码只以文本 `[exit code: N]` 出现。
- **2026-11-12 真实快照复现**（`eval/evidence/t10-host-verification/report.md:23`）：真实 Session 快照 170,899 字节/151 zstd 帧/264 事件，`tool/result` **结构化 value = 0**，`job/registered` 22 + `job/settled` 22。
- **消费方代码已按结构化契约编写（当前行号）**：`hephi/src/control/check-runner.ts:474-475` 只在 `value.kind === 'foreground'` 且整数 `exitCode`、未 `timedOut`/`aborted`/`signal` 时接受终态，`:580` 对未知 `kind` 抛错；A1-BIND 路径 A 要求结构化 value（`hephi/src/control/evidence-verifier.ts:136` 缺结构化 value 即 `carries no structured native value`）。
- **B2 的现实缺口（用户口径）**：即使有了 B1，ready 门禁仍缺少"本次 Ticket↔Session↔执行结果↔最终提交 SHA"的**机器可核验绑定**；现状下 hephi 只能分别核验（合同/Ticket、Session 归属、检查记录、PR/commit），且当权威输出不可得时按 fail-closed 拒绝（`hephi/src/control/evidence-verifier.ts:533-534`，规则映射 `:621`）。

### 1.3 T10 的现状（为什么必须先派宿主任务）

- T10 严格口径 **blocked**：生产配置（binding off）下攻击①"手写自洽检查记录"被放行 `ready.pass`（一票否决，`eval/evidence/t10-host-verification/report.md:129-139`）；收紧为强绑定后 4/4 拒绝，但**同一配置下合法前台交付被 A1-OUT 拒绝** `ready.output-unverified`（`eval/evidence/t10-host-verification/report.md:98-111`）→ 攻击侧与合法侧在当前宿主上不可同时成立。
- 因此需要（a）**能力 A**（隔离验证通过后才可能开启强绑定），且（b）**能力 B**（恢复合法前台权威输出 + 提供四元绑定）才能让 T10 两侧同时通过（`eval/evidence/t10-host-verification/report.md:181-184`；`eval/evidence/a2a3-binding-decision/material.md:21-24` 的 P-1/P-2/P-3）。

## 2. 能力 A：Worker 无权改写宿主保存的交付证据

### 2.1 覆盖对象与拒绝形态

| 对象 | 范围 | 要求 |
| --- | --- | --- |
| A-1 Session 持久化快照 | `<dsh-home>/sessions/**/session.v*.jsonl.zstd`（含末尾追加与整文件重写） | Worker 会话进程（bash 及其子进程、工具执行进程）**无写权限** |
| A-2 hephi 状态目录 | `<stateDir>/hephi/<ticket>/**`（`run.json`/`output.log`/`decisions.jsonl`/`resolutions.jsonl`/`plan.jsonl`/`activation.json` 等，布局见 `hephi/src/control/check-store.ts:105` 的 `saveRun`） | 同上 |
| A-3 宿主写通道 | 宿主进程对 A-1/A-2 的正常写入 | **必须保留**：快照边写边持久化、检查记录落盘、决策日志追加（`hephi/src/control/decision-log.ts:58` 的 `appendDecision`） |

**拒绝必须是 OS 级**：`Permission denied` / `Read-only file system` / `Operation not permitted` 等内核拒绝；**不接受** PATH 限制、工具白名单、沙箱策略开关、应用层只读检查作为等价物（同 UID 下这些不是隔离，`hephi/docs/threat-model.md:20`）。

可接受实现方向（宿主决定，任选其一即可，只要验收满足）：独立 UID（宿主进程与 Worker 子进程不同 UID，载体属主为宿主 UID）、只读挂载（Worker 进程命名空间内 A-1/A-2 为 `ro`）、宿主外置状态目录（载体落宿主外部、Worker 仅只读视图）。三者的共同约束：**只读只针对 Worker 进程，不得破坏宿主自身落盘**（`hephi/docs/validation/2026-11-11-dsh-host-requirements.md:82-108` 的 R2 契约）。

### 2.2 验收（必须用实际 Worker 身份；正反向对照）

**前置**：只在**一次性可销毁 profile** 执行，生产实例禁止写入尝试（`hephi/docs/validation/2026-11-07-a2-final.md:59`）。所有 A-1/A-2 写入命令必须由 **Worker 自己的 bash 工具**执行（有自己的 `toolCallId`/Session 归属），**不得由操作者 shell 代跑**；操作者只做只读核对与签署。

#### 负向（必须从"成功"变为"拒绝"）

```bash
# 由 Worker 的 bash 工具执行（不是操作者终端）
id -u; id -un; id
D="${DSH_HOME:-$HOME/.dsh}"
F=$(find "$D/sessions" -name 'session.v*.jsonl.zstd' | head -1)
BEFORE=$(shasum -a 256 "$F" | awk '{print $1}')
printf x >> "$F"; echo "append_exit=$?"
AFTER=$(shasum -a 256 "$F" | awk '{print $1}')
[ "$BEFORE" = "$AFTER" ] && echo "snapshot_unchanged=yes" || echo "snapshot_unchanged=no"
R=$(find "$D/state/hephi" -name run.json 2>/dev/null | head -1)
printf x >> "$R"; echo "state_write_exit=$?"
printf ok > "$PWD/worker-write-control.txt"; echo "workspace_write_exit=$?"
```

| 观测项 | 通过条件 | 不通过条件 |
| --- | --- | --- |
| `append_exit` / `state_write_exit` | **非 0** | 0（现状即此，`hephi/docs/validation/2026-11-07-a2-final.md:59`） |
| A-1 快照 SHA256（追加前后） | **相等**（证明写入确实未发生） | 变化 |
| 命令 stderr | 含 OS 级拒绝依据（`Permission denied`/`Read-only file system`/`Operation not permitted`） | 无拒绝依据 |
| `workspace_write_exit`（对照） | **0**（证明 Worker shell 本身可用，不是工具白名单/沙箱开关把整条路径封死） | 非 0（则不能证明是 OS 级路径隔离） |
| 身份来源证据 | Worker 侧 `id` 输出 + 宿主侧进程身份（`ps -o user= -p <host pid>`）一并归档；须能说明"载体为宿主 UID/只读挂载，Worker 为不同身份或只读视图" | 只有单一侧身份、或同一身份且无只读挂载证据 |

#### 正向对照（宿主写通道必须保留，三项都要）

| # | 正向项 | 观测方式 | 通过条件 |
| --- | --- | --- | --- |
| P-1 | 新检查记录生成 | 同一 Worker Session 内跑一次真实 `hephi_check`，核对 `<stateDir>/hephi/<ticket>/checks/<runId>/run.json` 新增 | 文件生成且 `status`/`exitCode` 正确（写入路径见 `hephi/src/control/check-store.ts:105`） |
| P-2 | `decisions.jsonl` 追加 | 同一次 ready/check 后核对决策日志新增一行（`hephi/src/control/decision-log.ts:58`） | 新增行内容正确、`seq` 递增 |
| P-3 | Session 快照正常增长 | 负向尝试后触发一次真实工具调用，比较快照字节数/SHA256 | 快照**增长**（变化必须发生在负向尝试之后，且负向尝试前后哈希相等） |

**判定规则（不得只凭退出码判 pass）**：能力 A 记为 pass 需同时满足：负向全部拒绝 + 哈希不变 + OS 拒绝原文 + Worker 身份来源证据 + 正向三项（P-1/P-2/P-3）通过；由操作者按 H6 判据（人工，一次性实例，`hephi/docs/validation/2026-11-07-evidence-chain-host.md:156`）签署结论。缺任一项 → `blocked`/`manual`，不得写 pass。

#### 证据形态（宿主侧交付物）

1. Worker 侧 `run.jsonl` 原始工具轨迹（含上述命令、`toolCallId`、exit 输出、stderr 原文）；
2. 追加前后 SHA256 + `stat` 输出（A-1 快照；A-2 记录文件）；
3. Worker/宿主身份证据（Worker `id`；宿主进程 `ps`）；
4. 正向对照 P-1/P-2/P-3 的文件路径、`ls`/内容摘要、时间戳；
5. 操作者签署的人工结论（H6：pass/fail/manual）+ 执行窗口与部署 commit（实载回读方式见 `hephi/docs/host-compatibility.md:23-26`）。

## 3. 能力 B：结构化记录，四元绑定 Ticket ↔ Session ↔ 执行结果 ↔ 最终提交 SHA

### 3.1 B1：持久化 `tool/result.message.value` 结构化结果契约

（沿用 `hephi/docs/validation/2026-11-11-dsh-host-requirements.md:39-49` 的字段表，此处只列摘要；**B1 的验收也在那份契约内**。）

| 字段 | 类型 | 适用 `kind` | 约束 |
| --- | --- | --- | --- |
| `kind` | string | 全部 | 仅 `foreground` \| `background` \| `promoted` |
| `exitCode` | integer | `foreground` | 进程退出码；缺失/非整数 → hephi 拒绝该记录为终态（`hephi/src/control/check-runner.ts:474-475`） |
| `jobId` | string | `promoted`、`background` | 非空，可用于 `jobs.get(jobId, sessionId)` |
| （无最终退出码） | — | `promoted`、`background` | 不得携带最终 `exitCode`（判据 `hephi/docs/validation/2026-11-07-evidence-chain-host.md:152`） |
| 持久化可见性 | — | 全部 | 必须能从 Session 持久化快照直接读到（不是仅运行时内存） |

### 3.2 B2：四元绑定记录（本任务单新增的核心需求）

**需求**：宿主提供一个**文档化的、机器可读的**交付绑定记录——**单个记录或一组通过稳定 linkage key 可确定性关联的记录均可**——使下列四元形成可核验的一一对应，供 ready 门禁与复核者使用，**不依赖 `[exit code: N]` 等文本解析、不依赖自由格式日志**。

#### 3.2.1 四元必需字段表（字段名/容器可协商；语义与必填性不可省）

| 元 | 必需字段（最小集） | 类型/取值 | 权威来源 | hephi ready 消费锚点（现状 / 随访） |
| --- | --- | --- | --- | --- |
| ① Ticket | `ticket.id` | string | 激活合同 / Issue 绑定（`hephi/src/control/activation.ts:790` 的 `loadActivation`） | 现状：ready 以合同为事实源；随访：新增"记录 `ticket.id` 必须等于合同 `ticketId`" |
| ② Session | `session.id` | string，等于 Session 头 `id` | Session 头（`sessionQuery.readSession`） | 现状已核：检查记录 `sessionId` 必须等于当前 Worker Session（`hephi/src/control/evidence-verifier.ts:509`），binding 分支用同一 sessionId（`:512`）；随访：核验记录 `session.id` |
| ③ 执行结果 | `execution.kind`；`execution.exitCode`（`foreground` 必填整数）；`execution.jobId`（`background`/`promoted` 必填非空字符串）；`execution.toolCallId`（关联会话事件，必填） | enum + int + string | 持久化结构化 `tool/result`（B1）或 Job 终态（H3） | 现状消费结构化 value：`hephi/src/control/check-runner.ts:474-475`（`kind='foreground'` + 整数 `exitCode`）、`:580`（未知 `kind` 拒绝）；A1-BIND 缺结构化 value 拒绝（`hephi/src/control/evidence-verifier.ts:136`）、权威输出不可得拒绝（`:533-534`）；随访：核验记录的 `execution` 与 `run.json` 一致 |
| ④ 最终提交 SHA | `finalCommit.sha`（40 hex）；`finalCommit.baseSha`（40 hex） | hex 字符串 | 交付分支/PR HEAD 与合同 `baseSha` | 现状 PR/base/HEAD 校验（`hephi/src/control/evidence-verifier.ts:562`）与 ready 指纹；随访：核验记录 `finalCommit.sha` 等于被验证候选 HEAD |
| 记录元信息 | `version`（升版用）、`producedAt`（ISO8601）、`producer`（宿主构建标识） | int / string | 宿主 | 升级回归依赖 `version`（`hephi/docs/host-compatibility.md:23-26`） |

**"一条或一组"的可关联性**：若宿主拆成多条记录，必须带稳定 linkage key（建议 `ticket.id` + `session.id` + `execution.toolCallId`），可确定性关联；**不得**依赖文件顺序、时间戳邻近或自由文本匹配来配对。

#### 3.2.2 ready 门禁如何用四元做核验（B2 落地后的消费流程；hephi 侧随访实现）

| 步 | 核验内容 | 期望 | 现状代码锚点 | 归属 |
| --- | --- | --- | --- | --- |
| 1 | 由 Ticket 找到绑定记录；`version` 合法、字段齐全 | 记录可达 | —（随访新增读取器） | hephi 随访 |
| 2 | `ticket.id` == 合同 `ticketId` | 相等 | `hephi/src/control/activation.ts:790` | 随访 |
| 3 | `session.id` == 当前 Worker Session 头 `id` | 相等 | `hephi/src/control/evidence-verifier.ts:509`（归属拒绝）/`:512`（binding 分支） | 现状已有同类校验 |
| 4 | `execution.toolCallId` 在该 Session 持久化事件中可定位；`kind`/`exitCode`/`jobId` 与 `run.json` 一致 | 全部一致 | `hephi/src/control/check-runner.ts:474-475`/`:580`；`hephi/src/control/evidence-verifier.ts:136`/`:529-530` | 现状已有结构化校验，随访接入记录 |
| 5 | `finalCommit.sha` == 被验证候选 HEAD；`finalCommit.baseSha` == 合同 `baseSha` | 相等 | `hephi/src/control/evidence-verifier.ts:562`（PR/base/HEAD mismatch） | 现状已有 PR 校验，随访接入记录 |
| 6 | 任一不一致 → ready 拒绝；单独规则编号（建议 `ready.binding-record`，随访登记 `hephi/docs/decisions-format.md`） | deny | `readyRule` 现状映射 `hephi/src/control/evidence-verifier.ts:616`/`:621` | hephi 随访 |

> **现状 vs 目标（如实区分）**：第 3/4/5 步的**分项核验能力部分已存在**（分别按 Session 归属、结构化 value、PR HEAD 各自核验）；缺的是"**同一条四元记录**把这些分项串起来"与记录读取器。因此 B2 = **宿主交付记录 + hephi 随访消费**；本文不声称 hephi 当前已能消费 B2。

#### 3.2.3 记录示例（**示意**，字段名可协商；不是宿主现有输出，禁止当作实测）

```json
{
  "version": 1,
  "producedAt": "<ISO8601>",
  "producer": "<host build id>",
  "ticket": { "id": "<ticketId>", "repository": "<owner/repo>", "issue": 21 },
  "session": { "id": "worker-<ticketId>", "origin": "worker", "agentPreset": "dsh-superagent-worker" },
  "execution": { "toolCallId": "<id>", "kind": "foreground", "exitCode": 0, "terminalStatus": "completed", "finishedAt": "<ISO8601>" },
  "finalCommit": { "sha": "<40hex>", "baseSha": "<40hex>", "prNumber": 22 }
}
```


### 3.3 B 的验收（命令与证据形态）

**B1 验收命令**（hephi 现有探针，只读）：

```bash
cd /Users/zm/repos/hephi-review-main
node hephi/scripts/check-binding-host.mjs \
  --session <真实生产 Session 快照> \
  --check-record <对应 run.json> \
  --out /tmp/b1-acceptance.json
```

| 证据项 | 期望 |
| --- | --- |
| `rings[H2].status` | `pass` |
| `rings[H2].evidence.structuredValueCount` | 等于 `bashResultCount`（全部 bash result 都有结构化 value） |
| `samples[]` | `foreground` 有整数 `exitCodeField`；`promoted`/`background` 有 `jobId` 且无最终退出码 |

> **前置缺陷（hephi 侧待办，不阻塞宿主交付）**：探针 `h2Ring` 目前只采样**前 5 条**结果（`hephi/scripts/check-binding-host.mjs:594`），用样本数（`:610`）与结果**总条数**比较（`:620`）——因此真实快照含 >5 条 bash result 时（历史生产快照 16 条，`hephi/docs/validation/2026-11-07-a2-final.md:55`；T10 快照 264 事件，`eval/evidence/t10-host-verification/report.md:23`），即使全部结构化也判"编码不统一 → fail"。**R1/B1 正式验收前，hephi 侧必须先修采样**（全量统计或另立全量 ring）；这是 hephi 侧待办，不影响宿主按 §3.1 交付字段。

**B2 验收（宿主交付 + 操作者核对）**：宿主需提供：文档化的记录位置/查询方式、格式版本、生成时机（至少覆盖一次真实交付）、以及一条真实样例。操作者按下列四元逐项核对并归档：

| # | 核对项 | 权威来源 | 通过条件 |
| --- | --- | --- | --- |
| ① | `ticket.id` | 本合同/Ticket | 与激活合同一致 |
| ② | `session.id` | Session 头 `id` | 相等（hephi 现规则：记录 `sessionId` 必须等于当前 Worker Session，见 `hephi/src/control/evidence-verifier.ts:512` 分支与 ready 归属比对） |
| ③ | `execution` | 会话内结构化 `tool/result`（B1）或 Job 终态 | `toolCallId`/`jobId` 在对应 Session 持久化日志中可定位；`exitCode`/终态一致；`kind` 合法 |
| ④ | `finalCommit.sha` | PR/交付分支 HEAD | 等于被验证候选 HEAD，且 `baseSha` 与合同一致 |
| ⑤ | 不依赖文本 | — | 核对过程不需要解析 `[exit code: N]` 或自由格式日志 |
| ⑥ | 稳定性 | — | 记录格式有 `version`；宿主升级后仍可按文档读取（升级回归见 `hephi/docs/host-compatibility.md:23-26`） |

**判定**：B1 与 B2 分别由操作者/负责人按上表签署；**不得只凭命令退出码或单方自报判 pass**。B2 的 hephi 侧自动复核（消费四元记录并拒绝不一致）为随访任务（§6），在宿主格式冻结后实现；在此之前 B2 只按人工核对 + 原始记录归档判定。

## 4. 已知验收前置缺陷与边界（如实登记）

| 项 | 内容 | 归属 |
| --- | --- | --- |
| 探针采样缺陷 | `h2Ring` 只采样前 5 条（`hephi/scripts/check-binding-host.mjs:594/610/620`）→ >5 条结果恒 fail；B1 验收前须修 | **hephi 侧待办**，不影响宿主交付 |
| 行号变动说明 | 任务卡引用的 `hephi/src/control/check-runner.ts:468-469` 在 `6a51c3e`（H6 检测恢复）后移至 `hephi/src/control/check-runner.ts:474-475`；本文一律使用当前 `48cc76f` 实读行号 | hephi 侧文档 |
| 检测 ≠ 防护 | `hephi/src/control/snapshot-seal.ts` 只做 detect-only（`:5-23`；README 已知限制第 4 条 `hephi/README.md:95`；规则 `hephi/docs/decisions-format.md:44`）；**同 UID 可伪造合法帧/改写记录**，不能替代能力 A | 宿主具备能力 A 后才可能改变 H6 结论 |
| 宿主实现细节 | UID/挂载/外置目录的具体选择、字段命名、记录落盘或 API 形态、工作量与排期：**未知/待补**（由宿主负责人决定，本文不虚构） | 宿主 |
| 非本单范围 | 网络隔离；Worker 工作区可写；工具白名单 | — |

## 5. 不做的后果（引用既有定案）

| 不做 | 后果 | 依据 |
| --- | --- | --- |
| 不做能力 A | H6 持续 fail → 强绑定保持关闭；D1 上限锁 **L1**；"可复现证据绕过" veto 生效；伪造记录仍可在 binding off 下放行 `ready.pass` | `hephi/docs/validation/2026-11-07-a2-final.md:59`/`:163-167`；`ROADMAP-95.md:59`/`:109`；`eval/evidence/t10-host-verification/report.md:129-139` |
| 不做能力 B | 强绑定下合法前台交付被 `ready.output-unverified` 拒绝（部署约束）；T10 保持 blocked；两类合法路径 **0/2**；ready 仍需文本/多源拼接 | `eval/evidence/t10-host-verification/report.md:98-111`/`:171-187`；`eval/evidence/a2a3-binding-decision/material.md:60`；`ROADMAP-95.md:60` |
| 只做检测层（hephi 已有） | 只能检出"前缀被改/帧外追加"两类形态；同 UID 伪造合法帧不可区分；不改变 H6 根因 | `hephi/src/control/snapshot-seal.ts:5-23`；`hephi/docs/validation/2026-11-07-evidence-chain-host.md:156`；`hephi/docs/threat-model.md:49` |

## 6. 验收责任划分

| 环节 | 责任方 | 交付/动作 | 证据 |
| --- | --- | --- | --- |
| 能力 A 机制与证据 | **宿主** | 提供 OS 级隔离（或只读挂载/外置目录）+ 保留宿主写通道；在一次性 profile 内按 §2.2 交付 Worker 身份、负向拒绝、正向三对照 | §2.2 证据形态 1-5 |
| 能力 B1 | **宿主** | 持久化结构化 `message.value`（§3.1） | 真实快照 + 探针报告 `rings[H2]` |
| 能力 B2 | **宿主** | 文档化四元绑定记录（§3.2）+ 真实样例 | 记录文件/接口 + 样例 + 四元核对表 |
| 复验命令 | **hephi** | 修 `h2Ring` 采样后复跑 `check-binding-host.mjs`；B2 格式冻结后新增四元记录消费与拒绝逻辑（随访任务） | 命令、退出码、报告 JSON |
| 判定/签署 | **负责人/独立复核者** | 按 §2.2/§3.3 逐项签署；实现方自报不作为通过证据 | 签署结论 + 原始证据归档 |

## 7. 不承诺事项与未知项

- **不承诺排期**、不指定/不虚构宿主联系人；本文只定义可交办需求与验收口径。
- **未知/待补**：宿主侧实现方案与工作量；B2 的最终字段名/容器/API 形态；记录生成时机与保留期；跨宿主版本稳定性（需升级回归，`hephi/docs/host-compatibility.md:23-26`）；隔离后 hephi/宿主在异常恢复、部署脚本上的适配细节。
- 本文不是"宿主已具备能力"的证明：能力 A/B 现状分别为 **未满足/部分未满足**（§1）。

## 8. 引用核对清单与重放命令

本次核对命令（在 `/Users/zm/repos/hephi-review-main` 执行，2026-11-12；均为只读）：

```bash
git rev-parse HEAD                                                        # 任务开始时 48cc76f；提交时 5630f87
git merge-base --is-ancestor 6a51c3e HEAD                                 # 0（H6 检测恢复提交在主线）
git diff --name-only 48cc76f..HEAD                                       # 仅 eval/evidence/t10-rerun/deploy-record.md
git log -1 6a51c3e                                                        # H6 检测恢复提交存在
sed -n '55p;59p;163,167p;210p' hephi/docs/validation/2026-11-07-a2-final.md
sed -n '152p;156p' hephi/docs/validation/2026-11-07-evidence-chain-host.md
sed -n '23p;98,111p;129,139p;171,187p' eval/evidence/t10-host-verification/report.md
sed -n '21,24p;56,60p' eval/evidence/a2a3-binding-decision/material.md
sed -n '20,21p;49p' hephi/docs/threat-model.md
sed -n '5,7p;36p' hephi/src/control/snapshot-seal.ts
sed -n '474,475p;580p' hephi/src/control/check-runner.ts
sed -n '136p;512p;519p;533,534p;621p' hephi/src/control/evidence-verifier.ts
sed -n '105,113p' hephi/src/control/check-store.ts
sed -n '58p' hephi/src/control/decision-log.ts
sed -n '594p;610p;620p' hephi/scripts/check-binding-host.mjs
sed -n '55p;59,60p;109p;256p' ROADMAP-95.md
git show docs/hephi-plan-v5.4:docs/hephi-95-plan-v5.4-20261112.md | sed -n '576,594p;621p'
sed -n '23,26p;74,75p' hephi/docs/host-compatibility.md
sed -n '39,49p;56,74p;84,91p;98,108p' hephi/docs/validation/2026-11-11-dsh-host-requirements.md
sed -n '95p' hephi/README.md && sed -n '44p' hephi/docs/decisions-format.md
```

**引用核对结果（自动化全量审计，2026-11-12）**：对本文运行引用核对脚本——顺序扫描文本：①完整 `file:line` / `file:a-b` 引用；②同文件 `:line` 缩写按左侧最近的、已确认存在的文件路径解析；③独立文件路径作为后续缩写的解析上下文；对每处引用校验「文件存在且 `max(line) <= 该文件行数`」：

- 合计 **88 处引用 / 17 个文件**，0 处缺失、0 处行号越界、0 处无法解析（0 problem）。
- 覆盖文件：`ROADMAP-95.md`、`eval/evidence/t10-host-verification/report.md`、`eval/evidence/a2a3-binding-decision/material.md`、`hephi/README.md`、`hephi/docs/decisions-format.md`、`hephi/docs/host-compatibility.md`、`hephi/docs/threat-model.md`、`hephi/docs/validation/2026-11-07-a2-final.md`、`hephi/docs/validation/2026-11-07-evidence-chain-host.md`、`hephi/docs/validation/2026-11-11-dsh-host-requirements.md`、`hephi/scripts/check-binding-host.mjs`、`hephi/src/control/{activation,check-runner,check-store,decision-log,evidence-verifier,snapshot-seal}.ts`；v5.4 附录 A 经 `git show docs/hephi-plan-v5.4:docs/hephi-95-plan-v5.4-20261112.md` 实读（`sed -n '576,594p;621p'`，exit 0）。
- 说明：审计前已把文中裸文件名引用（如 `report.md`、`material.md`、`snapshot-seal.ts`）统一补全为仓库内唯一完整路径，避免同名歧义；`ROADMAP-95.md` 位于仓库根，直接校验。
- 本文未引用任何宿主现有联系人或排期（不存在可引用的真实来源），未声称宿主已具备任何能力。

## 9. 明确未做

- 未修改任何源码、测试、既有记录；只新增本文件。
- 未执行能力 A/B 的宿主验收（需一次性真实 profile/宿主实现），未连接任何宿主，未运行付费任务。
- 未向宿主仓库提交/转达（转达方式由负责人决定），未评估宿主工作量。

## 7. 原生队列状态（2026-11-12 回填）

| 项 | 值 |
| --- | --- |
| 提交渠道 | Super Agent 原生入口（GitHub Issue → 自动接单） |
| Issue | `paxxie2/g1-at81#4` — https://github.com/paxxie2/g1-at81/issues/4 |
| Ticket | `1d04c373fe1665d21538c0ceb7f12944` |
| Ticket 标题 | DSH 宿主能力 A/B 实施单：Worker 无权改写交付证据 + 结构化四元绑定（g1-at81） |
| 接单实例 | 3085（g1-exp，实载 DSH 0.2.1-rc.5 / SA cd384e7 / hephi ab5f527） |
| 负责人 | 未具名（该实例无宿主负责人字段；操作者为 `zm`）。**不得代填姓名**，由负责人受理时补录 |
| 状态 | `running`（assignment `6bd9c09aafc9`，2026-11-11T23:16:51Z 接单） |
| 合同 | 无 HEPHI 合同（g1-at81 不在 `prepare.sh` 匹配范围，符合 AT-81 既有结论） |

**提交前查重记录**：三个原生队列共 181 张 Ticket（g1-exp 23 / experiment 49 / desktop superagent 109）逐条检索，**无任何 DSH 宿主能力实施单**；GitHub 被监听仓亦无对应 Issue。因此本次为**首次提交，非重复建单**。

**交付边界（重要）**：DSH 宿主以 `app.asar` 打包分发，本地无 DSH 源码仓；上游 `deepseek-ai/deepseek-harness` 只读（无推送权限）；`paxxie2` 无 fork。因此该 Ticket 在本仓的可交付物限定为：
1. 对上游 DSH 的**参考补丁草案**（会话持久化与 `tool/result` 结构化编码的最小改动，`git format-patch` 形式）；
2. **验收 harness**（在 3085 上以实际 Worker 身份执行能力 A 正反向 + 能力 B 四元核验的脚本）。

能力本体仍须 DSH 团队实施；上游未交付前，本单状态应视为 `blocked-on-upstream`。
