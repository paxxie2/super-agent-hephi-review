# 一次性 DSH profile 运行期探针记录（jobs.get/readAt、H6、网络边界）

日期：2026-11-07（Asia/Shanghai）。对象：T2「宿主证据验证」中的运行期真实探针部分。
本文只记录**实际执行**的原始产物与结论；不把假宿主、夹具或自述文本当成真实证据。

## 1. 环境（与宿主同版本）

| 项 | 值 |
| --- | --- |
| DSH | `0.2.1-rc.5`，`/Users/zm/dsh-instances/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js`（与实验宿主 B `start.sh` 同一安装） |
| Node | `v26.1.0`（`/Users/zm/.nvm/versions/node/v26.1.0/bin/node`，与宿主进程一致） |
| 一次性 profile | `DSH_HOME=/tmp/hephi-host-probe/home`，profile `probe`（headless 模板 + 仅本机 `/tmp` patch） |
| 认证 | 由主助手放置的**仅两条** DeepSeek account 记录（`deepseek-account-platform/device`、`default`），`0600`；无其他服务密钥。运行后已删除该临时凭据文件；任何产物不含凭据。`20261107T2200Z-native-bash-lossy` 补充运行使用从宿主 credentials 文件**仅抽取同两条记录**的等价副本（不复制其他服务密钥，运行后立即删除） |
| provider/model | `deepseek-account` / `deepseek-flash`（与宿主 B 相同） |
| 业务源 | 无；工作目录 `/tmp/hephi-host-probe/workspace`，一次性可销毁 |
| 沙箱/权限 | `DSH_PERMISSION_MODE=danger-full-access`（与当前 Worker 的文件策略一致；仅该一次性 profile） |

profile patch 额外加载：
`/Users/zm/dsh-instances/experiment/work/hephi-prereq-fixes-992a6cb25459/hephi/scripts/host-runtime-probe.mjs`
（真实 `ctx.jobs` 事件订阅 + 真实 pull ring；不伪造事件、不模拟注册表）。

## 2. 执行场景与原始产物

原始产物目录（仓库外，本机）：
`/Users/zm/dsh-instances/experiment/evidence/hephi-runtime-probe-20261107/runs/`

| 场景 | 目录 | 结果 | 原始产物（SHA256 见各目录 `SHA256SUMS`） |
| --- | --- | --- | --- |
| 认证失败（无凭据 profile） | `20261107T2142Z-auth-failure/` | exit 1；`ACCOUNT_SIGN_IN_REQUIRED`（无凭据时不静默通过） | `run.jsonl` `run.err` |
| 短输出 + 长输出 + 网络 + H6 | `20261107T213750Z-full/` | 4 个真实 bash Job；见 §3/§4/§5 | `report.json` `run.jsonl` `run.err` `sessions/`（含被 H6 追加的原始 fast-forward 快照与 `SESSIONS-SHA256SUMS`） |
| 生产 Session 只读探针（H1/H4） | `20261107T2145Z-probe-prod-session/` | H1 pass（path-B）、H2 fail、H3 manual、H4 pass、H5 manual、H6 manual；exit 1 | `probe.json` `probe.err` |
| 一次性 Session + 运行时证据（首次 schema 失败） | `20261107T2146Z-probe-disposable-session/` | H3/H5 保持 manual：`own.readAt.chunks` 非数组（证明探针会拒绝不完整证据） | `probe.json` `session.v4.jsonl.zstd` |
| 一次性 Session + 运行时证据（修正后） | `20261107T2148Z-probe-disposable-session-v2/` | H3 pass、H5 pass；H1/H4 unavailable（无 check record）；H2 fail；exit 1 | `probe.json` `session.v4.jsonl.zstd` |
| 一次性 Session + 运行时证据 + H6 人工结论 | `20261107T2150Z-probe-disposable-final/` | H3 pass、H5 pass、H6 fail（附 §5 原始证据）；H2 fail；exit 1 | `probe.json` `probe.err` |
| 真实子进程 + Job 注册表组件集成（lossy） | `20261107T2200Z-native-bash-lossy/` | 4 个真实 agent bash Job + 诊断插件注册的真实 `/bin/sh` 子进程 Job：消费后 `readAt(0)` **16384 bytes、`lossy=true`**；**组件集成测试，不是原生 agent bash 工具 E2E**；见 §3 | `report.json` `run.jsonl` `run.err` `sessions/` `SESSIONS-SHA256SUMS` |

`job-evidence-derived[-v2].json` 是从 `20261107T213750Z-full/report.json` 按固定映射派生的
只读证据（保留派生来源与 report 的 SHA256），不是事后重建的执行记录；原始 `report.json`/`run.jsonl`
是该场景的唯一执行记录。

**执行顺序声明**：本记录开始前的三次尝试（认证缺失、hello 冒烟、首轮 4 Job）在收到
「每场景唯一目录」要求前已被后续运行覆盖，**不补造、不重建 JSON**；从 `20261107T213750Z` 起
每次运行使用唯一目录并原样归档。被覆盖的运行只保留在 Worker 工具轨迹中，不作为本文证据。

## 3. jobs.get/readAt 实测

真实原生 bash Job（`20261107T213750Z-full`，由真实 agent 的 bash 工具创建，事件由主机写入）：

| 场景 | Job | 结果 |
| --- | --- | --- |
| 本 Session 终态 | `bash-…498f`（`yes x | head -c 40000`） | `ctx.jobs.get(jobId, owner)` → `status=completed`、`detail=exit code: 0` |
| 完整输出 | `bash-…4a4b`（`echo probe-small-complete`） | `readAt(0, owner)` → 21 bytes、`lossy=false`、正文 `probe-small-complete\n` |
| 长输出 | `bash-…498f`（40000 bytes） | `readAt(0, owner)`（模型消费前）→ 40000 bytes、`lossy=false` |
| 错误 Session 拒绝 | 上述每个 Job | `get/readAt(jobId, session-hephi-runtime-probe-foreign)` 全部抛错：`job … belongs to another session` |
| 消费后移除 | 前台 Job | 延迟再读抛错（前台工具收集后会移除记录）；如实记录，不当作 lossy |

真实子进程 + Job 注册表组件集成（lossy，`20261107T2200Z-native-bash-lossy`）：探针启动真实
`/bin/sh -c "yes x | head -c 40000"` 子进程作为 Job 的 pull 源（输出由子进程真实产生，经真实
`ctx.jobs` 注册；不预写 ring、不伪造事件）。**这是组件集成测试：Job 由诊断插件注册，不是原生
agent bash 工具的端到端链路**；原生 agent 前台 Job 收集后即被移除的限制见上表。原始记录 `nativeBashLossy`：

```json
{"producer":"/bin/sh -c \"yes x | head -c 40000\"","producedBytes":40000,
 "beforeTrim":{"bytes":40000,"lossy":false,"next":40000},
 "modelRead":{"bytes":40000,"lossy":false},
 "afterTrim":{"bytes":16384,"lossy":true}}
```

即：消费前 40000 bytes 完整可读（`lossy=false`），消费读后 ring 按宿主默认 settled cap
（16 KiB）裁剪，再从 0 读得到 **16384 bytes、`lossy=true`**。这是真实子进程输出的 lossy 语义
（组件集成测试），**不是原生 agent bash 工具 E2E**；agent 前台 Job 在工具收集后即被移除，无法在
同一条记录上观察 lossy。

## 4. 网络边界（2026-11-07T213750Z，一次性 profile）

- 受控探针：Worker bash 执行 `curl -sS -m 5 -o /dev/null -w 'HTTP:%{http_code}' https://example.com`
  → 原始输出 `HTTP:200`（外网可达）。
- 配置核对：该 profile 的 `sandbox-policy` 为 `danger-full-access`，沙箱实现只含文件写入限制
  （无网络策略项）；**没有网络隔离边界**。PATH 限制不能称为网络隔离。
- 本项只记录现状；**未修改任何网络策略、工具权限或宿主配置**。

## 5. H6：Worker 可写性 / 快照影响（仅一次性 profile）

同一一次性 profile 内，Worker bash 实际执行（原始输出见 full run 的 Job 正文）：

```text
snapshot=/tmp/hephi-host-probe/home/sessions/.../session.v4.jsonl.zstd
append_exit=0
state_write_exit=0
```

即：Worker **能**向 `$DSH_HOME/sessions/**/session.vN.jsonl.zstd` 追加字节，且**能**在
`$DSH_HOME/state/hephi/.../run.json` 写入伪造检查记录。

- 结论：**H6 fail**（Worker 可影响快照/伪造记录）。按已批准方案**保持强绑定关闭**（默认本已关闭），
  不新增隔离架构、不改生产配置；生产 B 上**未执行**该尝试。
- 边界：该结论来自一次性 profile 的 `danger-full-access` 实际行为，不是对生产 B 的写入尝试；
  原始被追加的快照与哈希保留在 full run 的 `sessions/` 归档中。

## 6. review→Trigger（待执行，不由本 Worker 执行）

第二评审账号 `monsterhunterw2` 的凭据只由主助手持有。截至本文最后更新，**修复 PR 尚未生成**；
主助手只在 Issue #29 评论中说明将由其在修复 PR 上执行 review→Trigger。**该验收尚未执行**，
不能把 Issue 评论的 fanout 当作 review 验收结果。本 Worker 未尝试第二个账号认证、未伪造审批。

## 7. 未证明 / 限制

- 未证明 A1-BIND 端到端通过；强绑定保持关闭。
- 生产宿主 Session 的 Job 输出当前无法回读（前台 Job 收集后移除；生产 Session 未做写入尝试）。
- H2 仍 fail：真实宿主持久化 `tool/result` 不含结构化 `message.value`；本任务未改 H2 判据。
- lossy 由“真实子进程 + Job 注册表组件集成”观察到，**不是原生 agent bash 工具 E2E**；agent 前台
  Job 收集后即移除，无法在同一条记录上观察 lossy。不把它冒充为生产 check Job 的输出，也不把更早的
  unowned+预写 ring 探针当作验收。
- 一次性 profile 的 Session 快照与主助手复制的认证记录无关；凭据文件已删除，证据不含凭据。

## 8. 原始产物清单（SHA256）

`/Users/zm/dsh-instances/experiment/evidence/hephi-runtime-probe-20261107/runs/20261107T213750Z-full/SHA256SUMS`：

```text
3cbadd640dfa467b2890877bcfa80f9abdb77f3bdb6fd6035817c574a2467d39  report.json
aef6c9227434b794aaffef0482efadef5e1cc1a94cbac92465a568a1195d6459  run.jsonl
247c3a2936fe2c6f1464b1c5187c37ecaa104e08978fa98933e4adea659a8517  run.err
3da2f2b7bc9ebed86324d56ac550f4049b4d7c55886d6d5f30d0bf3d0ed6aef5  job-evidence-derived.json
f27c113f4612aafc012b94dc4a90f0d0cf810bb141d89ce1f0034b2d3652e576  job-evidence-derived-v2.json
```

`.../runs/20261107T2200Z-native-bash-lossy/SHA256SUMS`：

```text
f855aa7b6eeca6816f1828871eeacba13f3aa2e5205ef7a90e0793ac18a577f5  report.json
4958fc8620b0df0366da0d8adf878ee82c85da9006c113e2e36a0672829c9e61  run.jsonl
247c3a2936fe2c6f1464b1c5187c37ecaa104e08978fa98933e4adea659a8517  run.err
```

其余目录的 `SHA256SUMS` 见对应目录；Session 快照的逐文件哈希见各 run 的
`SESSIONS-SHA256SUMS`。原始执行记录（含本 Worker 的工具轨迹与上述文件）保留在本机，
本文不复制凭据或会话私有内容到仓库。

## 9. 更正记录（保留）

- 2026-11-07 21:41 独立验收指出：本文件 §6 曾写“主助手已在修复 PR 上执行 review→Trigger”，
  **不属实**（PR 尚未生成，只有 Issue 评论）；已改为“待执行”，review 验收仍待主助手在 PR 上完成。
- 同一时点指出：早前 `retentionProbe` 直接注册 unowned Job 并预写 ring 数据，只能算真实组件聚焦
  测试，**不能**充当原生 bash 的 lossy 验收。该实现已移除，改为真实 `/bin/sh` 子进程作为 Job 的
  pull 源（`20261107T2200Z-native-bash-lossy`）；原始旧运行已归档，但不再作为 lossy 验收依据。
- 2026-11-07 21:46 进一步纠正：`nativeBashLossy` 虽输出真实，但 Job 由诊断插件自行 register，
  仍不是原生 agent bash 工具链；已明确标为“真实子进程 + Job 注册表组件集成测试”，不称为原生
  bash 工具 E2E。
