# A2 证据链宿主探针：path A / path B 识别与 `--job-evidence`（2026-11-07）

本文说明只读探针 `hephi/scripts/check-binding-host.mjs` 如何识别真实宿主的两种 Session 编码、
H1 的判定边界，以及 `--job-evidence` 运行时证据的作用与限制。**本文不构成 A1-BIND 端到端验收**。

## 1. 两种宿主编码

同一条 `hephi_check` 内部 bash 调用，在不同宿主/版本上会以两种形态之一落入 Session 快照
（`session.vN.jsonl.zstd`，一帧一事件）：

| 编码 | Session 事件 | 探针判据 |
| --- | --- | --- |
| **path A** | 内部 bash 的 `tool/call`（`callId=record.innerCallId`、`name=bash`、`arguments` 为原始 JSON 字符串）+ 对应 `tool/result` | 既有判据不变：call 存在、name=bash、`arguments.command` 与 `record.argv + record.before.baseCommit` 重建的命令逐字符相等、`arguments.workdir` 与 `record.cwd` 相等 → H1 pass |
| **path B** | 根调用 `tool/call`（`callId=record.callId`、`name=hephi_check`）+ 内部 dispatch 的 `job/registered` 与 `job/settled`；**没有**内部 `tool/call`/`tool/result` | 见 §2，全部条件成立 → H1 pass；否则 fail |

识别顺序：**path A 优先**。只要内部 `tool/call` 存在，探针只按 path A 判据判定，不会因为
path B 事件看起来更完整而改判；path A 存在但字段不匹配时也是 fail，不回落 path B。

真实宿主历史快照（本机只读核对，id 已脱敏）就是 path B：

- Session 头 id：`worker…04b4`（等于 `run.json` 的 `sessionId`）；
- 根调用：`call_0…7022`，`name=hephi_check`；
- 内部 callId `hephi-…ccc8`：**没有** `tool/call`/`tool/result`；
- 但存在 `job/registered` 与 `job/settled`：
  `jobId=bash-a…457f`、`owner=worker…04b4`、
  `toolCall={callId:'hephi-…ccc8', rootCallId:'call_0…7022'}`、
  `status=completed`、`detail='exit code: 0'`；
- `label` 与 `record.argv + record.before.baseCommit` 重建的命令逐字符相等：
  `HEPHI_BASE_COMMIT='8d2e…c598' 'sh' '-c' 'npm --prefix web install --no-audit --no-fund && bash scripts/check.sh'`。

## 2. H1 path B pass 条件（缺一即 fail）

只采信 **宿主写入的 Session 事件 + `run.json` 的标识符**，不采信 `record.status`/`outputHash`，
也不采信任何文本自述：

1. **当前 Session**：快照头 id 等于 `record.sessionId`；
2. **根调用**：存在 `callId=record.callId` 且 `name=hephi_check` 的 `tool/call`；
3. **内部与根关联**：`job/registered` 的 `toolCall.callId=record.innerCallId`、
   `toolCall.rootCallId=record.callId`；`record.jobId` 存在时必须等于事件 `jobId`；
   同一 `jobId` 有匹配的 `job/settled`；
4. **命令**：`job` 的 `label` 与重建命令**逐字符相等**。截断/前缀不算 pass（真实宿主写完整命令）；
   截断会作为证据 `missing`/`notes` 明确报告并 fail；
5. **终态与退出码**：`job/settled.status ∈ {completed, killed, failed}`；
   `detail` 可解析为 `exit code: <n>`；`record.exitCode` 是数字时必须相等。

H1 证据新增字段：`encoding`（`path-A`/`path-B`/`null`）、`jobId`、`ownerMatchesSession`、
`rootCallFound`、`innerCallFound`（是否发现 path A 的内部 `tool/call`）、`jobRegisteredFound`、
`jobSettledFound`、`labelMatchesCommand`、`exitCode`、`status`、`notes`、`missing`。
`innerCallFound=false` + `encoding=path-B` 是真实宿主的正常形态，不是失败。

同一真实快照的实际探针结果（只读、无 `--out`，id 已脱敏）：

| 环节 | 状态 | 说明 |
| --- | --- | --- |
| H1 | pass | path-B；根调用、owner、命令、终态与 exit code 全部匹配 |
| H2 | fail | 持久化 `tool/result` 没有结构化 `message.value`（真实宿主编码）；本任务不改 H2 判据 |
| H3 | manual | 需要宿主运行时证据（`--job-evidence`）或人工探测 |
| H4 | pass | `record.sessionId == session.header.id` |
| H5 | manual | 前台快照可核对；Job 输出需 `readAt` 证据 |
| H6 | manual | 需一次性实例上的人工自影响探测 |

## 3. `--job-evidence`：可销毁 profile 的运行时证据

path B 快照**不持久化 Job stdout**，探针不会假装能读到输出。需要 Job 注册表行为时，由**独立的
宿主运行时探针**在一次性/可销毁真实 DSH profile 内调用 `ctx.jobs.get/readAt`，生成 JSON 后用
`--job-evidence <file>` 只读传入：

```json
{
  "generatedBy": "host-runtime-probe",
  "host": "http://127.0.0.1:3083",
  "profile": "disposable-profile-<id>",
  "sessionId": "worker…04b4",
  "jobId": "bash-a…457f",
  "own": {
    "status": "completed",
    "detail": "exit code: 0",
    "readAt": { "text": "<job output>", "lossy": false, "truncated": false, "chunks": [{ "at": 0, "text": "<job output>" }] }
  },
  "foreign": { "threw": true, "error": "Job belongs to another Session" }
}
```

必需 provenance：`generatedBy`（字符串）、`host`/`profile`（非空字符串）、`sessionId`、`jobId`、
`own`（`status`/`detail`/`readAt.{text,lossy,truncated?,chunks?}`）、`foreign`
（`{threw:true,error}` 或 `{undefined:true}`）。

- **H3 pass** 仅当：`sessionId` 与当前 Session/记录一致、`jobId` 与记录一致、`own` 为终态、
  `detail` 为退出码形式且与 `record.exitCode` 一致、`readAt.text` 存在（字符串），
  并且 `foreign` 调用被拒绝（抛错或 `undefined`）。
- `foreign` 被接受（既非抛错也非 `undefined`）→ **H3 fail**；字段不全/`readAt.text` 缺失 → **manual**。
- **H5** 复用同一文件的 `own.readAt`：`lossy=true` 或 `truncated=true` → fail；
  `lossy=false` 且未标记截断、快照前台无 truncation 标记 → pass；没有该文件 → 保持 manual。
- 报告 `inputs.jobEvidence` 只显示脱敏路径与 provenance，不打印 Job 输出正文。

**限制**：该文件是运行时可观察行为，不是 A1-BIND 端到端证明；它不能证明 ready 路径真的调用了
`jobs.get/readAt`，也不能替代 H6（Worker 自影响）或真实 Worker 运行。使用后 H1–H6 的最终结论仍
需填入 `hephi/docs/validation/2026-11-07-evidence-chain-host.md`。

## 4. 自测与测试

```bash
node hephi/scripts/check-binding-host.mjs --self-test
cd hephi && npx --no-install vitest run tests/probes/check-binding-host.test.ts
```

`--self-test` 与 `hephi/tests/probes/check-binding-host.test.ts` 使用合成 Session 覆盖：
path A pass、path B pass、owner 不匹配、label 不匹配/截断、exit code 不匹配、
path A/B 均缺失，以及 job-evidence 的 H3 pass/manual/fail 与 H5 pass/fail。
这些是**夹具测试**，不是真实宿主证据。

## 5. 真实运行结果（2026-11-07，原始产物在仓库外）

以下结果来自实际执行，原始 `report.json`/`run.jsonl`/`probe.json` 与 SHA256 见
[`host-runtime-probe-record.md`](host-runtime-probe-record.md)；不把 `generatedBy` 字段当作来源证明。

| 运行 | 输入 | 结果 |
| --- | --- | --- |
| 生产 Session 只读探针 | 真实 Issue 44 的 Session 快照 + `run.json` | H1 pass（`path-B`）、H2 fail、H3 manual、H4 pass、H5 manual、H6 manual；exit 1 |
| 一次性 profile + 运行时证据 | 一次性 DSH 0.2.1-rc.5 profile 的真实 Session 快照 + `job-evidence-derived-v2.json` | H3 pass（本 Session 终态 + foreign 抛错 + readAt 文本）、H5 pass（无 truncation、lossy=false）、H2 fail、H1/H4 unavailable（无 check record）；exit 1 |
| 加 H6 人工结论 | 同上 + `--manual H6=fail`（附 §5 原始写入证据） | H6 fail；其余同上 |

一次性 profile 的运行期实测（真实 `ctx.jobs`；agent 原生 bash Job + 真实子进程组件集成，Node v26.1.0 / DSH 0.2.1-rc.5）：

- 本 Session 终态：`get(jobId, owner)` → `completed` / `exit code: 0`；
- 错误 Session：`get/readAt(jobId, foreignSession)` 抛错 `job … belongs to another session`；
- 完整输出：短命令 21 bytes、`lossy=false`；长命令消费前 40000 bytes 可读；
- 截断/lossy：**真实子进程 + Job 注册表组件集成测试**——诊断插件注册的真实 `/bin/sh` 子进程 Job
  （`yes x | head -c 40000`）消费后由 40000 收到 16384 bytes、`lossy=true`。这不是原生 agent bash
  工具的 E2E；agent 前台 Job 收集后即移除，无法在同一条记录上观察 lossy。早前 unowned+预写 ring
  的探针只算组件聚焦测试，已由独立验收纠正，不作为 lossy 验收依据；详见
  [`host-runtime-probe-record.md`](host-runtime-probe-record.md) §3/§9。
- H6：一次性 profile 内 Worker bash 对自身 `$DSH_HOME/sessions/**/session.v*.jsonl.zstd` 追加成功
  （`append_exit=0`），并可写入伪造 `state/hephi/.../run.json`（`state_write_exit=0`）→ **H6 fail**，
  因此**强绑定继续保持关闭**；生产 B 未做写入尝试；
- 网络：受控 `curl https://example.com` 返回 `HTTP:200`；沙箱配置无网络策略项，
  **无网络隔离边界**（PATH 限制不是隔离）。未修改任何网络/权限配置。

## 6. 明确未做

- 没有伪造或写入任何 **生产** Session 快照/`run.json`；生产 Session 探针保持只读。
- 没有把 path B 的 `record.status`/`outputHash` 当作 H1 依据。
- 没有声称 A1-BIND 端到端通过；强绑定保持默认关闭。
- 未执行第二个真实账号的 review→Trigger（由主助手在修复 PR 上执行；本 Worker 未使用第二账号认证）。
- 早期三次一次性 profile 运行在“每场景唯一目录”要求之前已被覆盖；不补造、不重建 JSON，只按
  [`host-runtime-probe-record.md`](host-runtime-probe-record.md) 的声明如实记录。

