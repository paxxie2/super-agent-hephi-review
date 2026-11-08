# 持久格式版本化规则（P5）

状态：**规则已定稿；activation 版本化 v5（规范化哈希 v2–v5，v1／无版本只读兼容；v3 冻结 Session 绑定策略；v4 冻结受保护验收资产与授权，C1；v5 冻结人工审批 approvers，C3）与检查记录版本 3（含 pluginCommit）已实施；任务卡 v2（C1 新增 `protectedAssets`/`authorizes`）已实施；`decisions.jsonl` 保持 v1，新增可选 `binding` 字段已登记；`resolutions.jsonl` 无独立版本号（v1 语义）、`plan.jsonl` 条目版本 1，两者均为 append-only 并已在本轮登记（见 §2.6/§2.7）；其余格式仍为 pending。**
适用范围：activation 合同、任务卡、检查配置、检查记录、`decisions.jsonl`、`resolutions.jsonl`（A3）、`plan.jsonl`（C4.2）、基线归档。
只规定规则；行为改动按本规则实施并带测试（activation 已实施）。

## 1. 版本矩阵

| 格式 | 载体 | 当前状态 | 升版条件 |
| --- | --- | --- | --- |
| activation 合同 | `activation.json` | 新合同 `version: 5`（规范化哈希；冻结 `evidence.requireSessionBinding`、C1 受保护验收资产/授权、C3 `verification.approvers`）；`version: 4` 可读（C1 字段，无 `approvers`，出现即拒绝）；`version: 3` 可读（规范化哈希，含 `evidence`，无 C1 字段）；`version: 2` 可读（无 `evidence`，绑定由宿主配置决定）；`version: 1` 与无 version 的历史合同只读兼容（原始键序哈希） | 任何影响判定或挂载的字段变化；v3 由 A1-K5 引入，v4 由 C1 引入，v5 由 C3 引入 |
| 任务卡 | 合同内 `task` | `version: 2`（C1：`protectedAssets` + 验收项 `authorizes`）；`version: 1` 可读（无新字段，出现即拒绝） | 影响拦截或验收判定的变化；v2 由 C1 引入 |
| 检查配置 | 项目检查文件 | 待登记 | 判定语义变化 |
| 检查记录 | 每工单 evidence | 3（含 `pluginCommit`；v2 记录加载即拒绝） | 字段语义或判定条件变化 |
| `decisions.jsonl` | 每工单日志 | 1（新增可选字段必须登记；A1-K5b 的 `binding` 已按此登记，不升版） | 字段或含义变化（仅追加写） |
| `resolutions.jsonl` | `<stateDir>/hephi/<ticketId>/resolutions.jsonl` | v1 语义（**无独立 version 字段**；append-only；`kind` 缺省=历史 run-unblock；A3） | 字段/判定语义变化；新增 `kind` 必须随插件版本发布并在本文登记（旧读者遇未知 kind fail-closed） |
| `plan.jsonl` | `<stateDir>/hephi/<ticketId>/plan.jsonl` | 1（append-only；条目自带 `version: 1`；绑定 `contractHash`；C4.2） | 字段/判定语义变化；`requirePlan` 启用语义变化必须先登记 |
| 基线归档 | `tickets.json`/`summary.json` | 1 | 导出字段或口径变化 |

## 2.1 activation 规范化哈希（version 2 与 version 3）

- 序列化：递归按对象键的 UTF-16 code unit 升序排序；数组保持原顺序（不排序、不当集合）；不输出空白（等价 `JSON.stringify` 的紧凑形式）。
- 语义保持：`undefined` 对象值被丢弃、数组中的 `undefined` 变为 `null`；数字按 JS `JSON.stringify` 规则输出；布尔与 `null` 不变；不对字符串做 Unicode 归一化，不改变路径或 Issue 文本。
- 版本 3 与版本 2 使用**同一套**规范化哈希算法，只是 v3 的合同新增 `evidence.requireSessionBinding` 并纳入哈希；不得因为升版而改变哈希规则，否则会破坏 v2 合同的可读性。
- 版本 1 与无版本历史合同：继续用原始 `JSON.stringify` 键序计算哈希，保持原字节与原 `contractHash`；不得批量重算、不得原地迁移。
- 未知版本：先按历史算法核对 stored hash（防篡改），再拒绝并给出“用当前插件重新 prepare 新合同，不要手改 stored hash”的迁移指引。
- 校验顺序：先验 stored hash（v2/v3 用规范化算法，其余先按历史算法验篡改），再拒绝未知版本，再拒绝未知顶层字段，最后解释 `executionMode`／`enforcement`／`evidence`。
- v1/v2 合同不解释 `evidence`：这些版本的写入器不会产生该字段；若旧版本合同出现它，按“该版本不支持的字段”明确拒绝，避免手写旧版本合同偷偷切换绑定语义。
- 迁移方式：对旧合同重新执行 prepare 生成 `version: 3` 的新文件与新 hash；旧文件保留为只读证据，旧新关联记录在案。

## 2.2 activation version 3：Session 绑定策略（A1-K5）

- 字段：`evidence: { requireSessionBinding: boolean }`，随合同一起纳入 v3 规范化哈希；v3 合同**必须**带该字段且只允许这一个键、值必须是布尔，否则加载即拒绝。
- 写入：`prepare` 读取 `HEPHI_REQUIRE_SESSION_BINDING`（默认 `false`，非法值直接报错且不写合同），把结果冻结进合同。prepare 之后该值不可原地改写，改写会使 stored hash 不匹配。
- 读取：运行时生效值 `effective = contract OR host`。`contract` 来自 v3 合同；`host` 来自宿主配置（`cordis` 配置的 `requireSessionBinding` 或 `HEPHI_REQUIRE_SESSION_BINDING=1`）。宿主只能收紧，不能放松；v1/v2 合同没有冻结值，此时以宿主配置为唯一来源。
- 留痕：每次 ready 判定都在决策日志追加 `binding: { contract, host, effective }`；`contract: null` 表示合同版本早于该字段（而不是“合同说 false”）。该字段是 `decisions.jsonl` v1 的可选新增字段，不升版；按本文件 §2 规则 1 在此登记（`docs/decisions-format.md` 的字段表待后续维护批次同步，本轮写范围不含该文件）。
- 校验：**无论绑定开关**，ready 都要求记录里的 `sessionId` 等于当前 Worker Session id，ready 报缺少 Worker Session id 时失败关闭（A1-K4；修复的是“绑定关闭时没有约束”）。绑定生效时另有 Session 快照核对（同 callId 的 bash 调用/结果、命令、目录、退出码）。宿主 id 与记录写入值是否一致仍未在真实宿主确认（H4 探针）：机制已无条件实现，H4 结论出来前只标注为“待 H4 验证”；若 H4 证明不一致，check-runner 改为写 `session.header.id` 并升检查记录格式版本（v4）。
- 默认值：A2 完成前 prepare 默认仍为 `false`；A2 确认宿主内部调用事件结构后才把默认值改为开启（A1-K1b）。

## 2.3 A1-BIND/A1-OUT：只改核对逻辑，不改持久格式

- A1-BIND/A1-OUT 只改变 ready 的核对逻辑（合同冻结命令与目录、Session 原生调用与结构化结果、宿主 Job 终态、权威输出哈希），**不改变这些持久格式**；C1 将合同升到 `version: 4` 并新增任务卡 v2 字段（见 §2.4）。
- A1-BIND 的证据形状适配（路径 A 结构化 `tool/call`+`message.value`；路径 B 历史实测 `job/registered`+`job/settled`）不改变记录 v3 或决策日志 v1。

### 2.4 C1 合同 v4 / 任务卡 v2 / 项目检查配置

> 注：C3 之后新合同为 v5（见 §2.5）；本节描述 v4 引入的 C1 字段语义，v5 合同同样携带。

- 合同 `version: 5`：在 v4 基础上新增冻结 `verification.approvers: string[]`（C3；非空时 ready 要求 PR 评审满足名单；该字段进入合同哈希，v4 合同出现即拒绝）。
- 合同 `version: 4`：新增冻结字段（任务卡 `protectedAssets` + 验收项 `authorizes` 派生），纳入 v4 规范化哈希（算法同 v2/v3）；v3 合同仍按 v3 语义解释 `evidence`。
- 任务卡 `version: 2`：`protectedAssets: string[]`（glob，工作区相对路径）；验收项 `authorizes: [{ path, op: modify|delete|migrate }]`（精确文件，禁 glob；重复授权拒绝）。`version: 1` 任务卡出现新字段即拒绝。
- 项目检查配置：新增可选 `protectedAssets: string[]`（additive，配置 version 仍 1）；生效清单 = 项目 ∪ 任务卡。
- 优先级（P1-5）：授权不扩大 `allowedPaths`；只覆盖所在验收项 + 精确文件 + 对应操作；未授权 modify/delete 当场拒、shell 绕过在 ready 按最终 diff 拒；清单外测试修改记录 `asset.modified`；授权命中记录 `asset.authorized`（决策日志规则编号见 `decisions-format.md`）。
- `decisions.jsonl` 新增两个规则编号枚举值：`ready.job-unavailable`（宿主无 Job 接口或 Job 终态不可读）与 `ready.output-unverified`（权威输出不可得或与记录不一致）。字段与 `version` 不变，仅枚举值扩展，按本文件 §2 规则 1 在此登记；`docs/decisions-format.md` 的规则列表属后续维护批次同步项（本轮写范围不含该文件）。
- 依赖 H1–H5 宿主探针：结论出来前，A1-BIND/A1-OUT 只能记为“机制已实现、fixture 测试通过”，不得记为真实验收通过，也不得据此升版记录格式。


## 2.6 A3 `resolutions.jsonl`（操作者解除/重试重置，append-only）

- 路径：`<stateDir>/hephi/<ticketId>/resolutions.jsonl`；只追加，不重写/删除历史行。
- **无独立 `version` 字段**（历史记录也没有 `kind`）：按 v1 语义解释——`kind` 缺省即 `run-unblock`。
- `kind`：`run-unblock`（解除一次 interrupted run 的阻塞）| `retry-reset`（C4.5 单 check 重试计数清零）。
- 字段：
  - 公共：`ticketId`、`contractHash`、`basis`（`host-terminal` | `operator-risk-accepted`）、
    `hostQuery`（原始查询输出/失败文本）、`operator`、`at`（ISO 时间）；
  - `run-unblock`：`runId`（不得带 `checkId`）；`retry-reset`：`checkId`（不得带 `runId`）。
- 语义：解除/重置只恢复“可以重新检查/重试”的资格，**不修改** `run.json`/`output.log`，也不把旧执行变成通过证据；
  跨 ticket/合同不生效；重复提交同目标且同 evidence 视为幂等重复（不重复生效），不一致视为损坏。
- 默认关闭：仅宿主配置 `apply(config)` 或操作者 `--operator-config`（mode 0600 JSON）启用；进程环境变量**不是**启用通道（`HEPHI_ALLOW_OPERATOR_RESOLUTIONS` 已无效）。
  Worker 不能通过自身环境启用/调用（A3 信任边界，G1#9 未验证）。
- 损坏处理：任何非法行/未知 kind/字段不匹配 fail-closed（该日志可影响重试/解除判定，不能静默丢弃）。
- 版本判定：当前字段集合固定、只追加；**新增 `kind` 属于扩展但不升版**——必须随新插件版本发布并在本文登记；
  旧 reader 遇到未知 kind 会 fail-closed（不会静默误读）。若未来改变公共字段含义，必须升版并给迁移说明。
- 迁移：无历史版本需要迁移；旧记录缺 `kind` 一律按 `run-unblock` 解释（不得原地补写）。

## 2.7 C4.2 `plan.jsonl`（变更计划，append-only）

- 路径：`<stateDir>/hephi/<ticketId>/plan.jsonl`；只追加，不重写历史版本。
- 字段（每行一个版本）：`version: 1`、`at`（ISO）、`contractHash`、`files: string[]`（工作区相对精确路径或 glob，
  与 `allowedPaths` 同 glob 语义；非空、禁绝对路径/`..`/空段/控制字符）、可选 `note`（≤4000 字符，无控制字符）。
- 绑定：计划只对**同一 `contractHash`** 生效；**同一 ticket 重新 prepare 会复用同一合同（T11：合同只创建一次、不覆盖，
  `contractHash` 与文件 mtime 不变）**，因此旧计划继续有效；只有新 ticket（或人工移除合同后重新激活）才产生新 `contractHash`。
- 语义：`files` 声明预期改动；ready 复核最终 diff 必须落在计划并集内；**插件不判断计划合理性**。
- `requirePlan`（verification 配置 additive，**M1 修复批次已引入 `verification.requirePlan`；以 M1 最终代码为准**）：
  - 启用时 fail-closed：当前合同没有计划 → 拒绝 write/edit 或 ready，规则 `plan.not-declared`；
  - 未启用（默认）时保留兼容行为：无计划不拦截，计划存在时按 `plan.outside-plan` 复核（当前降级形式，见 README/项目配置）。
- 损坏处理：非法行/未知 version/非法 files fail-closed（ready 不得静默忽略不可读计划）。
- 版本判定：条目自带 `version: 1`；新增字段或改变语义必须升版并在本文登记；`requirePlan` 的默认值变化属于行为变化，
  需重新走版本/验收流程，不得只改文档。
- 迁移：无旧版本需要迁移；新增计划只是追加行，不重写历史。

## 2. 规则

1. 任何会改变判定结果的字段变化必须升版；只增加说明性字段可不升版，但必须在本文档登记。
2. 不支持的版本必须在 prepare 或挂载时明确拒绝，并给出可执行的迁移说明；禁止静默沿用旧行为。
3. 未知的顶层判定字段必须拒绝；新增字段先登记再解析。
4. 冻结合同在 prepare 后不可原地改写；哈希按规范序列化（键序固定、无多余空白）计算。
5. 有进行中的赫菲工单时禁止升级插件；不迁移运行中的工单，也不让旧记录在新插件下静默通过。
6. 每个后续改动持久格式的工作包必须写明版本变化与迁移说明。

## 3. 落实方式

- activation：`src/control/activation.ts` 写入 `version: 3` 并使用规范化哈希（`contractHash`，v2/v3 同一算法）；`legacyContractHash` 仅供 v1／无版本合同校验。加载时按原始 version 选择算法，先校验 stored hash，再拒绝未知版本与未知顶层字段，最后解释 `evidence`（`evidenceOf`／`sessionBindingPolicy`）。测试见 `tests/control/activation.test.ts` 的「activation format versioning」「activation canonical hashing (R1)」（R1-T01–T12）与「A1-K5 contract Session-binding policy」（U-K5-01…05）。
- 决策日志：`src/control/decision-log.ts` 的 `DecisionLogInput` 增加可选 `binding`（A1-K5b）；`evidence-verifier.ts` 在每次 ready 判定写入真实合同值、宿主值与生效值。测试见 `tests/control/decision-log.test.ts` 与 `tests/control/evidence-verifier.test.ts`（U-K5-06）。
- 检查记录：`version: 3` 增加 `pluginCommit`；ready 拒绝另一构建产生的证据并要求用当前构建重跑（`src/control/evidence-verifier.ts`）。v2 记录在 `readRuns` 加载时即被拒绝。
- 合同：无 `plugin` 字段的 legacy 合同不因构建不同被拒绝（P2 之前的合同），但其检查记录仍必须是当前构建产生的——这是已知的兼容例外，需人工确认是否符合“旧证据拒绝”口径。
- 插件构建身份：`tsdown.config.ts` 注入 `__HEPHI_COMMIT__`。**dirty 工作树（已跟踪／暂存／未跟踪任一）直接构建失败**，不产出可发布构建；`HEPHI_BUILD_COMMIT` 不能覆盖 dirty 的 Git HEAD。无 `.git` 的源码归档必须显式提供完整 40 位十六进制 `HEPHI_BUILD_COMMIT`，缺失或非法值同样失败；不存在静默 `unknown` 或 `-dirty` 发布路径。`describePlugin()` 返回 `{name, version, commit}`，prepare 合同冻结 `plugin: {version, commit}` 并纳入哈希。
- 其余格式（任务卡、`decisions.jsonl`、基线归档）：代码实施前，任何"已版本化"的结论不得写入验收记录。
- 活跃工单禁止升级由 P8 部署流程执行，不在本文件实现。

### 2.5 C3 合同 v5：人工审批 approvers

- `verification.approvers: string[]`（GitHub 用户名）在 prepare 时冻结并纳入 v5 规范化哈希；未配置/空数组时 ready 行为不变。
- ready：非空 approvers → 需要 `pr_number` 与 PR；名单内每人只取最新 review；任一最新为 `CHANGES_REQUESTED` → 拒绝；至少一名名单内 approver 的 `APPROVED` 且 `commitId === PR HEAD` 才放行；否则 `ready.awaiting-approval`（不是检查失败、不计 C4.5 重试计数、不写 check 记录）。
- v4 及更旧合同手工携带 `approvers` → 加载即拒绝。
- 真实宿主 review→Trigger 唤醒未验证。
