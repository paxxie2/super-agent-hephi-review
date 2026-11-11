# T11 恢复验证原始证据（raw）

本目录是 2026-11-11T19:57Z 在 3085（g1-exp，pid 33924，ab5f527）上执行
`/tmp/t11-tools/run-all.sh` 时留存的原始拷贝。运行时临时根目录记录在 `tmp-root.env`，
`report.md` §3 引用的 `$ROOT` 即该目录（/tmp 可丢弃，本拷贝持久）。

## 目录

| 路径 | 内容 |
| --- | --- |
| `00-host-facts/host-facts.txt` | 只读宿主事实：repo HEAD、3085 进程/HTTP 401、3086 HTTP 000、host.log 激活标记、CLI sha256、operator-config（0600）、`resolve --help` |
| `00-host-facts/real-state-before.txt` | 真实 Ticket `46aa3f59…` 状态目录逐文件 sha256（执行前） |
| `00-seeded-records.json` | 从真实 ticket 种子构造的 4 条 run 记录所在目录与 runId |
| `01-still-running/` | 状态①：真实 sleep 进程 + host query；`attempt1-refused`（exit 1）→ 停止确认 → `attempt2-recovery`（exit 0）→ `attempt3-idempotent-repeat` |
| `02-query-unavailable/` | 状态②：curl 到关闭端口（exit 7）作为查询不可用证据；无风险接受被拒（exit 2）→ 错误基被拒（exit 2）→ `--accept-risk` 恢复（exit 0） |
| `03-result-lost/` | 状态③：无 output.log/exitCode 的已结束记录；宿主进程扫描无匹配 → host-terminal 解除（exit 0）；run 目录仍只有 run.json |
| `04-leftover-running/` | 状态④：遗留 running；空 query 被拒（exit 2）→ 按 running 被拒（exit 1）→ 宿主查询确认无进程后解除（exit 0）→ 重复幂等 |
| `05-operator-gate/` | 授权通道负向：无配置/0644/仅环境变量均 exit 1，未写 resolution |
| `06-real-state-untouched/` | 真实状态目录执行后 sha256、`real-state-diff.txt`（PASS: before==after）、真实目录无 resolutions、/tmp 副本最终 sha256 |
| `tmp-root.env` | 本次运行的临时根目录（/tmp）与 stamp |
| `tools/` | 复跑脚本：`run-all.sh`、`build-records.mjs`、`scan-process.py`（用法见 report.md §5） |

## 说明

- `attempt*/` 内每个尝试固定包含：`command.txt`（真实命令）、`stdout.txt`、`stderr.txt`、`exit-code.txt`。
- 记录中的 `/tmp/t11-recovery-<stamp>/...` 路径为运行时路径；ticket id、contractHash、
  pluginCommit、sessionId 等来自真实 3085 Ticket `46aa3f5947c125330ef14d8014a88477` 的真实记录模板。
- 本目录不含 token、密钥或凭据；`operator-config-0644.json` 是负向用例的临时副本（仅布尔开关）。
