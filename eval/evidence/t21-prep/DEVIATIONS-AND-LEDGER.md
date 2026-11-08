# T21 偏差登记与成本台账 v2（外部审查第二轮整改）

替代 v1（同文件旧版）。依据：REVIEW.md（hephi-e57deda-review，2026-11-09）F1–F5。

## 1. 对照对象错误（F1a，实质修复）

**问题**：T21 应比较"原系统 vs 本方案整包"，v1.0 误沿旧 B5 的"off vs native"分组。
**修复**：PREREG 升 **v1.1**（本次提交），§1 Q1 分组定义为：
- 原系统 = T01 冻结制品：SA `6d24e1b`+`62d7d53`+原配置（g1-ctl 型实例）；
- 整包 = SA `d0e64d6` + hephi `055491d` + G1 配置（B/g1-exp 型实例）。
off/native 术语仅保留于 D-9 投递机制描述。新锁 preregSha256 `b0c801f3…`（forced 重写留痕）。

## 2. 非同批次（F1b，保留为运行前检查项）

D-9 的 native 侧为既有投递只读读取，非同批。正式首轮执行时同批投递并复验
taskCard.sha256（不变）。

## 3. D-9 "4 次 API" 口径更正

v1 台账沿用了 env-r5 的"共 4 次"——该数字只统计**显式**调用；3093 实例轮询器在
6 分钟窗口内还消耗了数量未知的额外配额。正确口径：显式 4 次 + 轮询消耗未计量。
原 `d9-consistency-20261108T1605Z.md` 中的"4 次"表述以本节为准更正。

## 4. 成本台账（F5，如实：零信息，不虚构）

- D-9 off Worker 历史运行（PR #16）：**无实测 token/费用数据**（实例 state 随窗口清理，
  不可恢复）。记 `unknown`；不设任何"上界"（3M 是预注册单次停止阈值，不是消耗证据，
  不得换算为人民币预留）。
- 预算状态：100 元门槛的放行条件 = 拿到 provider 实际计费/usage 数据并独立核验；
  当前不具备放行条件。新增付费调用前必须先建立 usage 采集。

## 5. 任务清单（F2，已修）

`taskset-manifest-v1.1.json`：绑定 v1.1 锁哈希；角色分类 q1-retention 23 /
q1-devexposed-original 4 / non-q1-tooling 12 / staged-only-q3 1；**23 是合格保留集候选数，
不是 67 配对数**。validationOk null 的卡未擅改 true，行为验证见 §7。

## 6. 统计参数（F3，已修）

`report.py`：seed 20261108、min_pairs 67、token 中位/P90 上限 **1000000/2000000**。
总费用门槛不由 report.py 实现（PREREG §9 声明：CLI 显式参数 + 独立成本台账双重核验）。
自测环境（可复现）：`/Users/zm/repos/hephi-dev-base/.venv/bin/python`（Python 3.14.2，
numpy 2.3.4 / scipy 1.16.2 / statsmodels 0.14.5，按 `eval/stats/requirements.txt` 安装），
原始输出：`report-selftest-venv-raw.txt`（exit 0，SELF-TEST: PASS）。
系统 python3 缺依赖时 exit 2 属预期（依赖未随系统安装）。

## 7. 行为覆盖（F4，修复中）

- 弱断言卡（415 文本存在性 / 播种函数仅 callable / SQL 字符串计数 / dotenv stub）：
  本轮定向加强为行为断言并重跑 full-mode（见随后提交的各卡 validation.json）。
- q1-retention 23 卡 full-mode 行为验证（base 3×失败 + reference 3×通过）：结果随提交更新。
  此前 40/40 dry-run 仅结构检查，不作为行为验证结论（v1 表述作废）。
