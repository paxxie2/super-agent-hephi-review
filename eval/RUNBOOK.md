# B5 运行手册（RUNBOOK）— ROADMAP-95 工作线 B

状态：**v0.2（2026-11-09）· 供 review**。本手册规定第一轮对照实验（Q1：同一任务卡 原系统组 legacy-system vs 整包组 full-package，PREREG v1.2 口径）
的分组定义、任务卡投递、计划生成约束、运行记录、盲评与统计流程。

> 本版**没有执行任何真实运行**；所有宿主相关能力（drain 字段、hostVersion、实载 SHA 回读、P4 shadow）
> 均沿用 ROADMAP-95 现状核对与计划审查（`ROADMAP95-plan-review.md`）的“未验证/blocked”口径。
> 本手册不改变 R3.7 blocked 与 P8 部分完成的结论。

## 1. 名词与分组定义（统一口径；off/native 为旧 B5 历史值，新运行禁用）

| 名词 | 定义 | 记录字段 |
| --- | --- | --- |
| **native** | 挂载赫菲插件（enforce 模式），Issue 走 `hephi/delivery` → Ticket → Worker，产生合同与检查记录 | `arm=native` |
| **legacy-system（原系统组）** | 以 T01 冻结制品运行（HEPHI `6d24e1b` + SA `62d7d53` + 原配置，含旧赫菲），使用与整包组**逐字节相同**的任务卡 | `arm=legacy-system` |
| **staged** | 挂载赫菲且使用 staged 执行方式；**只用于 Q3 单独实验**、只用 `staged-suitable` 任务 | `arm=staged` |
| **shadow** | 执行机制，不是分组：Worker 完全不受影响，同时按同一套规则记录违规（P4）。**只允许 `arm=off` + `executionMode=shadow`** | `executionMode=shadow` |

硬性规则：

1. `arm` 是**分析分组**，`executionMode` 是**执行机制**；两者不得互相替代。
2. 原系统组严禁出现任何新制品（新插件 SHA/新提示/新配置）；出现即该运行无效（记录保留，标 `invalid`）。旧 B5 的"off 不挂赫菲"规则自 v1.2 废弃（原系统组合法包含旧赫菲）。
3. shadow 只有在 P4 影子模式经负责人确认可用后才可启用；不可用时 off 组按普通模式运行，
   `executionMode=normal`，并在报告中注明“未用 shadow，机械指标可能不同口径”。
4. 不得为了凑数把 staged 运行并入 native 分析。

## 2. 实验轮次与范围

- **第一轮（必做，Q1）**：同一任务集，legacy-system vs full-package；本手册只覆盖这一轮。
- Q2（普通需求 vs 任务卡需求，都不开赫菲）与 Q3（native vs staged）是**后续单独实验**，
  另行修订 RUNBOOK；只做过 Q1 时报告不得声称 Q2/Q3 已验证。
- 仓库/模型范围按 `eval/PREREG.md` §10 D-7 决定；**每个仓库/模型/类别分层分别估计样本量**，
  不用总数代替分层。

## 3. 前置条件（任一不满足则不得开跑）

| 前置 | 要求 | 现状 |
| --- | --- | --- |
| 任务集 | 所有任务通过 `node eval/check-task.mjs <task> --repo ... --base ...`（B2 双向 3 次一致） | 工具骨架已就绪（本目录），任务集待建 |
| PREREG | `eval/PREREG.md` 已锁定（数值、版本、seed、requirements、任务清单哈希） | **草稿，未锁定** |
| 统计环境 | `pip install -r eval/stats/requirements.txt`（固定版本）成功 | 骨架自测在隔离 venv 通过（见 §12） |
| 盲评准备 | 两名标注者、rubric 已校准（开发集 kappa ≥ 0.7） | rubric 骨架已就绪，标注者待定 |
| 宿主 | 实载版本回读/正式 hostVersion/排空字段语义等外部解阻项 | **未解阻**；R3.7 blocked。**不得把 R3.7/P8 当作已通过** |
| 环境隔离 | 全新检出目录 + 全新 Session；构建只在隔离克隆执行 | 运行纪律见 §6 |

> **P4 shadow 现状**：`hephi` 侧影子模式代码存在（P4），但 off 组要用 shadow 需要宿主配置与
> 负责人确认；未确认前 off 组按普通模式记录，机械指标口径差异写进报告。

## 4. 任务卡投递机制（**计划审查 P1-1，必须 review**）

### 4.1 统一任务卡（canonical task card）

- 每个任务的任务卡就是 `eval/tasks/<repo>/<taskId>/issue.md` 的**逐字节内容**。
- 运行时对任务卡计算 `sha256`，写入 `run.taskCard.sha256`；
  **off 组与 native 组必须使用同一个 sha256**（`taskCard.verifiedEqual=true`）。
- 任务卡中**不得**出现组别信息（“这是对照组/实验组”、分支名、赫菲字样）；
  导出盲评材料前 `eval/label/export.mjs` 会再次扫描并 fail-closed。

### 4.2 native 组投递

1. 以任务卡原文作为 Issue body 创建 Issue，打 `hephi/delivery` 标签；
2. 等 Trigger → Ticket → Worker，按赫菲合同流程运行；
3. 记录 Issue 编号/URL、`taskCard.sha256`、`deliveryMechanism=issue-body`、`verifiedEqual=true`。

### 4.3 off 组投递（本版方案：**固定 Trigger 文本注入同一任务卡**）

off 组不挂插件、不产生赫菲合同。为了让 Worker 收到的任务文本与 native 组**完全一致**，采用以下
两种等效机制（按宿主能力选一种，**默认 A**）：

**A. 同文 Issue body（首选）**

- 用与 native **完全相同的任务卡原文**创建 Issue（同一正文、同一标题前缀），**不打** `hephi/delivery`；
- 让该 Issue 走 Super Agent 的原生 Issue → Ticket → Worker 路径；
- 记录 `deliveryMechanism=issue-body`、`taskCard.sha256`（必须与 native 相同）。

**B. 固定 Trigger 文本注入（宿主要求显式 Trigger 时）**

- 若宿主必须先有一条 Trigger 评论才启动 Worker，则在该 Issue 中只发**一条**固定模板评论，
  正文为：

  ```text
  [ROADMAP95-B5-OFF run=<runId>]
  <issue.md 全文，逐字节复制，不做任何改写>
  ```

- 除该模板外**不得**添加任何说明/提示（尤其不得写“这是对照组/请比平时更谨慎”等改变行为的文字）；
- 记录 `deliveryMechanism=trigger-text`、`taskCard.sha256`；
- 复核者必须核对：native Issue body 的 sha256 == off Trigger 注入文本中任务卡部分的 sha256。

**C. task-file 注入（兜底，需负责人批准）**

- 仅当 A/B 都不可行时：把同一任务卡文件挂到 Worker 工作区（路径记录在 `taskCard.sourcePath`），
  并让 Worker 只读该文件作为任务来源；
- 记录 `deliveryMechanism=task-file`；必须人工核对文件 sha256 与 native 任务卡一致。

### 4.4 投递一致性校验（每次运行必做）

| 检查 | 方法 | 失败处理 |
| --- | --- | --- |
| 任务卡同文 | 两组的 `taskCard.sha256` 相等；`verifiedEqual=true` | 运行无效，不得进入效果分析 |
| 无组别痕迹 | 任务卡/注入文本扫描（“对照组/实验组/赫菲/hephi/分支名”） | 重做投递；不得带痕迹运行 |
| off 组无赫菲 | 检查该 Issue/Ticket 无 `hephi/delivery`、无合同、无检查记录 | 运行无效，记录原因 |
| 注入文本唯一 | off Issue 中除任务卡模板外无额外指令评论 | 运行无效 |

> **为什么不能“off 组直接人写一句简短需求”**：那会同时改变任务内容和需求表达，混淆 Q1 的
> 因果解释；P1-1 的核心就是保证两组的**唯一差异是是否挂载赫菲**。方案 B 的固定 Trigger 文本
> 必须由负责人 review 后方可使用（见 §11 D-2）。

## 5. 运行计划生成约束（B5）

生成计划时必须满足（正式实验前由负责人确认一份 `plan.json`）：

1. **固定种子**：`seed` 在 PREREG 中锁定并写入每一条运行记录；随机排序/重复抽样都用该种子，
   任何人不得事后更换。
2. **两组交错**：同一任务的 off 与 native 运行**相邻安排**；任务之间随机排序（用固定种子）；
   先 off 还是先 native 也由种子随机决定。禁止“先跑完所有 off 再跑 native”。
3. **20% 重复**：正式实验中随机抽 20% 的任务，每组各重复一次（`repetition=2`）；
   重复运行也必须邻近原运行（同一任务内），并报告重复一致性（见 §8）。
4. **试跑**：开发集每个任务每组跑 3 次（`repetition=1..3` 或独立批次），只用于估计波动与样本量，
   不进入正式结论；试跑计划与正式计划分开存档。
5. **全新环境**：每次运行使用全新检出目录 + 全新 Session；不得复用前一次运行的会话/工作区。
6. **两个组同一时间窗**：交错运行的目的就是避免模型服务/时间段只影响一组；若无法交错（例如宿主
   只能按组批量跑），必须在报告中说明并视为混杂因素。

计划文件示例（`<batch>/plan.json`，骨架约定）：

```json
{
  "batch": "pilot-01",
  "seed": 20261107,
  "preregVersion": "v0.1-locked",
  "taskSet": { "hidden-test-hash": "…", "taskCount": 12 },
  "order": [
    { "step": 1, "taskId": "dubbo-t01", "arm": "off", "repetition": 1 },
    { "step": 2, "taskId": "dubbo-t01", "arm": "native", "repetition": 1 },
    { "step": 3, "taskId": "ts-t02", "arm": "native", "repetition": 1 }
  ],
  "repeats": ["dubbo-t01"]
}
```

> 本版只定义约束与计划格式；**不提供**计划生成脚本（避免在骨架里固化尚未 review 的抽样策略）。
> 计划生成可在 B5 实施时补 `eval/b5-plan.mjs`，并用 `seed` 复现。

## 6. 运行记录与环境纪律

每次运行必须产出符合 `eval/schema/run.schema.json` 的记录（字段口径见 schema 注释）：

- 模型：实际 `model.id`、`provider`、`parameters`；宿主不支持的参数写 `uncontrolled`，不得假装固定；
- 宿主：`host.version` + `host.versionSource`（`approved`/`experimental`/`unavailable`）；
- 插件：候选/基线/实载 SHA；**实载 SHA 没有真实回读入口时写 `loadedShaReadback=unverified`**，
  磁盘哈希不得替代实载 commit（R3.7/R37 已确认）；
- 耗时：`startedAt`/`endedAt`/`wallClockSeconds`/`timeout`；
- token：`tokens.input/output/total`（读不到写 `null`）；
- 决策日志：`decisionLog.path`（+ 可选 `sha256`/`entries`）；
- B3 全部记录项：目标改变/功能实现/实现缺陷/环境可用/是否交付/越界/无关/测试削弱/人工介入；
- 任务卡：`taskCard.sha256`、`deliveryMechanism`、`verifiedEqual`。

环境纪律（**重要**）：

1. **禁止在宿主实载插件工作树里运行 `pnpm build`/`pnpm check`**（会改写实载 `lib/`，污染宿主；
   R3.7/R37 已发生并记录）。需要构建时在隔离克隆执行。
2. 真实宿主操作（部署/暂停/恢复）必须按 ROADMAP §4.5 的暂停/排空/恢复流程执行，且以 H0/H7
   探针通过为前提；本手册不重复宿主操作步骤。
3. 记录存放：`<batch>/runs/<runId>.json`（本机证据目录，按 P14 不提交生产数据）；批次结束导出
   `runs.json` 供统计与盲评。

## 7. 盲评流程（B4）

```sh
# 1) 导出材料（自动扫描并拒绝组别痕迹；映射写到材料目录之外）
node eval/label/export.mjs --manifest <batch>/export-manifest.json \
  --out <batch>/blind --mapping <private>/<batch>.mapping.json --seed <锁定 seed>

# 2) 两名标注者各自按 eval/label/RUBRIC.md 填写 labels.template.json → labels-<rater>.json

# 3) 读回并校验完整性（缺 case/枚举/必填 notes/positions 会 exit 1）
node eval/label/import.mjs --manifest <batch>/blind/manifest.json --labels <labels-rater-a>.json

# 4) 一致性（开发集校准 + 正式评分门槛 kappa>=0.7）
node eval/kappa.mjs --scores <rater-pair.json> --min 0.7
```

- 私有映射**只在盲评结束后**用于把 blindId 还原为 runId/arm（`import.mjs --mapping ... --normalized-out`）；
- 不得把映射放进材料目录（导出脚本会拒绝）；
- 分歧由裁决者判定，理由写入标注 `notes`；
- 盲评未完成或 kappa 不达标的批次不得进入正式结论。

## 8. 统计与报告（B6）

```sh
python3 -m venv .venv && .venv/bin/pip install -r eval/stats/requirements.txt
.venv/bin/python eval/stats/report.py --input <batch>/runs.json \
  --seed <锁定 seed> --noninferiority-margin -0.05 --min-pairs <PREREG> \
  --out <batch>/report.md
```

- 统计口径见 `eval/PREREG.md`；成本上限/非劣效界值/样本量是 PREREG 锁定值，**不得在报告里临时改**；
- 配对分析使用 `repetition=1`；重复运行只用于一致性报告；
- 分层（仓库/模型/类别）样本不足自动标“证据不足”；
- 环境不可用运行不计效果指标，但计入成本/稳定性并分组列出；
- 不可接受故障（V1–V3）触发停止规则，不得静默排除。

## 9. 失败与中止处理

| 情况 | 处理 |
| --- | --- |
| 环境不可用 | 记录原因、标 `validationEnvironment.status=unavailable`；运行不计效果，计成本/稳定性 |
| 任务卡不一致 / off 组出现赫菲 | 运行标无效，保留记录并在报告“排除”节列出原因 |
| 隐藏测试/参考修复失败（接入期） | 按 B2 分类（依赖/提取/环境/任务本身），保留原始失败并计入接入成本 |
| 宿主故障或恢复不安全 | 立即停止本批运行，按 PREREG §8 停止规则处理，保留现场 |
| 模型/宿主/插件版本变化 | 记录实际值；未记录的变化视为批次瑕疵，必要时作废该批 |

## 10. 复现与留档

- 一个实验包 = 任务集（taskId + 文件 sha256）+ RUNBOOK 版本 + PREREG 锁定版本 + 运行记录 + 盲评材料
  与标签 + 统计脚本与依赖版本 + `plan.json`（seed/顺序）+ 报告；
- 独立复现按 B7：从测试集随机抽子集重跑并盲评，判定“方向一致、CI 有重叠”，不要求达到原门槛；
- 复现报告由复现者撰写，原样收录。

## 11. 待 review / 负责人决策项

| # | 决策项 | 关联 |
| --- | --- | --- |
| D-1 | off 组投递方案 A/B/C 是否批准（默认 A；B 需 review 固定模板） | §4 |
| D-2 | 固定 Trigger 模板文本是否作为正式口径 | §4.3 |
| D-3 | P4 shadow 是否可用、off 组是否用 shadow | §1/§3 |
| D-4 | 计划生成脚本是否在 B5 实施（本版只定义约束） | §5 |
| D-5 | 运行记录/材料存放路径与是否入公开实验包 | §6/§10 |
| D-6 | `ab-metrics` 格式化/重命名估算的处置 | 见 completion 报告建议 |

## 12. 骨架自测（本版已实际执行，非真实实验）

```sh
# 在仓库根目录、Node v22.19.0 下：
node eval/check-task.mjs eval/tasks/example --dry-run
node eval/check-task.mjs --self-test
node eval/label/export.mjs --self-test
node eval/label/import.mjs --self-test
# 统计（隔离 venv，固定版本）：
.venv/bin/python eval/stats/report.py --self-test
```

以上自测只使用合成夹具/临时 git 仓库，**不访问真实宿主、不代表任何真实实验结论**。

## 13. B6 机械指标与 B5 计划生成器（2026-11-07 追加）

> 本节为**追加引用**，不修改 §1–§12 的既有约束与数值。对应 B6（ab-metrics 清理）与 B5
> （运行计划生成器）；D-4/D-6 仍待负责人 review（见 §11 / `eval/PREREG.md` §10）。

### 13.1 `eval/ab-metrics.mjs` 只提取机械指标

- 用法：`node eval/ab-metrics.mjs <runs.json>`；自测：`node eval/ab-metrics.mjs --self-test`。
- 只输出机械指标：变更文件数/行数、`outsideFiles`/`outsideLines`/`outsideShare`、`deletedTests`、
  `hiddenPass`（任务配置了 `hiddenTest` 时），以及运行记录里的 `minutes`/`tokens`/`readyDenials`/
  `humanDriftScore` 按 arm 的均值。
- **已删除**（不再输出）：`formatOnlyFiles`、`renames`、`unrelatedRefactor`、`verdict`（含
  `verdict.effective`）。理由：格式化/重命名/无关重构不能机械判定，且"是否有效"不是本脚本的结论。
- 无关改动、目标被改变、测试削弱、效果结论一律由 **B4 blind-review rubric + `eval/stats/report.py`**
  依据 `eval/schema/run.schema.json` 记录判定（同时关闭 PREREG D-6 中"是否删除"的实施项，
  仍待负责人确认）。
- 本脚本不访问真实宿主、不替代真实对照实验；`--self-test` 只在临时 git 仓库上验证机械口径。
- B8 日常使用统计的工单范围/去重键/状态映射仍以 B8 章节与预注册为准（计划审查 P2-6 的计数口径待负责人），
  本脚本只做单次运行的机械 diff 提取，不参与工单计数或效果判定。

### 13.2 `eval/b5-plan.mjs` 运行计划生成器

```sh
node eval/b5-plan.mjs --tasks <tasks.json> --seed <int> [--groups off,native] \
     [--repeat-fraction 0.2] (--out <plan.json> | --dry-run)
node eval/b5-plan.mjs --self-test
```

- `tasks.json` 格式（数组或 `{"tasks": [...]}`）：
  `{ "taskId": "dubbo-t01", "repo": "dubbo", "category": "defect-fix" }`；
  `taskId` 需匹配 `^[a-z0-9][a-z0-9._-]{1,63}$` 且唯一；`repo` 非空；`category` 取
  `defect-fix` / `new-feature` / `behavior-preserving-refactor` / `cross-module` / `staged-suitable`。
- 生成规则（B5 §5）：固定 `seed` 可复现（除 `generatedAt` 外逐字节一致）；任务按 taskId 排序后
  由 seed 随机排序；**同一任务的各分组运行相邻**、组顺序由 seed 随机决定（禁止整组批量先跑）；
  按 `round(repeatFraction × 任务数)` 抽取重复任务，每个重复任务**每组各多跑一次**
  （`repetition=2`、`repeat=true`），并与原运行相邻；默认 `repeatFraction=0.2`。
- 输出 `plan.json` 字段：`schemaVersion`/`generatedBy`/`generatedAt`/`seed`/`groups`/
  `repeatFraction`/`taskSet`/`repeats`/`order`/`summary`；`order` 每条含 `order`、`runId`、
  `taskId`、`repo`、`category`、`group`（同时给出 `arm`）、`repeat`、`repetition`、`seed`。
- 参数约束：未知参数/未知组/重复 taskId/非法 seed/非法 fraction/缺 `--out` 且非 `--dry-run` 均
  exit 2；`staged` 只用于 Q3 的 `native,staged` 单独实验，禁止与 `off` 混合。
- **本计划只是运行输入，不代表任何运行已完成**；seed、重复比例与样本量最终仍由 PREREG 锁定
  （`eval/PREREG.md` §9/§12，D-4 待负责人）；`plan.json` 随批次存档（§10）。

## 14. B3 运行记录工具 `eval/record-run.mjs`（2026-11-08 追加）

> 本节为**追加引用**，不修改 §1–§13 的既有约束与数值。工具只做“校验候选记录 + 原样落盘”，
> 不产生运行、不访问宿主、不代表任何真实实验结论；B3 运行记录字段口径见 §6 与
> `eval/schema/run.schema.json`。

### 14.1 用法

```sh
# 校验候选记录并写出（输出已存在时拒绝覆盖）
node eval/record-run.mjs --input <candidate.json> --out <record.json>
# 工具自测（B3-01..B3-05）
node eval/record-run.mjs --self-test
```

- 参数：`--input` 候选运行记录 JSON；`--out` 输出记录路径；`--self-test` 自测；`--help` 打印用法。
- 校验：按 `eval/schema/run.schema.json` 做最小严格校验，覆盖该 schema 实际使用的关键字：
  `required`、`type`、`enum`、`const`、`minimum`/`maximum`、`minLength`、`pattern`（40-hex/64-hex/
  shortId）、`format: date-time`、嵌套 `properties`/`required`/`additionalProperties`、
  `oneOf`、`allOf` 与 `if`/`then` 条件约束（shadow 只允许 off、`validationEnvironment.unavailable`
  必填 reason、`loadedShaReadback=verified` 必须有 40-hex `loadedSha`）。schema 若新增工具未覆盖的
  关键字，工具以 exit 2 失败，不会静默放宽。
- 语义：输入字段值原样写入（仅统一 JSON 序列化：2 空格缩进 + 末尾换行）；**不补默认值、不伪造
  token、不把 null 改写成 0**；不可得的 token 保持 `null`。
- 退出码：`0`=合法且已写入；`1`=数据不合法（stderr 逐条列出字段路径，且不写输出）；
  `2`=参数/IO/schema 错误（含输出已存在、父目录缺失、输入不可读/不是 JSON 文件）。
- 覆盖保护：输出已存在时**拒绝覆盖**（exit 2，既有文件不变）；写入使用同目录临时文件 +
  `rename` 原子替换，失败清理临时文件、不留半成品。

### 14.2 自测口径（本版实际执行，非真实实验）

```sh
node eval/record-run.mjs --self-test   # 26 条断言；全部在 mkdtemp 临时目录执行，不写仓库
```

- B3-01：完整合法记录 exit 0、输出与输入逐字段一致、无 tmp 残留；
- B3-02：逐项删除 30 个 required 字段，以及非法枚举/非 40-hex/负值/嵌套必填/条件约束/未知字段
  /非法 JSON 等 → exit 1 且指出字段路径、不产生输出；
- B3-03：nullable 字段原样保留（token 读不到保持 `null`，不补 0），省略的可选字段不被写回；
- B3-04：输出已存在拒绝覆盖；父目录缺失/父路径是文件/只读目录等 IO 错误 exit 2 且不留半成品；
- B3-05：由 `eval/tasks/hephi/b5-task-key-whitelist/`（`task.json`/`issue.md`）与
  `eval/evidence/checklist3/check-task-selftest.log` 的**真实 SHA/时间派生的夹具**，验证
  `taskCard.sha256`/`decisionLog.sha256`/`base` 等可回溯字段可复算。

> **未验证项（必须保留）**：B3-05 只是**派生夹具，不是正式实验记录**；本仓库目前**没有甲（A 侧）
> 交付的真实 run**，因此本工具及其自测不能证明任何正式实验记录或对照实验结论。与 §12 口径一致。

## 15. T03 部署前置三条规则（2026-11-08 追加）

> 本节为**追加规则**，不修改 §1–§14 的既有约束与数值。部署检查脚本 `scripts/deploy-check.sh`
> 只读核对下列前置；任一不满足则不得升级插件/部署。

1. **有 HEPHI 工单不升级插件**：`/orchestrator/api/tickets`（或探测到的可用 tickets 端点）中存在
   运行/等待/blocked/待修复的 HEPHI 工单时，不得升级插件或部署新版本；先清空未决工单。接口不可达
   时同样视为无法确认，按失败处理并记录 `FAIL:unreachable` 与 curl 退出码，不得猜测为空。
2. **本期不配置审批人**：`project-config/*.json` 中不得出现 `approvers` 配置；当前口径为不配置审批人
   （`eval/daily/APPEALS.md` 的人工复核流程另行约定，不代表审批人配置）。
3. **由人合并 PR**：Worker/Agent 不启用 auto-merge（提示中未命名具体 merge CLI 时由人合并每个 PR）；
   本期的 PR 合并由人执行，Agent 不得代合并、不得代批。
