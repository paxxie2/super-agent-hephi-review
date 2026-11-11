# HEPHI：Super Agent 的交付核验插件

只复用 Super Agent 原生 Ticket、Worker、工作区和 PR 流程，不提供第二套交付执行器。

## 当前流程

1. 原生 prepare 冻结任务合同：仓库、base、范围和项目检查命令。
2. Worker 读取合同；配置了知识库时查询对应知识库。
3. Worker 实施，通过 `hephi_check(checkId)` 运行合同中的检查。
4. 检查工具保存真实执行结果、日志及前后代码指纹。
5. Worker 按原生流程推送并创建 PR，调用 `orchestrator_report(ready)`。
6. ready 核对必需检查、证据、代码版本、范围和合同要求的 PR，不重新执行项目测试。

`native` 使用 DSH 原生执行能力；明确选择 `staged` 时，启用原有串行阶段工具，按检查、checkpoint、成功 progress 推进。两种模式使用同一最终核验入口。

全局工具仅有 `hephi_get_contract` 和 `hephi_kb_search`；检查及可选阶段工具挂到当前 Worker。旧 Delivery 工具、Recipe 和项目专用 ready 验证器已删除。

## 检查配置

`scripts/prepare-dubbo.sh` 保留现有入口文件名，内容已改成项目无关：只处理带 `hephi/delivery` 标签的 Issue。宿主必须显式提供 `HEPHI_SOURCE_REPO`（本地 clone）、`HEPHI_STATE_DIR`（与插件一致）、`HEPHI_ALLOWED_PATHS` 和 `HEPHI_VERIFICATION_FILE`。不再内置仓库名单、个人路径或默认验收命令；缺配置直接报错。

通过 prepare 的 `HEPHI_VERIFICATION_FILE` 指向项目检查配置，例如：

```json
{
  "version": 1,
  "checks": [{
    "id": "business-regression",
    "kind": "test",
    "purpose": "执行本项目必需的业务回归",
    "command": "node",
    "args": ["scripts/check-business.cjs"]
  }]
}
```

项目检查入口负责正确选择测试，并在目标测试未执行、断言失败或其他不满足验收条件时非零退出。命令成功不自动证明 Issue 业务正确，更不能把单纯构建成功当作业务验收。GitHub 交付应明确设置 `HEPHI_REQUIRE_PULL_REQUEST=1`。

检查可以是前台命令，也可以是宿主原生后台 Job；HEPHI 等待其终态。取消、超时或未知结果不会放行，这些异常的恢复能力尚未完成。

## 任务卡

`HEPHI_REQUIRE_TASK=1`（prepare 脚本默认开启）时，Issue 正文必须包含任务卡，否则不创建合同：

````text
```hephi-task
{
  "version": 1,
  "goal": "total() 返回两数之和",
  "outOfScope": ["定价规则", "模块结构调整"],
  "acceptance": [
    { "id": "AC1", "text": "total(2, 3) 为 5", "check": "price",
      "paths": ["src/price.js", "tests/price*"] }
  ]
}
```
````

- 合同哈希覆盖整张任务卡。目标、非目标和各验收项每轮都在 Worker 系统提示中。
- 每个验收项指向一个已冻结的项目行为检查（`kind: "test"`；构建检查不能作为验收）。ready 要求所有 required 检查和验收项引用的检查都在当前 HEAD 上通过；多个验收项引用同一检查时只运行、核验一次。HEPHI 不在 base 上重跑检查，复现或行为保持由项目检查本身表达。
- 改动文件必须同时落在 `HEPHI_ALLOWED_PATHS` 和某个验收项的 `paths` 内。直接 `write`/`edit` 的路径按实际检出目录解析（相对路径以 Session cwd 为基准，符号链接解析到真实位置），越界当场拒绝；shell 写入和读不到路径的调用由检查和 ready 时的最终 diff 兜底。
- ready 拒绝删除已有测试（`protect`，默认覆盖常见测试路径）。`budget`（`maxFiles`、`maxChangedLines`）只在 Issue 作者写明时生效。这些都是机械限制，不能识别允许路径内的语义漂移。
- 检查目录不存在等确定未启动的失败记为 `blocked`（原因以 `check not started:` 开头），修正后可重试，历史保留；可能仍在运行的执行记为 `unknown`，保持关闭，需人工处理。
- Session 绑定（A1-K5）：prepare 把 `evidence.requireSessionBinding` 冻结进合同并纳入合同哈希；合同格式升为 `version: 5`（v3 起冻结 Session 绑定；v4 起冻结受保护验收资产与授权，C1；v5 起冻结人工审批 approvers，C3），`version: 1/2/3/4` 的旧合同仍可读。运行时生效值 = 合同值 **OR** 宿主配置（`config.requireSessionBinding` 或 `HEPHI_REQUIRE_SESSION_BINDING=1`），宿主配置只能收紧、不能放松。prepare 的默认值仍为关闭：内部检查调用在真实宿主 Session 中的事件结构尚未核实（A2）。
- 绑定生效时，ready 不从记录自证，而是按「证据链核对（A1-BIND / A1-OUT）」逐环从当前 Worker Session 重核原生调用、结果分支、Job 终态与权威输出哈希。无论绑定开关，ready 都要求记录的 `sessionId` 等于当前 Worker Session id，缺少 Worker Session id 一律拒绝（A1-K4；宿主侧 id 是否与记录写入值一致仍待 H4 探针确认）。每次 ready 判定都会在决策日志追加 `binding: {contract, host, effective}`（A1-K5b），用于事后核对实际生效的策略。
- 检查命令不接受 `parser`、`reportPaths`、`targetTests`、`expect` 字段；任务卡不接受 `hephi-test` 块；已有此类配置必须明确修订后创建新任务，不能静默忽略。

## 证据链核对（A1-BIND / A1-OUT）

绑定生效时，ready 不再只信任检查记录，而是按下面每一环从当前 Worker Session 重新核对（实现：`src/control/evidence-verifier.ts`；测试：`tests/control/evidence-verifier.test.ts` 的 U-BIND-*／U-OUT-*，fixture 合成 Session 快照）：

1. **合同冻结定义。** 预期命令由合同检查定义的 `command`、`args` 与合同 `baseSha` 重新生成（`checkCommand`），预期目录由 `contained(workspace, definition.cwd)` 解析；不以记录里的 `argv`／`cwd` 作为依据。
2. **两种互斥的 Session 事件形状。** 同一 `innerCallId` 的证据必须且只能命中一种形状（都命中或都不命中一律拒绝，并在拒绝原因里记录诊断）：
   - **路径 A（结构化形状）**：唯一 `tool/call`（`callId=innerCallId`、`name=bash`、`arguments.command`／`workdir` 与第 1 步**逐字符**相等，不解析 shell），加上唯一 `tool/result`（`isError === false`）并携带结构化 `message.value`（含 `kind`）。
   - **路径 B（历史真实 Worker 快照的只读观察；非 A2 结论，A2 记录仍为待填写模板）**：唯一 `job/registered`（`data.toolCall.callId=innerCallId`、`rootCallId=外层调用`、`kind/name=bash`；`arguments` 可以是原始 JSON 字符串或对象，其中 `command` 必须与第 1 步重算值逐字符相等；`workdir` 缺失时跳过目录比较并在证据里标注 `workdir: absent`），加上唯一 `job/settled`（`data.toolCall.callId=innerCallId`、`owner` 存在时必须是本 Session（缺失时跳过归属比较，当前实现口径；H4/H6 未验证，见 A2 模板）、`status=completed`、`detail` 必须能解析出 `exit code: <n>` 且等于记录值且为 0）。
3. **分支判定按证据来源的 kind。** 路径 A 的 `foreground` 要求 `exitCode` 为整数且等于记录值、且为 0，无 `timedOut`／`aborted`／`signal`，记录不得带 `jobId`；路径 A 的 `promoted`／`background` 要求 `value.jobId` 严格等于记录 `jobId`。**路径 B 只能证明 Job 终态**，因此只能支撑 background／promoted 语义；若记录带 `jobId` 但只命中路径 A 的 foreground 结构化结果，拒绝（规则不变）。其他 kind、结构缺失或解析失败：拒绝。
4. **Job 不可得。** 宿主没有 Job 接口，或 Job 在 ready 前已被清除（`jobs.get` 读不到／抛错）：拒绝，决策日志规则 `ready.job-unavailable`。
5. **权威输出哈希（A1-OUT）。** foreground 的结构化 `stdout.text`／`stderr.text` **只在路径 A 可用**，按 runner 持久化格式（`${stdout.text}\n${stderr.text}`）重算 sha256；background 用 `jobs.readAt(jobId, 0, sessionId)` 的 chunks 拼接重算（`lossy === true` 即不可用）。重算值必须等于 `record.outputHash`；`output.log` 与 `record.outputHash` 已在前面核对。**路径 B 或没有结构化输出时，前台权威输出不可得，绑定生效时一律拒绝**，决策日志规则 `ready.output-unverified`，不按文本猜测、不静默降级。
6. **Session 归属。** 无论绑定开关，记录的 `sessionId` 必须等于当前 Worker Session id（A1-K4）。

**当前可声称的边界（H1–H5 未验证）。** 以上是机制实现与 fixture 测试，覆盖两种形状：

- 路径 A 的结构来自计划书与 fixture；路径 B 来自 **2026-11-06/07 的历史真实 Worker 快照**（插件早于 A1 v3）的只读观察：内部 dispatch 只留下 `job/registered`／`job/settled`，没有 innerCallId 的 `tool/call`／`tool/result`，持久化 `tool/result.message` 无结构化 `value`，退出码只有文本 `exit code: N`；历史 bash 调用 0 条带 `workdir`。**路径 B 尚未在当前候选插件上复跑验证**。
- H1（调用参数的编码与 workdir 形态）、H2（结构化 `value` 的字段与退出码格式）、H3（Job 终态视图与 `detail` 格式）、H3a（`jobs.readAt` 的 chunk／`lossy`／截断语义）、H4（Session id 与记录写入值一致性）、H5（继承事件计数）都仍待宿主探针。path B 的 `label` 携带命令、`arguments` 作为命令来源属于待确认假设。
- 因此在 H1–H5 结论出来前，本版本只能声称“机制已实现、两种形状的负例已覆盖”，不能声称 D1 真实证据链验收通过。已知后果：在只有路径 B 的真实宿主上，前台检查（记录无 `jobId`）无法提供结构化前台输出，绑定生效时会被 `ready.output-unverified` 拒绝——这是 fail-closed 的预期行为，不是通过。
- 绑定关闭时仍只做原有核对（合同冻结命令／目录 + `output.log`↔`record.outputHash`），见「已知限制」。

## 已知限制

以下是当前版本已确认、尚未用机制消除的限制。README 与验收记录都不得把它们当作已解决：

1. **检查期间改动又改回无法发现。** 检查前后文件指纹相同只能证明两个时点一致，不能证明检查期间没有被改过再改回。检查期间 Worker 的修改类工具会被拦下，但检查命令本身或后台进程仍可能改文件；本版本不新增机制。
2. **绑定关闭时输出只与记录自身哈希一致。** 绑定关闭（默认）时，ready 只核对 `output.log` 与记录 `outputHash`，不与 Session／Job 的权威输出比对，“输出哈希一致”只说明日志文件没有被改动。绑定生效时按「证据链核对」执行 A1-OUT；路径 B（历史 Job 事件形状）没有结构化前台输出，前台证据会被 `ready.output-unverified` 拒绝。权威输出的真实宿主格式仍依赖 H1–H5 结论，未取得前不得声称已验证。
3. **绑定关闭时手写记录可以通过。** 默认（绑定关闭）时，ready 只要求记录的 `argv`、`cwd` 与合同冻结的检查一致；状态目录可写的前提下，手写一条这两项都正确的记录不需要真实执行就能通过。只有打开绑定（合同字段或宿主配置）才会要求当前 Worker Session 中对应的原生调用。
4. **检测非防护（同 UID 同权）。** H6 检测层（`src/control/snapshot-seal.ts`，detect-only）只检测两类篡改：检查完成时封存的 Session 日志前缀被改写/重编码，以及在帧流之外追加字节/残帧。Worker 与宿主同 UID 时仍可改写快照、检查记录或追加一个结构合法的伪造帧，与宿主正常批次不可区分；因此 H6 fail 的根因不变，不得据此声称证据不可伪造或重开 A1-BIND。

## 开发和验收

```sh
pnpm install
pnpm check
```

`check` 执行类型检查、自动测试和构建。这些检查不等于原生 GitHub → Worker → 赫菲 → PR 的真实端到端验收。历史运行记录在 `docs/validation/`，只能证明所标明的版本；新改动须重新验收。

构建后通过现有 DSH profile 加载插件，不启动另一套 Super Agent。部署前确认当前任务状态，不用重启宿主中断其他会话。
