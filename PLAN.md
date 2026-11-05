# 赫菲改造方案：把交付纪律提升到 90 分

> **修订说明（[Issue #1](https://github.com/paxxie2/super-agent-hephi-review/issues/1)）**：本方案中的以下设计已撤回，代码以 `hephi/README.md` 为准：
> - 验收项必须“HEAD 通过、base 失败”的双 worktree 证明、冻结测试（`hephi-test`）和 `proofLinks`。它会把缺模块等错误当作复现，并拒绝行为保持的改动。
> - 纯格式化和重命名检查。忽略空白的 diff 不是语义比较（Python 缩进），重命名和行数也不能识别无关重构。
> - 默认强制的改动预算。现在只在 Issue 作者写明时生效。
>
> 下文的 84 分和 90～92 分是测试数和自评，不是真实宿主或端到端证据，不能作为效果结论。

本方案对应 [`REPORT.md`](REPORT.md) 的评估（改造前 40 分）。方案已在本仓库的 `hephi/` 中实现，并通过测试验证；`hephi/` 的第一个提交是原始快照 `8e68ec2` 的原样导入，之后的提交就是全部改动。

## 1. 结论

| 阶段 | 分数 | 依据 |
| --- | --- | --- |
| 改造前 | 40 | `REPORT.md` |
| 本地实现并验证后（现在） | **84** | 140 个测试全过，其中 19 个新测试把原来“通过”的违规场景变成“拒绝” |
| 宿主核对两个接口 + 对照实验达标后 | **90～92** | 见第 5、6 节 |

**只靠代码到不了 90。** 评分里“效果证据”占 10 分，这一项只能由真实模型在真实宿主上的开、关对照实验给出。我在这里能做到的是：把机制做到位并证明它拦得住，再把对照实验的工具和判定标准准备好。对照实验需要在你的 DSH 宿主上跑。

## 2. 问题与对应机制

改造前，探针证明了四类违规都能通过 ready。改造后的对应关系：

| 改造前能通过的违规 | 新机制 | 改造后结果 | 对应测试 |
| --- | --- | --- | --- |
| 修 1 个函数，顺带改 20 个无关文件 | ① 任务卡 + 按验收项限定范围 | check 和 ready 都拒绝 | `the earlier 21-file refactor is refused` |
| 范围给得宽时的大面积改写 | ③ 改动预算 | ready 拒绝 | `the budget still refuses a sweeping rewrite` |
| 纯格式化、重命名 | ③ 改动纪律 | ready 拒绝 | `formatting-only edits and renames are refused` |
| 不修需求，改别的 | ④ 验收证明（冻结测试，HEAD 通过、base 失败） | 验收项 blocked，ready 拒绝 | `not fixing total() is refused` |
| 删掉会失败的测试 | ③ 保护已有测试 | ready 拒绝 | `deleting an existing test is refused` |
| 写一个在 base 上也能通过的“假测试” | ④ base 必须失败 | 验收项 blocked | `a Worker test that already passes on base` |
| 手写检查记录 | ⑤ 证据与 Session 绑定 | ready 拒绝 | `a hand-written passing record is refused` |
| 长会话中忘记目标 | ② 目标常驻提示词 | 每轮都在系统提示词中 | `keeps the goal in the Worker prompt` |
| 直接编辑越界文件 | ② 实时写入守卫 | 当场拒绝 | 同上 |

## 3. 五个机制

### ① 任务卡：把“需求”写进合同

**问题。** 改造前，合同里只有仓库、base、项目级路径和检查命令，没有需求本身，所以 ready 无从判断“做的是不是要求的事”。

**做法。** Issue 正文中加一个 `hephi-task` 代码块，以及每个验收项对应的 `hephi-test` 代码块（冻结测试）。格式见 `hephi/README.md`。

- `goal`：一句话目标；`outOfScope`：明确不做的事。
- `acceptance[]`：每项包括 `id`、`text`、使用的检查 `check`、允许改动的 `paths`、Worker 测试的 `tests`。
- `budget`：`maxFiles`、`maxChangedLines`，必填。
- `allowRenames`、`allowFormatOnly`：默认都是 `false`。`protect`：禁止删除的路径，默认覆盖常见的测试路径。

**实现。** `src/contracts/task.ts` 负责解析和校验。`prepare` 把整张卡写进合同，合同哈希覆盖整张卡；冻结测试写到 `stateDir/hephi/<ticket>/frozen/`，不在 Worker 的检出目录里，合同中记录每个文件的 sha256。`prepare-dubbo.sh` 默认开启 `HEPHI_REQUIRE_TASK=1` 和 `HEPHI_REQUIRE_FROZEN_TEST=1`：没有任务卡或缺少冻结测试，就不创建合同。

**为什么有效。** 需求变成了机器可核对的对象。卡由人写、由 prepare 冻结，Worker 改不了；在挂载期间改合同会因为哈希不一致被拒绝（已有机制）。

### ② 按验收项限定范围 + 目标常驻提示词 + 实时写入守卫

- `src/control/discipline.ts` 中的 `inScope()` 判断一个文件能不能改：必须同时满足项目级 `HEPHI_ALLOWED_PATHS` 和某个验收项的 `paths`。check、staged 阶段结束、ready 三处统一使用它。
- `worker-mount.ts` 把目标、验收项、范围外事项和预算写进系统提示词。这一段每轮都会重新生成，所以长会话或上下文压缩之后目标仍然在。
- 对 `write`、`edit` 调用做实时守卫，越界路径当场拒绝，Worker 不必等到 ready 才发现，减少返工。通过 bash 写文件拦不住，但会在 check 和 ready 时被拒。

### ③ 改动纪律

`discipline.ts` 中的 `summarizeChanges()` 用 git 计算：

- 改动文件数、改动行数（`--numstat`，二进制文件按 1 行计）；
- 重命名或复制（`-M`）；
- 纯格式化文件（`git diff -w --ignore-blank-lines` 为空）；
- 被删除且匹配 `protect` 的文件。

ready 时任何一项超标都会拒绝，拒绝原因直接写成 Worker 下一步该做什么，例如“revert files outside the task scope: src/m05.js”。

### ④ 验收证明：冻结测试“HEAD 通过、base 失败”

`hephi_check("AC1")` 会在 `check-runner.ts` 中执行 `runAcceptance()`：

1. 核对冻结测试的哈希。
2. 在临时 worktree 中检出 HEAD，叠加冻结测试，运行该验收项的检查，**必须通过**。
3. 在临时 worktree 中检出 base，叠加冻结测试和 Worker 写的匹配测试，运行同一检查，**必须失败**。
4. 两次运行都走宿主的原生 bash 工具，各自有自己的调用 ID，结果写入证据记录（`baseExitCode`、`baseInnerCallId`、`proofFiles`）。

依赖目录（例如 `node_modules`）通过检查配置里的 `proofLinks` 以软链接接入临时 worktree，不需要重新安装。

**为什么有效。** “base 上失败”证明测试确实针对了这次改动；“冻结”保证 Worker 改不了验收标准。这是对付目标漂移的核心机制。

### ⑤ 证据与 Session 绑定

改造前，ready 只检查记录字段非空，手写一份记录就能通过。改造后，ready 会从宿主读取 Worker Session 的事件日志（`sessionQuery.readSession`），要求每条被采信的证据（包括验收证明的两次运行）都能找到对应的原生 bash 调用 ID。Session 日志由宿主写入，Worker 无法伪造。宿主读不到日志时一律拒绝（fail closed）；只有在核对事件格式期间，才可以设置 `HEPHI_REQUIRE_SESSION_BINDING=0` 临时关闭。

## 4. 评分对照

评分标准与 `REPORT.md` 相同。

| 维度 | 满分 | 改造前 | 现在 | 宿主核对 + 对照实验后 | 还缺什么 |
| --- | --- | --- | --- | --- | --- |
| 交付稳定性 | 25 | 18 | 22 | 23 | 需在宿主上确认内部 bash 调用确实写入 Session 事件 |
| 减少范围乱改 | 25 | 11 | 22 | 23 | 需确认宿主 `write`/`edit` 的参数名，实时守卫才真正生效 |
| 减少随意重构 | 20 | 3 | 17 | 17～18 | 预算内、允许文件内的语义重构仍拦不住 |
| 减少目标漂移 | 20 | 5 | 18 | 18 | 冻结测试的质量取决于写卡的人 |
| 效果证据 | 10 | 3 | 5 | 9～10 | 对照实验达到第 6 节的标准 |
| **合计** | **100** | **40** | **84** | **90～92** | |

“现在 84 分”的依据：每项机制都有测试证明它能拦住改造前能通过的违规（第 2 节），而且 Mutation 检查确认这些测试不是空转：临时关闭“改动纪律”和“base 必须失败”两个门后，正好有 6 个对应测试变红。

## 5. 落地步骤

每一步都只改现有的合同、检查和 ready 核验，不新增执行器、队列或第二条交付链路。

**第 0 步：宿主核对（必须先做，约 2 个小任务）。**

1. 用一个带任务卡的小 Issue 跑一遍，读取 Worker Session 事件，确认 `hephi_check` 内部发起的 bash 调用以 `tool/call`（`name: "bash"`，`callId` 等于记录中的 `innerCallId`）或带 `toolCallId` 的事件出现。如果格式不同，只需修改 `evidence-verifier.ts` 里的 `nativeBashCalls()`。核对期间可以设置 `HEPHI_REQUIRE_SESSION_BINDING=0`。
2. 确认宿主 `write`/`edit` 工具的路径参数名。实时守卫目前识别 `path`、`file_path`、`filePath`，识别不到时放行，越界改动仍会在 check 和 ready 时被拦住。
3. Skill 的改动按你们的流程单独审批（`skills/hephi-superagent-control/SKILL.md` 第 4、6 步）。

**第 1 步：小范围启用。** 只对带 `hephi/delivery` 标签的 Issue 生效（这是现有的门槛）。先挑 3～5 个真实小需求，由人写任务卡和冻结测试，观察 ready 被拒的原因是否合理、预算是否过紧。

**第 2 步：对照实验。** 见第 6 节。

**第 3 步：常态化。** 根据第 1、2 步的数据调整默认预算和 `protect`。考虑让模型起草任务卡和冻结测试，但必须由人确认后再打标签。确认这一步不能省，否则“需求”又回到了模型手里。

## 6. 对照实验（决定最后 5 分）

工具：`eval/ab-metrics.mjs`。输入是每次运行的仓库、base、head，以及人工标注的“应改文件”和隐藏测试；输出是逐次指标、分组均值和判定结果。已用合成数据验证（见第 8 节）。

| 项目 | 设计 |
| --- | --- |
| 任务集 | 8～10 个真实 Issue：小修复、跨文件功能、容易诱发“顺手重构”的任务、多轮追加需求，各 2～3 个 |
| 分组 | `off`（不启用赫菲）、`native`、`staged`；同一模型、同一 base commit，每组每题 3 次 |
| 隐藏测试 | 由人另写，不放进任务卡，用来衡量真实完成度，防止“只对冻结测试优化” |
| 记录 | 耗时、token、ready 被拒次数、人工盲评的漂移分（0～3） |
| 有效的判定 | 相对 `off` 组，范围外改动行数和无关重构（纯格式化 + 重命名）各下降 30% 以上，且隐藏测试通过率下降不超过 5 个百分点 |
| 加分条件 | 达到判定标准，“效果证据”给 9 分；同时人工漂移分也明显下降，给 10 分 |

## 7. 代价与副作用

| 代价 | 影响 | 缓解办法 |
| --- | --- | --- |
| 写任务卡和冻结测试 | 每个 Issue 多花人工时间 | 第 3 步由模型起草、人工确认；小需求的卡通常只有 10 行左右 |
| 验收证明要跑两次检查 | 验收阶段耗时约翻倍 | 给验收项单独配一个只跑 `tests/hephi/*` 的检查 ID；依赖通过 `proofLinks` 链接，不重新安装 |
| 预算或范围过紧 | 误拒合理改动 | 拒绝原因指出具体文件；Worker 按 Skill 要求报告 blocked，由人放宽卡后重新开票。第 1 步统计误拒率 |
| base 上失败的原因可能并不相关（例如模块缺失导致崩溃） | 会被当成“已证明” | 冻结测试由人写，断言具体行为；对照实验用隐藏测试兜底 |

## 8. 残余缺口（如实列出）

1. 在允许的文件内、预算之内的语义重构（例如把 `price.js` 整体改写成 40 行以内）拦不住。只有人工评审或更细的语义 diff 规则能处理。
2. 冻结测试写得弱，验收就弱。任务卡把责任从模型转移到了写卡的人身上，但没有消除它。
3. 关闭 `HEPHI_REQUIRE_FROZEN_TEST` 后，Worker 可以写一个只检测“某行有变化”的测试来自证。测试 `residual gap` 如实保留了这种情况，并断言它会被接受，以便日后有人修复时这个测试会提醒更新。
4. 通过 bash 写文件不会被实时拦截，只会在 check 和 ready 时被拒。
5. Session 绑定依赖宿主事件格式，必须完成第 0 步。

## 9. 验证记录

| 项目 | 结果 |
| --- | --- |
| `pnpm check`（默认并行） | 14 个测试文件、140 个测试全部通过，类型检查和构建通过 |
| 原有 121 个测试 | 全部通过，无回归 |
| 新增测试 | `tests/contracts/task.test.ts`（5 个），`tests/probes/effectiveness.test.ts`（14 个） |
| Mutation 检查 | 关闭改动纪律和“base 必须失败”后，正好 6 个对应测试失败，恢复后全部通过 |
| `prepare-dubbo.sh` 端到端 | 用 `gh` 桩和本地仓库验证：有效卡生成带冻结测试哈希的合同；无效卡不生成合同 |
| `eval/ab-metrics.mjs` | 合成数据：`off` 组检出 7 个范围外文件、4 个纯格式化文件、1 个删除的测试；`native` 组判定为有效 |
| 默认测试超时 | 由 20 秒调整为 60 秒。原先在 4 核机器上并行跑会有 5 个 git 密集型测试超时 |

改动规模：产品代码和脚本 11 个文件，新增 559 行、删除 120 行（其中 `check-runner.ts` 把原有的原生执行逻辑抽成一个函数，供普通检查和验收证明共用，行为不变）；测试约 330 行；评测脚本 95 行。

未做：没有运行 DSH 宿主和真实 GitHub 流程，也没有调用大模型。第 5 节第 0 步和第 6 节的对照实验需要在你的环境中完成。
