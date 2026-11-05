# Super Agent + HEPHI 源码与升级方案

本仓库评估并改造 Super Agent 的赫菲（HEPHI）插件，目标是提升大模型交付需求的稳定性，减少目标漂移、范围随意修改和随意重构。

- [`REPORT.md`](REPORT.md)：改造前的评估（40 分）以及依据。
- [`PLAN.md`](PLAN.md)：第一版改造方案。其中部分设计已按 [Issue #1](https://github.com/paxxie2/super-agent-hephi-review/issues/1) 撤回，文中的 84 分和 90～92 分不是实测结论（见文件开头的修订说明）。
- [`ROADMAP-95.md`](ROADMAP-95.md)：评分提升路线（修订版）：统一评分表和一票否决条件（按新表初评约 26 分）、已核实的缺陷，以及能力可靠性、效果评估、能力增强三条工作线。
- [`ROADMAP-95-PREREQUISITES.md`](ROADMAP-95-PREREQUISITES.md)：实施上述路线之前必须具备的前置条件、两个关口和分组的出口清单。
- [`hephi/`](hephi/)：改造后的插件。第一个相关提交是快照 `8e68ec2` 的原样导入，之后的提交就是全部改动。
- [`eval/ab-metrics.mjs`](eval/ab-metrics.mjs)：开、关赫菲对照实验的**描述性**测量与汇总脚本。它只从 Git 提取机械指标并计算各分组均值，不判断插件是否有效，也不把格式化、重命名等同于无关重构。
- [`probes/`](probes/)：改造前用于证明缺口的探针测试，需放进原始快照中运行（见 `REPORT.md` 第 8 节）。

## 运行

需要 Node.js 22.19 或更高版本，以及 pnpm。

```bash
cd hephi
pnpm install --frozen-lockfile
pnpm check        # 类型检查、测试、构建；以实际运行输出为准
```

对照实验：

```bash
node eval/ab-metrics.mjs runs.json
```

`runs.json` 的格式写在脚本开头的注释里。

- `expectedFiles` 必须来自按需求审定的合法范围，不能用参考修复的文件列表代替。
- `hiddenPass` / `hiddenPassRate` 只表示配置的隐藏测试命令是否运行成功，不代表功能完整实现、真实交付或非劣效成立。
- `humanDriftScore` 是输入提供的人工值，脚本不自行推导。

输出与兼容影响：脚本输出 `{ rows, arms }`。本轮删除了行级 `formatOnlyFiles`、`renames`，组汇总 `unrelatedRefactor`，以及整个结论段 `verdict`（含 `outsideLinesDrop`、`unrelatedRefactorDrop`、`completionHeld`、`effective`）。仍读取这些旧字段的消费者需要同步调整；本仓库内没有其他代码引用该脚本的输出。`PLAN.md` 第 6 节中的“无关重构”和“判定结果”属于历史方案描述，本轮已从脚本移除，以本 README 和脚本为准。

回归测试：

```bash
node --test eval/ab-metrics.test.mjs
```

本轮只实施了 `ROADMAP-95.md` 中 B6 方向的最小部分：删除按格式化和重命名估算的伪语义指标，并停止自动输出效果判定。完整的 B6 统计方案（配对比较、置信区间、非劣效检验、盲评无关改动判定等）尚未实现；夹具测试只验证程序行为，不证明赫菲插件效果，也不构成真实业务端到端验收。

## main 分支审查入口与版本边界

本次合并保留原发布资料及 Cursor 分支的完整历史。最新方案来自 `b92c569`，最新赫菲实现来自 `a212d69`；95 分路线仍是待审方案，不代表已实施。

- **当前赫菲实现：[`hephi/`](hephi/)**。审查、安装和检查使用此目录。
- **Super Agent 源码：[`projects/super-agent/`](projects/super-agent/)**，发布快照基线为 `62d7d53723e5841eca5e02b151c1b48653650ea4`；[源码索引](projects/super-agent/knowledge-base/source-index.md) 基于较早版本，仅作导航。
- **历史赫菲快照：[`projects/hephi/`](projects/hephi/)**，版本 `8e68ec2`，仅保留作历史对照，不是当前实现。
- [原始发布清单](PUBLICATION-MANIFEST.json)、[版本资料](versions/projects.json)和[历史交付摘要](evidence-summary/issue-22-historical-result.md)只对应原始发布快照，不覆盖后来新增的 `hephi/` 和方案文档。

方案前置清单中“PR #2 尚未合并”和分支现状属于撰写时记录：PR #2 已合入评审分支，本次将修复及方案历史合入 main；其余方案内容保持原文供进一步审查。该合并没有部署插件、修改本地运行实例或执行新端到端测试，不能作为当前版本真实验收通过的证据。

源码快照中本机路径曾做脱敏替换，部署时须自行配置。未公开凭据、运行数据库和完整 Session。Super Agent 保留其 [MIT LICENSE](projects/super-agent/LICENSE)；其余文件遵循各自已有声明。
