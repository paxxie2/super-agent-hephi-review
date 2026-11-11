# 决策日志格式（P3）

每个赫菲工单在 `$HEPHI_STATE_DIR/hephi/<ticketId>/decisions.jsonl` 追加写入，一行一个 JSON 对象。
实现见 `src/control/decision-log.ts`。

## 字段

| 字段 | 说明 |
| --- | --- |
| `version` | 格式版本，当前 `1` |
| `seq` | 工单内唯一、递增；只按最后一行的 seq+1 分配，不重写历史行 |
| `at` | ISO 时间 |
| `ticketId` | 工单 ID |
| `sessionId` | 产生判定的 Worker Session |
| `callId` | 宿主工具调用 ID（ready 为 `orchestrator_report` 的调用） |
| `tool` | `write` / `edit` / `hephi_check` / `orchestrator_report` |
| `mode` | `enforce` / `shadow`（shadow 下 effective 恒为 allow，would 记录本应判定） |
| `effectiveDecision` | 实际生效的判定 `allow` / `deny` |
| `wouldDecision` | 规则本应给出的判定；enforce 下与 effective 相同，shadow 下用于统计"本应拒绝" |
| `rule` | 固定规则编号 |
| `reason` | 拒绝原因或记录说明（可空） |
| `contractHash` | 判定时使用的合同哈希 |
| `pluginCommit` | 产生判定的插件构建 commit |
| `binding` | 可选（A1-K5b）。该次 ready 判定实际生效的 Session 绑定策略：`{ contract, host, effective }`；`contract: null` 表示合同版本（v1/v2）没有冻结该值。仅新增可选字段，`version` 保持 `1`，旧读者忽略即可。 |

## 规则编号

- `scope.allowed` / `scope.outside-checkout` / `scope.outside-task`：写/改文件前的路径与范围判定
- `check.pass` / `check.blocked` / `check.unknown` / `check.running`：`hephi_check` 结果与拒绝运行
- `ready.pass` / `ready.binding` / `ready.evidence-missing` / `ready.pr-mismatch` / `ready.plugin-build` / `ready.other`
- `plan.recorded`：`hephi_plan` 追加计划（allow）或拒绝（deny）；shadow 模式下同一规则记录 `wouldDecision`。
- `plan.outside-plan`（deny）：write/edit 目标不在当前合同 `plan.jsonl` 计划内，或计划日志不可读（fail-closed）；shadow 下记录 `wouldDecision`。
- `plan.not-declared`（deny）：`verification.requirePlan` 启用时，当前合同尚无计划即拒绝 write/edit 或 ready（计划存在但目标不在计划内走 `plan.outside-plan`）；shadow 下记录 `wouldDecision=deny`、`effectiveDecision=allow`。规则名 `plan.not-declared` 已在 `worker-mount.ts`/`evidence-verifier.ts` 实现。未启用 `requirePlan`（默认）时该规则不触发，无计划不拦截（C4.2 默认 optional，见 `project-config.md` §6）。
- `plan.width`（allow，仅记录）：v5.4 §2 ② 计划宽度观测——ready 通过 C4.2 计划存在性/越界复核后，记录 `planFiles`（`PlanSummary.files` 并集数量）、`changedFiles`（最终 diff 文件数）与 `ratio`（`changedFiles / planFiles`）。**只记录、不拦截**：该行的 `effectiveDecision` 恒为 `allow`，不参与、也不改变 ready 判定；`version` 与既有字段不变，仅新增规则编号与三个可选字段（`planFiles`/`changedFiles`/`ratio`）。计划缺失或越界时按既有 `plan.not-declared`/`plan.outside-plan` 规则处置，不写 `plan.width`。
- `check.retry-limit`：C4.5 检查重试达到上限（默认 3，按键 ticketId+contractHash+checkId 从已有记录推导）时拒绝启动；`reason` 含固定 blocked 报告格式（卡住的验收项/每次改了什么/输出要点/原因/需谁决定什么）。`version` 与字段不变，仅新增规则编号。
- `ready.job-unavailable` / `ready.output-unverified`：A1-BIND/A1-OUT 专用拒绝——后台 Job 终态在 ready 时不可读或无 Job 接口；权威输出（Session 前台 stdout/stderr 或 Job `readAt`）不可得、`lossy`、被截断或与记录不一致。`version` 与字段不变，仅新增规则编号。
- `repository-mismatch` / `base-missing` / `workspace-dirty` / `path-out-of-contract`（deny）：T14 `hephi_check` 启动前拒绝的四类稳定类别——工作区 origin 与冻结合同仓库不一致／冻结 base commit 不在工作区／工作树有已跟踪、暂存或未跟踪改动／变更文件超出合同 `allowedPaths`（一次 `git status --porcelain --untracked-files=all` 列全，含未跟踪文件）。`reason` 以类别码开头并附一行下一步建议；每次拒绝先写本日志再抛错，不创建检查记录。`version` 与字段不变，仅新增规则编号。
- `ready.github-unavailable`（deny）：T14 ready 判定中 GitHub 不可用（`reason` 匹配 rate limit，如 `API rate limit exceeded`）——属于环境等待状态，不是检查失败，不计入 C4.5 重试计数。`version` 与字段不变，仅新增规则编号。
- `ready.red-missing`（deny）：T17 红态门禁——version 3 且 `kind: "code"` 的任务合同缺少可用红态检查记录（无红态运行、最新红态退出码为 0、超时/取消/unknown、红态期间源码变化或记录不属于当前合同）时拒绝 ready；提示用 `hephi_check phase="red"` 先跑验收检查。`version` 与字段不变，仅新增规则编号。
- `ready.red-impl-files`（deny）：T17 红态门禁——最新红态记录的 `before.headCommit` 与冻结合同 `baseSha` 之间的变更文件必须全部落在所有验收项 `tests` 并集内；红态 commit 混入实现代码即拒绝并列出文件。`version` 与字段不变，仅新增规则编号。
- `ready.red-tests-changed`（deny）：T17 红态门禁——红态 commit 之后验收 `tests` 文件又被修改/删除/新增时红态证据失效，拒绝并列出文件。`version` 与字段不变，仅新增规则编号。
- `asset.authorized`（allow，审计）：C1 授权命中的受保护验收资产变更——`reason` 记录验收项 id、文件与操作（`modify`/`delete`）；仅记录，不放宽其他判定。
- `asset.modified`（allow，仅记录）：C1 清单外的已有测试被修改（受旧 `protect` 清单约束的文件）——只记录、不拦截；清单外删除仍按旧规则拒绝。
- `asset.unauthorized-modify` / `asset.unauthorized-delete`（deny）：C1 受保护验收资产在缺少“同一验收项 + 精确文件 + 对应操作”授权时被修改/删除（write/edit 当场拒绝；shell/git 绕过由 ready 的最终 diff 复核拒绝）。`version` 与字段不变，仅新增规则编号。
- `ready.snapshot-tampered`（deny）：H6=C 检测层——绑定生效（`binding.effective`）时，被采信检查记录缺少封存、封存不可用，或 ready 重读的 Session 日志与封存前缀不一致（前缀摘要变化、帧流外追加、撕裂尾帧重试后仍不完整）即拒绝；`reason` 以 `ready.snapshot-tampered:` 开头并附 checkId 与具体原因。这是**检测**而非防护（同 UID Worker 仍可改写），不改变 A1/A2 判定与绑定开关默认值。`version` 与字段不变，仅新增规则编号。
- `ready.awaiting-approval`（deny，等待审批）：C3 人工审批——合同 v5+ 冻结了非空 `verification.approvers` 时，PR 评审必须满足：名单内每人只取最新一条 review；名单内任一人最新为 `CHANGES_REQUESTED` 即拒绝；至少一名名单内 approver 对当前 PR HEAD（`commitId === headSha`）`APPROVED` 才放行。没有有效批准返回该规则并在 `reason` 说明是等待审批（**不是检查失败，不计入 C4.5 重试计数**）。`version` 与字段不变，仅新增规则编号。

## 写入约束

- 只追加：任何实现都不得重写、删除或压缩历史行。
- 并发：同一进程内按日志文件串行分配 `seq`；写入使用追加模式。**跨进程并发未加文件锁**（已知限制，尚未实现）。
- 写失败（只读目录、磁盘错误）：判定结果不变，错误写入 stderr，`appendDecision` 返回 `{ok:false, logError}`，不补造记录。
- 脱敏、权限（文件 0600）与保留期按 P14 的数据规则执行；本日志不含 diff 内容。
