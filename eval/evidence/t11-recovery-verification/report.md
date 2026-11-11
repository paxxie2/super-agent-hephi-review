# T11 真实宿主四种故障状态恢复验证（3085 / ab5f527）

- 日期：2026-11-12（执行时间 2026-11-11T19:57Z–19:58Z UTC）
- 任务：task-21 / v5.4 T11（异常恢复真实宿主验证）
- 宿主：g1-exp 实例，端口 **3085**，pid **33924**，实载插件提交 `ab5f527a11655dd3e935a634d3b5c62f0a265f51`（host.log 两条 `[hephi-activation]`：index/tools，pid=33924）
- CLI（被测通道）：`/Users/zm/dsh-instances/g1-exp/hephi-review/hephi/lib/cli.mjs`
  - sha256 `f518b2f05e58a7ecff008ac56497b05fb50f1ad01c837832b099fabd3c7cafd6`（46604 bytes，2026-11-12 03:05）
- 操作者授权通道：`/Users/zm/dsh-instances/g1-exp/operator-config.json`（`-rw-------` = 0600，内容 `{"allowOperatorResolutions": true}`）
- 证据仓库：`/Users/zm/repos/hephi-review-main`，分支 `agent/task-contract-standard-20261111`
  - 任务卡写基线 HEAD=`93fee34`；执行时实际 HEAD=`cbe8437`（`93fee34` 是其祖先，期间有并行提交推进，未回退）
- 临时构造目录：`/tmp/t11-recovery-20261111T195718Z/`（**/tmp 副本，可丢弃**；本目录 `raw/` 为运行时的完整原始拷贝，`raw/tmp-root.env` 记录该路径）

> 结论先行：**四种故障状态在真实 3085 部署制品（ab5f527 的 `hephi resolve`）上全部按预期处置**。
> 但必须区分：**恢复判定由真实 CLI 对 /tmp 状态副本中的真实格式检查记录执行**；本任务按红线
> **没有触发付费 Worker/真实宿主 Job**，因此不是"活 Worker 崩溃"注入，也不是宿主 Job 注册表查询的端到端证
> 明。真实宿主侧的证据是进程/端口/激活提交回读与真实主机进程查询；失败构造按任务卡允许的 /tmp 临时副本方式完成。

## 1. 验收结论（对照任务卡四种故障）

| 状态 | 故障构造 | 首个失败（真实执行） | 恢复轨迹（真实执行） | 语义核对 | 结果 |
| --- | --- | --- | --- | --- | --- |
| ① 仍在运行 | 真实 `sleep 240` 进程 + 副本中 `status=running` 的 run 记录 | `resolve --status running` → **exit 1**，`host still reports the check as running; stop it, confirm a terminal state and then resolve`；未产生 resolutions 行 | 操作者停止该进程 → `ps -p <pid>` 确认不存在 → `resolve --status terminated --basis host-terminal` → **exit 0**，写入 1 条 host-terminal 记录 | run.json 字节前后一致（sha `8761ebf…`），status 仍 `running`、exitCode null、finishedAt null；resolution 只恢复重跑资格，不是通过证据 | PASS |
| ② 查询不可用 | 真实失败查询：`curl` 到关闭端口 127.0.0.1:65000 → exit 7 `Couldn't connect to server`；副本中 `status=unknown` 记录 | 无 `--accept-risk` → **exit 2**，`--basis operator-risk-accepted requires --status unavailable and --accept-risk`；`--basis host-terminal --status unavailable` → **exit 2**，要求 terminated | 加 `--accept-risk` → **exit 0**，写入 `basis=operator-risk-accepted`，hostQuery 记录查询失败原文 | run.json 前后一致（sha `d1070ea…`），status 仍 `unknown`；风险接受被明文标记 | PASS |
| ③ 已结束但结果丢失 | 副本中 `status=unknown`、`finishedAt` 已设、**无 output.log / 无 outputHash** 的 run；宿主查询确认无该调用进程 | 故障状态本身即"首个失败"（宿主确认结束后输出与退出码丢失，记录停在 unknown） | `resolve --status terminated --basis host-terminal` → **exit 0**，写入 host-terminal 记录 | run.json 前后一致（sha `73482a7…`）；run 目录仍只有 run.json（未生成 output.log）；`status=unknown`、`exitCode=null` → **不能作为通过证据** | PASS |
| ④ 遗留 running | 副本中 `startedAt` 为 2 小时前的 `status=running` 记录（模拟宿主崩溃遗留）；真实主机进程表扫描无该 innerCallId 进程 | 空 host-query → **exit 2** `the host query evidence must not be empty`；按 `--status running` → **exit 1**（要求先确认终态） | 真实主机查询（宿主 pid 存在 + 全进程表无匹配）→ `resolve --status terminated --basis host-terminal` → **exit 0**；重复执行 → `already recorded`（幂等，resolutions 字节不变） | run.json 前后一致（sha `ad0ab86…`），status 仍 `running`（原记录不被改写） | PASS |

补充负向证据（授权通道，非四种故障之一，但属恢复能力前提）——`raw/05-operator-gate/`：
无 `--operator-config` → exit 1（disabled）；group-readable（0644）配置 → exit 1（要求 0600）；仅
`HEPHI_ALLOW_OPERATOR_RESOLUTIONS=1` 环境变量 → exit 1（**环境不是启用通道**）。三条均未写入任何 resolution。

## 2. 方法与证据边界

- **真实宿主事实（只读）**：3085 进程 pid 33924 存活；HTTP 3085 返回 401（host 存活，需 token；未使用 token）；
  host.log 激活标记 commit=ab5f527（index+tools）；3086 冻结对照返回 000（未启动、未触碰）。
- **状态副本**：把 3085 真实 Ticket `46aa3f5947c125330ef14d8014a88477` 的 `activation.json`/`plan.jsonl`/`decisions.jsonl`
  复制到 `/tmp/t11-recovery-*/state/hephi/<ticket>/`（真实 `contractHash=sha256:596f93f3…`、真实 `pluginCommit=ab5f527…`、
  真实 session/argv/cwd/before 指纹作模板），按四种故障构造 4 条真实格式 run 记录；**真实状态目录只读，未写入**。
- **被测通道**：真实部署的 `lib/cli.mjs`（ab5f527 构建），以真实操作者配置（0600）运行；`--state-dir` 指向 /tmp 副本。
- **真实主机查询**：使用 `ps -p` 与 `ps -ax` 全进程表扫描（对记录的 innerCallId 唯一标记过滤），未使用宿主内部 Job API
  （需 token/会给宿主写入面增加风险；A3 规范允许"查宿主 Job 或进程"）。
- **红线遵守**：未产生付费 Worker 运行；未向 3085 发任何写请求；3086 未改动；真实 3085 Ticket 状态目录文件
  前后逐文件 sha256 一致（`raw/06-real-state-untouched/real-state-diff.txt` = `PASS: ... unchanged`），真实目录无
  `resolutions.jsonl`；只新增 `eval/evidence/t11-recovery-verification/`。
- **未验证**：不是活 Worker/宿主崩溃的注入（需要付费 Worker 与真实 Job）；未验证 runner 侧
  `unfinished/unsupported execution requires operator resolution` 的真实宿主触发；未验证解除后真实 Worker
  `hephi_check` 重跑与 ready 判定（均需要 Worker 运行）。因此本证据证明的是**真实部署制品的操作者恢复路径与
  状态目录语义**，不能单独声称 T11 端到端全部通过。

## 3. 关键命令与原始输出（完整原文见 raw/*/attempt*/command.txt）

> `$ROOT=/tmp/t11-recovery-20261111T195718Z`；公共参数：
> `--ticket 46aa3f5947c125330ef14d8014a88477 --operator t11-recovery-operator --state-dir $ROOT/state --operator-config /Users/zm/dsh-instances/g1-exp/operator-config.json`

### ① 仍在运行 → 拒绝解除，停止并确认终态后恢复
- 构造：start `sleep 240`，pid 63013（`raw/01-still-running/check-process.pid`）；host query 记录该 pid 与宿主 pid。
- 首个失败（`raw/01-still-running/attempt1-refused/`）：
  `node $CLI resolve … --basis host-terminal --status running --host-query-file …` → **exit 1**
  `host still reports the check as running; stop it, confirm a terminal state and then resolve`
  该步后无 `resolutions.jsonl`（`raw/01-still-running/resolutions-absent-after-refusal.txt`）。
- 恢复（`raw/01-still-running/attempt2-recovery/`）：停止该进程并 `ps -p 63013` 确认不存在（退出 1，无该进程）→
  `--basis host-terminal --status terminated` → **exit 0**
  `HEPHI resolution recorded: ticket=… run=1111… basis=host-terminal operator=t11-recovery-operator`
- 幂等重复（`raw/01-still-running/attempt3-idempotent-repeat/`）：**exit 0**，`already recorded (idempotent, no new record)`，
  resolutions 文件字节不变。
- 记录完整性：run.json sha256 前/后 `8761ebfa29f6…` 一致；`record-status-after-recovery.json`：
  `{"status":"running","exitCode":null,"finishedAt":null}`。

### ② 查询不可用 → 必须显式风险接受
- 真实失败查询（`raw/02-query-unavailable/`）：`curl -sS --max-time 3 http://127.0.0.1:65000/` → **exit 7**
  `curl: (7) Failed to connect to 127.0.0.1 port 65000 after 0 ms: Couldn't connect to server`；把命令/退出码/stderr 写入 host-query 文件。
- 失败 1（`attempt1-refused-no-risk-acceptance/`）：`--basis operator-risk-accepted --status unavailable`（无 `--accept-risk`）→ **exit 2**
  `--basis operator-risk-accepted requires --status unavailable and --accept-risk (host query was not available)`
- 失败 2（`attempt2-refused-wrong-basis/`）：`--basis host-terminal --status unavailable` → **exit 2**
  `--basis host-terminal requires --status terminated (a host query confirmed the end of the execution)`
- 恢复（`attempt3-recovery-risk-accepted/`）：加 `--accept-risk` → **exit 0**，resolution `basis=operator-risk-accepted`。
- run.json sha256 前/后 `d1070ea65e41…` 一致；status 仍 `unknown`。

### ③ 已结束但结果丢失 → 允许解除，但绝不作通过证据
- 构造：run 记录 `status=unknown`、`exitCode=null`、`finishedAt=2026-11-11T19:39:19.063Z`、`reason=host confirmed the execution ended, but its output and exit code are unavailable`；
  run 目录只有 `run.json`（无 output.log、无 outputHash）。
- 宿主查询（`raw/03-result-lost/host-query-confirmed-ended.txt`）：宿主 pid 33924 存活；`ps -ax` 全表扫描
  `hephi-t11-acceptance-33333333` → `no process matches … (scan of ps -ax output)`；run 目录列表确认无 output.log。
- 恢复（`attempt1-recovery/`）：`--basis host-terminal --status terminated` → **exit 0**，写入 host-terminal 记录。
- 语义核对：run.json sha256 前/后 `73482a754b09…` 一致；状态仍 `unknown`、`exitCode=null`、无 output.log ⇒
  **该执行不能成为通过证据**；解除只恢复重新运行检查的资格（CLI usage 原文亦声明"the resolved execution stays
  non-passing evidence, and its run.json/output.log are never edited"）。

### ④ 遗留 running → 先查宿主进程，再按已结束处理
- 构造：`status=running`、`startedAt=2026-11-11T17:57:19.063Z` 的遗留记录。
- 宿主查询（`raw/04-leftover-running/host-query-leftover.txt`）：宿主 pid 33924 存活；`ps -ax` 扫描
  `hephi-t11-acceptance-44444444` → `no process matches …`（宿主确认不存在该调用进程）。
- 失败 1（`attempt1-refused-no-host-query/`）：空 host-query → **exit 2** `the host query evidence must not be empty`。
- 失败 2（`attempt2-refused-status-running/`）：`--status running` → **exit 1**（要求先确认终态）。
- 恢复（`attempt3-recovery/`）：`--basis host-terminal --status terminated` → **exit 0**，写入 host-terminal 记录。
- 幂等重复（`attempt4-idempotent-repeat/`）：**exit 0** `already recorded`，resolutions 前后字节一致。
- run.json sha256 前/后 `ad0ab8692317…` 一致；status 仍 `running`（原记录只读保留）。

### 状态副本最终状态（`raw/06-real-state-untouched/temp-state-final.txt`）
`resolutions.jsonl` sha256 `c58228275015…`，共 **4 行**：①③④ 各 1 条 `host-terminal`，② 1 条 `operator-risk-accepted`；
均为 /tmp 副本写入；真实 3085 目录无 `resolutions.jsonl`（`raw/06-real-state-untouched/real-resolutions-absent.txt`）。

## 4. 授权依据

1. 任务卡 task-21：允许在 3085 真实宿主验证，红线为"不产生付费 Worker 运行、故障构造用 /tmp 临时副本、不改 3086"。
2. G1 结论（`hephi/docs/validation/2026-11-11-g1-permission-survey.md`）：操作者在宿主 shell 执行 CLI 即 A3 的操作者通道，不依赖 OS 隔离。
3. 操作者身份：`t11-recovery-operator`（显式 `--operator`，写入每条 resolution）。
4. 通道启用：`operator-config.json` 0600 + `{"allowOperatorResolutions": true}`；无配置/0644/仅环境变量均被拒绝（§5 负向证据）。
5. 风险接受：② 使用 `--accept-risk` 显式记录 `operator-risk-accepted`；①③④ 使用宿主查询证据记录的 `host-terminal`。
6. 只读红线：3086 未启动/未触碰；3085 仅 401 探活 + host.log 读 + 真实进程查询，未向其状态目录写入。

## 5. 复现步骤

```bash
# 0) 环境：真实 3085 运行、operator-config 0600、CLI/宿主版本见 §0
mkdir -p /tmp/t11-tools
cp raw/tools/{run-all.sh,build-records.mjs,scan-process.py} /tmp/t11-tools/
# 1) 全量复跑（自动创建新的 /tmp 状态副本与 raw/ 证据；不会写真实 3085 状态）
bash /tmp/t11-tools/run-all.sh
# 2) 也可单步复放：见 raw/*/attempt*/command.txt（含真实绝对路径）
```

`raw/tools/run-all.sh` 会：复制真实 Ticket 种子文件到 /tmp → 构造 4 条 run 记录 → 真实进程/查询构造 →
逐场景调用真实 CLI（1~4 次尝试）→ 记录 stdout/stderr/exit code/run.json sha256/resolutions 快照 →
对比真实状态目录前后 sha256。复跑会产生新的 `/tmp/t11-recovery-*` 目录，raw 证据路径随之变化；本目录保留本次运行的完整 raw 拷贝。

## 6. 限制与已知未验证

1. **不是活 Worker 崩溃注入**：无付费 Worker，故故障记录是按真实格式构造的 /tmp 副本；恢复判定由真实部署 CLI 执行。
2. 未调用宿主内部 Job 注册表（需 token）；按 A3 "查宿主 Job 或进程" 使用真实 `ps` 进程查询。
3. 未验证 runner 侧 `unfinished/unsupported execution requires operator resolution` 的真实宿主触发；该点由既有
   fixture 测试（`hephi/tests/control/check-resolution.test.ts` 15 条）覆盖，本目录不重复声称。
4. 未验证解除后真实 Worker 重跑与 ready 判定（需 Worker 运行）；因此"恢复后可重跑"只以 resolution 存在性 +
   CLI usage 语义为证据，不是端到端。
5. 事件时延：构造期间 3085 空闲、无写活动；真实目录前后 sha256 一致是本次运行时的事实，不构成对其它时段不变的承诺。

## 7. code-task 清单自检

- [x] 复述任务目标与验收标准（§1 四种故障 + 首个失败/恢复轨迹/授权依据 + report/recoveries 产物），与任务板 task-21 一致。
- [x] 改动范围核对：只新增 `eval/evidence/t11-recovery-verification/`；`git status` 仅此目录（另含他人既有 untracked `eval/evidence/b12-task-drafts/`，未触碰）。
- [x] 未创建范围外目录/文件；未修改任何 tracked 文件。
- [x] 敏感信息检查：无 token/密钥/凭据；`operator-config.json` 仅含布尔开关；HTTP 探活未带 token。
- [x] 危险操作检查：无 `rm -rf`/`git clean -fdx`；仅 kill 本脚本自建的 `sleep` 进程（记录 pid，非宿主进程）；无覆盖式写入。
- [x] 未覆盖/清理他人改动：`eval/evidence/b12-task-drafts/`（他人 untracked）全程未触碰。
- [x] 回滚点记录：任务卡基线 `93fee34`（实际执行基线 `cbe8437`，为任务卡基线的后代）。
  - 恢复步骤（优先、安全）：`git revert --no-commit <本证据提交>` 后检查 `git status`，再 `git commit` 生成反向提交；
    或者若本提交尚在 HEAD 且未被他人的后续提交叠加：`git reset --hard cbe8437`（共享仓库中有并行提交，**优先 revert，不要 reset**）。
    无需备份：本提交只新增本目录，未修改任何既有文件。
- [x] 每个产物均真实校验：本报告 §1/§3 的命令退出码与 raw 原文；`recoveries.jsonl` 逐行 `python3 -m json.tool` 校验通过；真实状态目录前后 sha256 一致。
- [x] 失败如实标记：§6 列出 4 项未验证，未用 fixture/推演冒充真实宿主端到端。
- [x] `git status` 仅预期新增；tracked 无 diff；untracked 仅本目录（+他人既有 b12 目录）。
- [x] 仅暂存本目录：`git add eval/evidence/t11-recovery-verification`（精确路径，无 `git add .`）。
- [x] 提交后 `git log -1 --stat` 核对（见提交记录）。
