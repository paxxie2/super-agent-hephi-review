# B2 执行中护栏机制验证报告（v5.4 B2.1）

- 分支：`agent/v54-batch2-20261112`，基线 `b4b74ad`
- 测试：`hephi/tests/control/b2-guardrails.test.ts`（7 条，全部通过）
- 日期：2026-11-12
- 执行人：test-worker

## 口径裁定（Lead 裁决，选项 b）

原任务卡所述「hephi_check 返回增量 diff 提示（check-runner changes 字段）」与「plan-tool.ts 宽度计数」在 b4b74ad **不存在**（经 grep 全文件核实：check-runner.ts 的 runCheck 返回无 changes/diff 字段；hephi/src/tools/plan-tool.ts 文件不存在，plan-store.ts PlanEntry 无 width）。两者为 v5.4 待实现项。按 Lead 裁决改为验证真实存在的相邻机制，断言仅针对真实字段。

## 验证内容（全部本地 fixture，无付费调用）

### ① 计划宽度：PlanSummary files 并集 + entries 计数（plan-store.ts readPlan/appendPlan）

- 两次 appendPlan（含重叠文件）→ readPlan 返回去重后的 files 并集（3 文件）与 entries=2 ✅
- 不同 contractHash 的 plan 不适用（per-contract 宽度）→ readPlan 返回 undefined ✅

### ② 增量改动感知：summarizeChanges（discipline.ts，真实 git diff）

- 临时 git repo：改 1 文件（-1 行）+ 增 1 文件（+3 行）+ 删 1 文件（-1 行）→ files=[3]、changedLines=5、added/deleted 各 1 ✅
- 基线处干净工作树 → 空汇总 {files:[], changedLines:0, deleted:[], added:[]} ✅

### ③ 合法不误拦

- in-scope 多文件（3 文件 120 行）无 budget → disciplineProblems=[] ✅
- 计划宽度比值可由两侧记录字段计算：plan.files.length=3 覆盖全部实际改动文件，比值 1 ✅
- 限内改动同时无 disciplineProblems 与 advisoryBudgetWarnings ✅

### 硬预算误拦（ADVISORY_BUDGET 只记录不拒 vs 显式 budget 硬拒）

已由 `hephi/tests/control/budget-advisory.test.ts` 9 条覆盖（commit 25795b8），本文件不重复。

## 自测证据

```
$ cd hephi && npx vitest run tests/control/b2-guardrails.test.ts
Test Files  1 passed (1)
     Tests  7 passed (7)            # exit 0

$ cd hephi && pnpm typecheck        # tsc --noEmit, exit 0
```

一次中间失败（如实记录）：首版 changedLines 断言写 7，实得 5。根因是测试自身的算术注释错误（src-a.js `a1\na2\n`→`a1\n` 是 -1 行而非 +1/-2），git 统计正确；修正断言为 5 后通过。非源码缺陷、非断言弱化。

## 局限

- 全部为本地单测/临时 git fixture 的机制验证，不证明真实宿主上的工具可见性或模型行为（与既有 plan-tool.test.ts 声明一致）。
- 「增量 diff 提示字段」「plan width 专用字段」确认为待实现项，本报告不含对它们的验证。
