# Issue 模板：带 hephi-task 任务卡的交付请求（C5）

> 用途：Issue 作者用本模板写清目标、验收项、合法改动范围和检查引用，prepare 会把任务卡冻结进激活合同。
> 本文件是模板与写作建议，不是自动校验；`hephi lint-task` / `eval/check-task.mjs` 用于离线提示。

## 1. Issue 正文模板

```markdown
<一句话说明要修什么/做成什么，以及为什么>

## 背景与复现（修 bug 类任务必填）
- 现象/期望：
- 复现命令或最小步骤：
- 环境（版本/依赖锁）：

## 不在范围内
- <明确列出不该顺手改的文件/模块/重构>
- 不合并 PR；（可选）不改依赖、不改检查配置、不改 CI

## 验收方式
- 每个验收项对应一个项目已有检查（优先 `project-regression` 或专门的 test check）。

```hephi-task
{
  "version": 1,
  "goal": "<一句话目标，可核对>",
  "outOfScope": [
    "不得修改其他文件、配置、测试或 Skill",
    "不得合并 PR",
    "失败如实报告 blocked，不绕过检查"
  ],
  "acceptance": [
    {
      "id": "AC1",
      "text": "<可机械核对的验收断言>",
      "check": "project-regression",
      "paths": ["path/to/file", "path/to/other"]
    }
  ]
}
```
```

## 2. 任务卡写法（hephi-task 块）

- `version`：支持 1/2/3——1 为基础任务卡；2 增加受保护验收资产授权（`authorizes`/`protectedAssets`）；3 增加必填 `kind`、必填 `outOfScope` 和验收项 `tests`/`cases`（示例见 §6）。
- `goal`：一句可核对的目标；不要写"优化一下"这类不可验收的话。
- `acceptance[]`：每项含
  - `id`：稳定标识（如 AC1）；
  - `text`：可机械核对（哪个文件、什么行为、哪个测试通过）；
  - `check`：项目已有检查 id（优先 test 类）；
  - `paths`：该验收项需要改动的**精确文件或目录 glob**；所有最终改动必须落在某个验收项的 paths 内。
- `outOfScope`：明确列出禁止顺带做的事（其他模块、无关重构、格式化、依赖升级、检查配置）。
- 受保护测试：若必须修改/删除已有测试，用 version 2 的 `authorizes` 精确列出"文件+操作"（modify/delete/migrate），不要扩大 `allowedPaths`。

## 3. 拆分建议（C4.7 / C5）

- 一个 Issue 只做一件事；验收项建议 1–5 个，超过 8 个时用 `hephi lint-task` 的提示拆小。
- 不要在一个 Issue 里同时做"修 bug + 重构 + 新功能"；行为保持型重构单独开 Issue。
- 每个验收项都应该能被一个检查覆盖；整套回归作为 required check 最后跑一次（C4.8）。

## 4. 合法范围写法

- `paths` 只列真正需要改的文件/目录；不要用 `**` 当默认。
- 配套修改（调用点、类型、导入）要列进对应验收项的 paths，否则会被范围检查拒绝。
- 范围越宽，ready 阶段的越界复核越弱；能精确就不要宽。

## 5. 提交前自查

1. 任务卡能被解析：`hephi lint-task <bundle.json>`（或 `eval/check-task.mjs <task-dir> --dry-run`）。
2. 每个 acceptance 的 `check` 存在且为 test 类（构建类不能当验收）。
3. 每个 paths 都在合同 allowedPaths 内；没有受保护测试的未授权修改。
4. 失败时报告 blocked 的固定格式：卡住的验收项、每次改了什么、输出要点、判断原因、需要谁决定什么。

## 6. 任务卡 v3 示例（T13/T16）

v3 在 v1/v2 基础上新增以下要求：

- `kind`：**必填**，只能是 `code` / `refactor` / `doc`，用来区分"改代码 / 行为保持型重构 / 只改文档"；
- `outOfScope`：**必填**，不再默认空数组；
- 每个 `acceptance[]` 项可写 `tests`（相对路径数组，**`kind` 为 `code` 时每个验收项都必填**）和 `cases`（用例名数组，可选）。

v1/v2 卡不接受 `kind`/`tests`/`cases`（会被拒绝）；已有 v1 示例见 §1。

### 6.1 代码缺陷修复（kind: code）

```hephi-task
{
  "version": 3,
  "kind": "code",
  "goal": "total() 返回两个参数之和（当前错误地返回差）",
  "outOfScope": [
    "不得修改 pricing 规则、模块布局或其他文件",
    "不得合并 PR；失败如实报告 blocked，不绕过检查"
  ],
  "acceptance": [
    {
      "id": "AC1",
      "text": "total(2, 3) 返回 5，project-regression 通过",
      "check": "project-regression",
      "paths": ["src/price.js"],
      "tests": ["tests/price.test.js"],
      "cases": ["两个正数相加", "含零的输入"]
    }
  ]
}
```

### 6.2 行为保持型重构（kind: refactor）

```hephi-task
{
  "version": 3,
  "kind": "refactor",
  "goal": "把 total() 的求和逻辑提取为私有函数，不改变对外行为",
  "outOfScope": [
    "不改变 total() 的返回值、异常与函数签名",
    "不修改测试或其他文件"
  ],
  "acceptance": [
    {
      "id": "AC1",
      "text": "现有测试全绿，total() 对相同输入的结果与重构前一致",
      "check": "project-regression",
      "paths": ["src/price.js"]
    }
  ]
}
```

> 说明：`refactor`/`doc` 的验收项不强制 `tests`；只有在需要点名具体用例时才写 `tests`/`cases`。所有路径都是相对仓库根的路径，不使用绝对路径或 `..`。
