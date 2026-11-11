# 项目配置约定（C4.2 / C4.6 / C4.8 / C1 / C2）

状态：**约定与提议（未实现 / 未全部实现）**。本文件规定项目侧配置口径与后续实现字段；
**本轮没有修改插件代码或任务卡格式**。逐节标注「已实现 / 待实现」；未标注实现的均为提议，
不得在验收记录里写成已生效。

| 节 | 主题 | 当前状态 |
| --- | --- | --- |
| §1 | C4.6 检查环境固定 | **约定**；`check-task` 的 environment 校验**已实现（任务级）**；插件/prepare 侧离线命令+lockfile 校验**已实现（机制级，2026-11-07）**；运行时网络隔离仍待实现 |
| §2 | C4.8 聚焦检查 | **约定**；`lint-task` 聚焦提示规则**已实现（本轮，仅提示）**；阈值可配置/调优 |
| §3 | C1 受保护验收资产 | **已实现（合同 v4/任务卡 v2，机制级，2026-11-07）**；未做真实宿主 E2E |
| §4 | C2 未覆盖改动提示 | **约定 + 项目侧示例**（赫菲不解析覆盖率；集成待实现） |
| §5 | 覆盖提示输出格式 | 示例脚本已按此格式输出；赫菲消费/展示待实现 |
| §6 | C4.2 变更计划 | **机制级已实现（2026-11-07）**：默认 **optional**（不构成强制拦截）；`verification.requirePlan=true` 时 fail-closed；未做真实宿主验证 |

实现依据：`ROADMAP-95.md` §4.10 C1/C2/C4.6/C4.8；字段命名沿用
`hephi/docs/versioning.md`/`decisions-format.md` 的登记风格。

## 1. C4.6 检查环境固定（约定）

目标：让检查在**可重复、离线、锁版本**的环境里运行；检查结果不得依赖运行时的网络/浮动版本。

### 1.1 项目必须满足

| 项 | 约定 |
| --- | --- |
| 依赖锁 | 仓库提交锁文件（`package-lock.json`/`pnpm-lock.yaml`/`poetry.lock`/`requirements.txt` 固定版本等），检查前不更新锁文件 |
| 离线安装 | Node：`npm ci --offline` 或 `pnpm install --frozen-lockfile --offline`；Java：Maven `mvn -o`（本地仓库已预热）或 Gradle `--offline`；Python：从已固定 wheels 安装 |
| 检查命令 | `verification.checks[].command/args` 不得包含联网步骤（`git clone`、下载依赖、访问 registry）；必要时用项目脚本封装离线约束 |
| 工具链版本 | JDK/Node/Python 版本在任务卡或项目配置中固定并记录；检查脚本可断言实际版本 |
| 可复现输入 | 不读取外部可变文件/环境变量；入口使用相对 `cwd`，不写仓库外路径 |
| 失败语义 | 离线依赖缺失/版本不符必须**非零退出**（fail-closed），不得跳过或回退到联网 |

### 1.2 与 `check-task` 的关系（B2）

`eval/check-task.mjs` 当前校验（含本轮扩展）：任务结构、base 上隐藏测试失败、参考修复通过（3 次一致）、
参考修复不越 allowedFiles；**可选 `environment` 块**在声明 `offline:true` 时校验锁文件与离线命令
（本轮已实现，见 §1.3）；未声明 `environment` 时行为不变（不拦截）。**插件/prepare 侧已强制**（`environment.offline===true` 时做 lockfile 存在性与联网命令扫描，见 §1.4）；任务级校验在 `check-task` 实现；**运行时网络隔离仍待实现**。约定字段：

- 在 `task.json` 增加可选 `environment` 块（提议字段）：
  ```json
  "environment": {
    "offline": true,
    "lockfile": "pnpm-lock.yaml",
    "toolchain": { "node": "22.19.0", "java": "17" },
    "install": "pnpm install --frozen-lockfile --offline"
  }
  ```
- `check-task` 扩展校验（已实现，任务级）：
  1. `offline=true` 时检查 `install` 命令含离线标志，且不含网络命令；
  2. 锁文件存在且与 base 一致（不得在复核中被更新）；
  3. 工具链版本可被验证（至少记录）；不满足则任务无效（exit 1）。
### 1.3 已实现（本轮，任务级 `check-task`）

`eval/check-task.mjs` 已支持 task.json 的可选 `environment` 块（未声明时不拦截）：

```jsonc
"environment": {
  "offline": true,
  "lockfile": "package-lock.json",
  "commandsMustMatchOffline": false
}
```

校验规则（仅任务校验；插件运行时/prepare 不强制）：

- `environment` 必须是对象；`offline` 必填 boolean；`lockfile` 在 `offline:true` 时必填（仓库相对路径）；
  `commandsMustMatchOffline` 可选 boolean；未知字段仅警告；
- `offline:true` 时要求 lockfile 存在：完整模式检查 base checkout 或任务目录；`--dry-run` 缺仓库上下文时
  只警告（无法确认仓库锁文件），完整模式缺失即判任务无效（exit 1）；
- 扫描 `hidden-test.sh`、`reference.patch`（新增行）与可选 `task.commands`：命中疑似联网安装命令即失败并列出命令，
  例如 `npm install`（非 ci）、`pnpm install` 缺 frozen/offline、`mvn` 缺 `-o`、`gradle` 缺 `--offline`、
  `git clone`/`curl`/`wget`；
- `commandsMustMatchOffline:true` 使用更严格的离线标志要求（如 `npm ci` 需 offline、`pnpm install` 需
  `--frozen-lockfile` **且** `--offline`、`yarn install`/`pip install` 需对应离线参数）；
- `--self-test` 覆盖：合法 offline 通过、缺 lockfile 完整模式失败、联网命令失败、未声明不拦截。

### 1.4 插件侧 prepare 强制（已实现，机制级，2026-11-07）

- `verification.environment?: {offline?: boolean; lockfile?: string}`（verification 格式仍 version 1，additive）；
  `offline:true` 时 `lockfile` 必填且必须为 workspace-relative。
- `prepareActivation` 在 `offline:true` 时：检查 workspace 下 lockfile 存在；扫描每个 `checks[].command/args` 的联网
  安装/网络命令（npm 非 ci、pnpm 缺 frozen/offline、mvn 缺 -o、gradle 缺 --offline、yarn/pip、git clone/curl/wget）；
  命中即失败并列出全部命中项，不写合同。未声明/`offline:false` 行为不变。
- `environment` 随 `verification` 冻结进合同并纳入合同哈希；合同版本仍为 5（additive，不影响 ready 判定）。
- **限制**：只做 prepare 时命令白名单 + lockfile 存在性；不阻止运行期联网；`sh -c`/变量封装可绕过扫描；
  lockfile 内容/base 一致性未校验；`npm ci` 在插件侧视为离线（与本文建议 `npm ci --offline` 有口径差异，待负责人确认）；
  真实项目离线执行未验证。

## 2. C4.8 聚焦检查（约定）

目标：验收项只跑相关测试，整套回归最后跑一次；减少每次 ready 的检查成本，同时不牺牲整体回归。

### 2.1 配置约定

1. **每个验收项绑定相关检查**：`task.acceptance[].check` 指向一个 `kind: "test"` 的检查；
   多个验收项可引用同一检查（ready 每个检查只运行/核验一次）。
2. **整套回归作为一个 required check**：例如 `full-regression`（`kind: "test"`、`required: true`），
   在集成完成后运行一次；不要在每个验收项里重复整套回归。
3. **检查命名**：聚焦检查用可读 id（如 `unit-<module>`），整套回归用固定 id；
   业务验收项指向 `kind: "test"` 的聚焦检查，构建检查不能充当验收项。
4. **执行顺序**：按验收项边改边跑聚焦检查；全部集成后再跑一次 `full-regression`；ready 时核验
   所有 required 检查与验收项引用的检查证据。
5. **项目选择**：整套回归是否 required、聚焦检查粒度由项目在配置里决定；赫菲只校验引用与证据。

### 2.2 `lint-task` 提示规则

`hephi lint-task`（C5）当前硬校验：任务卡 schema、ticketId、allowedPaths 相对路径、
checks 结构、验收项引用存在的 **test** check、重复 id；`acceptance>8`、`allowedPaths>50` 仍输出 warning。
本轮新增 **focus 提示**（只提示、不失败，exit 语义不变；输出到 stdout，JSON 字段 `focus`）：

| 规则 id | 触发（实现） | 级别 |
| --- | --- | --- |
| `focus.required-too-many` | required 检查数 > 5 | 提示 |
| `focus.check-not-required` | 验收项引用了非 required 的检查 | 提示 |
| `focus.acceptance-check-not-test` | 同一 check 被 >5 个验收项共享（该 id 名称沿用任务口径；补充共享计数） | 提示 |
| `focus.broad-scope` | allowedPaths 含 `**`/`*`/`**/*`/`**/...` 过宽，或 >50 条 | 提示 |
| `focus.no-regression` | 没有任何 required `kind=test` 检查在 id/purpose/command/args 上像整套回归（启发式） | 提示 |
| `focus.unused-check` | checks 中既非 required、也未被 acceptance 引用的检查 | 提示 |
| `focus.tests-outside-paths` | 验收项的 `tests` 有文件不在该项自己的 `paths` 内（Worker 无法新建或更新它，先红后绿可能无法完成；依据：G1 开发集 3 张工单因此未能 ready） | 提示 |

输出示例：`HEPHI task lint: PASS <file> (...)`, 随后每行 `focus: <rule> <message>`；
`--json` 输出 `{schemaVersion,ok,file,errors,warnings,focus:[{rule,message}],summary}`。

> 注意：`lint-task` 是**离线提示工具**，不替代 prepare/ready；提示不改变合同或拦截行为，
> 也不构成“已验证”。规则阈值为建议值，可在项目侧调整；`focus.no-regression` 只是启发式，
> 可能误报/漏报。

## 3. C1 受保护验收资产（已实现 2026-11-07，机制级；未真实验收）

> **状态：已实现（合同 v4 / 任务卡 v2 / 项目配置可选字段；默认兼容旧 v1 任务卡）。**
> 实现在 `contracts/task.ts`、`contracts/checks.ts`、`control/discipline.ts`、`control/worker-mount.ts`、
> `control/activation.ts`，测试在 `tests/control/protected-assets.test.ts`（15 用例）。**未做真实宿主 E2E**，
> 不能据此声称 C1 已达到启用判据；`migrate` 的“替代文件”判断与 pre-execute 的 TOCTOU 窗口是已知限制。
> 本节其余内容是已实现规则的说明（不是提议）。

### 3.1 目标（ROADMAP §4.10 C1）

- 保护项目/Issue 作者**指定**的关键验收测试，不再默认把所有已有测试都当成不可修改；
- 清单内文件被修改/删除/迁移必须由**某个验收项授权**，否则拒绝；
- 清单外的已有测试：**删除仍按现有规则拒绝**；修改只记录、不拦截；
- 项目可扩大清单到所有已有测试，但必须测误拦率与副作用（Worker 反复申请扩大范围、或新增重复测试绕开限制）。

### 3.2 字段

任务卡（`task`，Issue 内的 `hephi-task` JSON）使用以下字段；项目配置可提供默认清单（additive）：

```jsonc
{
  "version": 2,                        // 提议升版；v1 无这些字段，行为不变
  "protectedAssets": ["tests/acceptance/**", "spec/contract/**"],
  "acceptance": [
    {
      "id": "AC1",
      "text": "…",
      "check": "unit-price",
      "paths": ["src/price.js"],
      "authorizes": [
        { "path": "tests/acceptance/price.contract.test.js", "op": "modify" }
      ]
    }
  ]
}
```

- `protectedAssets: string[]`：仓库相对的**受保护验收资产**（glob；建议与 `protect` 使用同一路径语法）。
- `authorizes: [{ path, op }]`：
  - `path` 是仓库相对的**精确文件路径**（不支持 glob；便于审计“授权了哪个文件”）；
  - `op` ∈ `modify | delete | migrate`；`modify` 不隐含 `delete`/`migrate`，反之亦然。
- 生效清单 = 项目默认 `protectedAssets` ∪ 任务卡 `protectedAssets`（任务卡只能增加、不能缩小项目保护）。
- 授权必须写在**具体验收项**内；不允许任务卡级“全局授权”。

### 3.3 优先级规则（与计划审查 P1-5 的 C1 授权优先级一致）

按顺序判定，后者不能推翻前者：

1. **allowedPaths 优先**：任何授权都**不扩大** `allowedPaths`；目标不在 `allowedPaths` 内 → 直接拒绝
   （授权不能把范围外文件变成合法）。
2. **验收项范围优先**：授权目标还必须落在**授权所在验收项**的 `paths` 内；
   不在该验收项 `paths` 内 → 授权无效（防止“随便找个验收项挂授权”）。
3. **按操作精确匹配**：清单内资产被修改/删除/迁移时，必须有同一验收项、同一精确文件、同一 `op` 的授权；
   `modify` 授权不覆盖 `delete`，`migrate` 授权不覆盖 `modify`/`delete`；不跨验收项/文件/操作继承。
4. **未授权删除仍拒**：清单内资产的 `delete` 无匹配授权 → 拒绝（保持现行“删除测试被拒”的语义）。
5. **未授权修改/迁移仍拒**：清单内资产的 `modify`/`migrate` 无匹配授权 → 拒绝。
6. **清单外修改只记录**：不在生效清单内的已有测试/文件被修改 → 放行，但写决策日志
   `asset.modified`（**record-only**，不是 deny）；清单外**删除**仍按现行 `protect` 规则拒绝。
7. **授权也要审计**：授权生效时写决策日志（建议 `asset.authorized`），记录验收项 id、文件、op，
   便于事后人工复核；不改变 ready 通过条件（ready 仍要求检查/证据/范围一致）。
8. **不扩大范围**：授权只解决“该验收项改/删/迁移该受保护文件”的许可，不改变任务卡 paths、合同
   allowedPaths、检查命令或 ready 判定。

### 3.4 建议的决策日志规则（待登记 `decisions-format.md`）

| rule | 方向 | 说明 |
| --- | --- | --- |
| `asset.unauthorized-modify` | deny | 受保护资产修改无匹配授权 |
| `asset.unauthorized-delete` | deny | 受保护资产删除无匹配授权 |
| `asset.authorized` | allow | 授权命中的 record（审计用，可仅记录） |
| `asset.modified` | allow（record-only） | 清单外已有测试被修改，只记录 |

这些规则编号只是提议；实现前需在 `decisions-format.md` 登记并保持 `decisions.jsonl` 可追加兼容。

### 3.5 版本与兼容

- 任务卡新增字段改变格式语义，建议任务卡 **version 2**（`versioning.md` 登记）；v1 任务卡没有这些字段，
  行为与现行完全一致（受 `protect` 保护、删除拒绝）。
- 合同冻结任务卡后，授权随合同哈希一起冻结；prepare 之后不得手工改任务卡（与现有规则一致）。
- 未实现前，**不得**在任务卡里写 `protectedAssets`/`authorizes` 并期待生效；prepare 当前 task 卡
  schema 会拒绝未知字段（strict）。

### 3.6 验收方式（实现后）

- 未授权修改受保护资产 → 拒绝；授权后放行；清单外修改放行并记录；删除未授权仍拒；
  `modify` 授权不能用于 `delete`；授权不能越过 allowedPaths/验收项 paths。
- 开发集测量误拦率与副作用（重复申请扩大范围、新增重复测试绕开）。
- 在真实宿主 E2E（A5）前只能做机制测试；不得把机制通过写成真实验收通过。

## 4. C2 未覆盖改动提示（约定 + 示例）

### 4.1 定位与边界

- **定位**：找出没有被现有验收测试执行到的**可执行改动**，作为风险提示，写入改动摘要/审查材料。
- **不承担**：防止无关重构；被执行到 ≠ 有断言，也不等于改动必要；无关重构同样可能被完全覆盖。
- **实现归属**：项目提供检查脚本（本仓库提供 Node/Java 示例），**赫菲不解析覆盖率**；
  默认只提示，是否作为必需检查由项目决定。

### 4.2 项目侧约定

1. 项目在测试后生成覆盖率数据（istanbul/nyc JSON 或 JaCoCo XML），用示例脚本与 `git diff --unified=0`
   求交，输出 §5 格式 JSON；
2. 将 JSON 附到 PR/审查材料（或作为非必需的 `verification.checks` 项，先测误报）；
3. 不把覆盖率提示当作测试有效性证明，也不把“行被执行”当作“行为有断言”；
4. 提示脚本失败（工具/输入错误）必须显式失败；不得默认“无提示=已覆盖”。

示例：

- `hephi/examples/coverage-node/`（istanbul/nyc JSON + git diff；`--self-test` 已实测）
- `hephi/examples/coverage-java/`（JaCoCo XML + git diff；`--self-test` 已实测）

### 4.3 赫菲侧（待实现）

- 赫菲**不解析**覆盖率 JSON/XML；未来如需汇总，应把项目提供的 JSON 作为**不透明提示附件**
  （记录引用 path + sha256，不解释内容），默认只在摘要/决策日志中展示，不作为 ready 条件；
- 具体字段与展示位置待实现，本文不承诺行为。

## 5. 覆盖提示输出格式（约定）

项目脚本输出一个 JSON 对象（UTF-8、稳定键、无绝对路径）；Node/Java 示例均按此格式：

```json
{
  "schemaVersion": 1,
  "kind": "coverage-hint",
  "tool": { "name": "coverage-hint-node-example", "version": "0.1.0" },
  "generatedAt": "2026-11-07T00:00:00.000Z",
  "baseSha": "<40hex|null>",
  "headSha": "<40hex|null>",
  "changedFiles": 4,
  "uncovered": [
    { "path": "src/a.mjs", "lines": [4], "reason": "statement not executed by tests" },
    { "path": "src/b.mjs", "lines": [2], "reason": "no coverage entry; executable status unknown" }
  ],
  "summary": { "changedFiles": 4, "uncoveredFiles": 2, "uncoveredLines": 2 }
}
```

约定：

- `path` 必须是仓库相对路径；`lines` 为 **base 之后新文件行号**（升序、去重）；
- `reason` 是自由文本短句，说明“为什么是提示”（未执行/无覆盖率条目）；
- `uncovered` 为空表示**没有提示**，不表示改动已验证；
- 退出码：`0`=分析完成（无论是否有提示）；`1`=输入格式错误；`2`=用法/环境错误；
- 不写仓库文件（除显式 `--out`）；不包含 token/凭据/绝对路径；
- 该 JSON 是**提示**，不是赫菲合同/ready 证据，不能替代检查记录。

## 6. C4.2 变更计划（optional / requirePlan 启用后 fail-closed）

状态：**机制级已实现（2026-11-07）；默认未启用，不得表述为“强制拦截 / 已生效”。**

### 6.1 字段

- `verification.requirePlan?: boolean`：additive 字段，随 `verification` 一起冻结进合同哈希；
  **无需升级合同版本**（与 `environment` 同机制）。默认 `false`/缺省。
- 计划本身仍是 `plan.jsonl`（按版本追加、绑定 contractHash；`$HEPHI_STATE_DIR/hephi/<ticket>/plan.jsonl`）。

### 6.2 默认（`requirePlan` 未启用）：C4.2 是 optional

- `hephi_plan` 在 enforce/native/staged、合同有效且存在冻结任务卡时可用，用于按版本追加计划；
- 没有当前 `contractHash` 的计划时，write/edit 与 ready **都不做计划拦截**（允许无计划）；
- **已知绕过（PR25-M1）**：Worker 可以选择不声明计划，因此“计划外编辑”不会被拦截；
  文档、bundle 与验收记录不得把默认状态写成“已强制拦截”。

### 6.3 `requirePlan=true`：fail-closed

- `hephi_plan` 在合同有效（非 shadow）时**始终注册**（即使没有任务卡，否则 fail-closed 会自锁）；
- write/edit：当前 `contractHash` 无计划 → 拒绝，理由/决策日志 rule `plan.not-declared`；
  有计划但目标不在计划内（精确路径或 glob）→ 拒绝 `plan.outside-plan`；
- ready：无当前合同计划 → 拒绝 `plan.not-declared`；有计划 → 既有最终 diff 复核（越界为 `plan.outside-plan`）；
- shadow：不注册工具、不实际拒绝，只记录 wouldDecision（`plan.recorded` / `plan.outside-plan` / `plan.not-declared`）；
- 合同生命周期（T11）：同一 ticket 的 re-prepare **复用**既有合同（`contractHash` 不变、不覆盖
  `activation.json`），旧计划继续有效，不得把 re-prepare 当作换合同；只有新 ticket（或人工移除合同后重新激活）
  才产生新合同。新合同下旧计划不生效、需重新声明；`requirePlan=true` 且未声明时 write/edit 与 ready 均拒绝；
- 与 C1 共存：判定顺序 scope → plan → C1，拒绝原因可区分。

### 6.4 审计规则（已在 `decisions-format.md` 登记）

`plan.recorded`（追加/拒绝记录）、`plan.outside-plan`（计划外或计划日志不可读）、
`plan.not-declared`（`requirePlan=true` 但当前合同无计划）已登记在 `decisions-format.md`；
`version`/字段不变，仅新增规则编号。

### 6.5 验收边界

机制级 + 单测（`tests/control/plan-tool.test.ts`、`tests/control/plan.test.ts`）；
未在真实宿主或多项目任务上验证；**默认未启用时不得声称 C4.2 已生效**。

## 7. 待实现项与负责人决策

| 项 | 状态 | 需要谁 |
| --- | --- | --- |
| C4.6 离线/锁版本校验 | **已实现**：`check-task` 任务级 + 插件 prepare（`environment.offline` 时 lockfile 存在性 + 联网命令扫描）；运行时隔离与真实项目验证待做 | 负责人确认字段/白名单口径（`npm ci` 是否算离线） |
| C4.8 聚焦检查提示规则（`lint-task` focus） | **已实现（仅提示，exit 不变）**；阈值/规则调优与真实任务验证待做 | 负责人确认规则与阈值 |
| C1 `protectedAssets` / `authorizes` / 优先级 | **已实现**（合同 v4/任务卡 v2；P1-5 优先级） | 负责人确认字段命名与启用判据（C 线需 B5 数据） |
| C1 决策日志新规则登记 | **已实现**（`asset.authorized`/`asset.modified`/`asset.unauthorized-*`） | 与 `decisions-format.md` 已同步 |
| C4.2 变更计划（`verification.requirePlan`） | **机制级已实现**：默认 optional；`requirePlan=true` 时 write/edit 与 ready fail-closed（`plan.not-declared`）；规则已登记 | 负责人确认默认值/启用判据与误拦率（需 B5 数据） |
| C2 赫菲侧提示附件展示 | 待实现（可选） | 负责人确认展示位置与是否只记录 |
| 示例脚本生产化（大型报告、source map、多模块） | 项目侧 | 各项目自行集成 |

> C1/C4.2/C4.6/C4.8 的机制级实现已落地（见上表）；C2 与运行时网络隔离仍为提议/待实现。
> **C4.2 默认未启用（optional），不得写成已强制拦截**。当前插件行为仍以 `hephi/README.md` 与
> `hephi/src/` 为准，不得把本文当已实现规则使用。

## 8. A2 项目验收检查配置示例（acceptance / regression；T08 schema 部分）

状态：**schema 已支持（本轮，机制级）**；`assertionFailureTypes` 目前只被校验并随 `verification`
冻结进合同哈希，**没有任何判定逻辑消费它**——T18 才用它做离线红态判定；真实项目实例部署与端到端验收
留待 T15/T20。旧配置（无该字段）解析结果与改动前逐字节一致，未知字段仍按 `.strict()` 拒绝。

### 8.1 字段

- `verification.checks[].assertionFailureTypes?: string[]`（可选，additive；verification 格式仍为 `version: 1`，无需升版）：
  该检查判定“断言失败”时认可的失败类型清单（每个元素 trim 后非空），供 T18 离线红态判定使用。
  不写该字段时行为与历史完全一致；写了也只影响 T18 的判定口径，不改变检查退出码或 ready 结论。

### 8.2 示例（项目检查配置，`HEPHI_VERIFICATION_FILE` 指向的文件）

说明：下面用 `jsonc` 展示以便写注释；真实配置文件必须是**严格 JSON**（注释需删除）。
配置来源用 `HEPHI_VERIFICATION_FILE`（不能与 `HEPHI_VERIFICATION_CHECKS` 同时设置），prepare 时冻结进合同。
两个检查都 `kind: "test"` 且 `required: true`：验收只认 test 类检查，required 是 ready 核验的前提。

```jsonc
{
  "version": 1,
  // 实验合同统一要求（不在本文件生效，是 prepare 时的环境变量）：
  //   HEPHI_REQUIRE_PULL_REQUEST=1 → 合同 requirePullRequest:true，
  //   ready 前必须有 PR 且 PR 的 base/head 与冻结合同一致；A2 实验会话一律按此准备。
  "checks": [
    {
      "id": "acceptance",
      "kind": "test",
      "purpose": "只跑 acceptance/ 目录的验收测试；JUnit 报告写到本次运行目录",
      "command": "sh",
      "args": [
        "-c",
        "pnpm vitest run tests/acceptance --reporter=junit --outputFile=\"$HEPHI_RUN_DIR/junit.xml\""
      ],
      "cwd": ".",
      "required": true,
      "timeoutMs": 900000,
      // T18 离线红态判定认可的失败类型（T08 仅接受并冻结该字段，尚未消费）
      "assertionFailureTypes": ["AssertionError"]
    },
    {
      "id": "regression",
      "kind": "test",
      "purpose": "整套回归；显式排除 acceptance/，避免与 acceptance 检查重复计数",
      "command": "sh",
      "args": [
        "-c",
        "pnpm vitest run tests --exclude 'tests/acceptance/**'"
      ],
      "cwd": ".",
      "required": true,
      "timeoutMs": 1800000,
      "assertionFailureTypes": ["AssertionError"]
    }
  ]
}
```

### 8.3 写法要点

1. **独立验收检查只跑 `acceptance/`**：`acceptance` 检查的范围就是 `tests/acceptance/`，不要在其中混跑
   其他目录的测试（其他模块用各自的聚焦检查或整包回归）。
2. **回归检查排除 `acceptance/`**：`regression` 用 `--exclude 'tests/acceptance/**'` 显式排除，
   保证同一测试不在两个检查里重复计数；回归仍必须覆盖 acceptance 以外的全部测试。
3. **JUnit 报告位置**：`$HEPHI_RUN_DIR/junit.xml`。`HEPHI_RUN_DIR` 由 check-runner 在每次
   `hephi_check` 运行时导出，指向 `<stateDir>/hephi/<ticketId>/checks/<runId>`；检查命令以**单条 argv**
   启动，因此 `$HEPHI_RUN_DIR` 必须写在 `sh -c` 的 payload 里才会展开（示例已按此写）。
   插件不解析 JUnit 报告（见 `stage-control.md`），报告由项目侧/后续实例侧读取。
4. **两个检查都 `required: true` 且 `kind: "test"`**：`build` 类检查不能充当验收项；
   `required` 决定 ready 是否核验该检查。
5. **`assertionFailureTypes`**：示例值 `["AssertionError"]`；按项目测试框架实际抛出的失败类型填写
   （如 pytest 的 `AssertionError`、JUnit 的 `java.lang.AssertionError` 等），多个用数组。
   T18 实现之前该字段不会被任何逻辑使用，不得据此声称“红态已可判定”。
6. **实验合同 `requirePullRequest: true`**：prepare 时设 `HEPHI_REQUIRE_PULL_REQUEST=1`（示例注释已标明），
   这是 A2 实验会话的统一要求，与本节两个检查一起构成验收前置；缺 PR 或 PR base/head 不匹配会在 ready 被拒。
7. 该配置由 prepare 冻结进合同并纳入 `contractHash`；T11 下同 ticket 的 re-prepare 复用既有合同，
   修改检查配置不会自动生效，需要新合同（新 ticket，或人工移除合同后重新 prepare）。
