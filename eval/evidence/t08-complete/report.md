# T08 统计工具完整验证收尾报告（工具级）

- 日期：2026-11-12
- 仓库：/Users/zm/repos/hephi-review-main，分支 `agent/v54-batch2-20261112`，基线 HEAD=`b4b74ade505b8f605c9b9038259832fcdff3a7c0`
- 环境：`.venv/bin/python`（CPython 3.14.2；numpy 2.3.4 / scipy 1.16.2 / statsmodels 0.14.5）
- 执行人：impl-worker（task-27）

## 结论

**T08 统计工具完整验证通过（工具级）**：四条测试命令一次跑通，61 + 9 + 11 + 6 = 87 项断言全 PASS、0 FAIL、退出码全 0。

> 口径区分：本报告只证明**统计工具本身**（eval/stats/report.py 及其测试）在合成已知答案上行为正确。
> 它**不等于真实实验数据验证**——真实批次（B4 盲评、B6 正式运行）的结论仍以各自 evidence 目录与 LOCKED 判定为准；工具级通过不预支真实数据结论。

## 子项状态汇总

| 子项 | 测试载体 | 结果 | 覆盖内容 |
| --- | --- | --- | --- |
| 最不利缺失补全（B4/T08 主体） | eval/stats/t08_worst_case_test.py | **11/11 PASS**（exit 0） | T08 指定 10 对输入：补全后实验 2/10（rate=0.2）、对照 1/10（rate=0.1）；对照缺失补 False、双侧缺失、仅其他标签缺失保留已知值不覆盖；note 含「D-11 未批准，最不利补全为硬门口径」及覆盖范围/判定豁免声明；markdown 渲染含并列段 |
| base/head 不变性 | 同上（T08-11） | **PASS** | `git show 25795b8` 基线与当前 head 同输入 analyze，head 剔除 `worst_case_imputation` 键后逐字段 JSON 一致（identical=True，9052 bytes）——并列段不改变既有报告与 LOCKED 判定 |
| Q4 制品 SHA 正误两例 | eval/stats/t08_q4_sha_test.py | **6/6 PASS**（exit 0） | 正例：正确 SHA+可靠性满足+范围持平 → 冻结条件 16/16 ok、范围/可靠性两节分开报告、evidence_reasons 空、结论为达标判定（not_meets_prereg）；反例：错 SHA（回读 verified 的可核验矛盾）→ 运行 invalid、排除出配对（8→7）、结论 evidence_insufficient、不得 meets_prereg |
| B6 已知答案回归 | eval/stats/b6_known_answers.py | **9/9 PASS**（exit 0） | McNemar 精确 p、CI、非劣效、成本缺失≠0、环境不可用保留成本、同 seed 逐字节复算等（无回归） |
| report.py 自测 | eval/stats/report.py --self-test | **61 项 PASS / 0 FAIL**（exit 0） | F01-F16/S01-S07/R1-R9/N03-N05 全量自测（含 LOCKED 判定正反例、标签契约、冻结条件） |

## 命令原文、退出码与关键输出

均在 `/Users/zm/repos/hephi-review-main` 下执行。

### 1. report.py 自测

```
$ .venv/bin/python eval/stats/report.py --self-test
exit=0
（61 行 PASS / 0 行 FAIL，末行）SELF-TEST: PASS
```

### 2. B6 已知答案

```
$ .venv/bin/python eval/stats/b6_known_answers.py
exit=0
（9 行 PASS / 0 行 FAIL，末行）KNOWN-ANSWERS: PASS
```

### 3. T08 最不利补全（含 base/head 不变性）

```
$ .venv/bin/python eval/stats/t08_worst_case_test.py
exit=0
（11 行 PASS / 0 行 FAIL，末行）T08-WORST-CASE: PASS
PASS [T08-3] 补全后实验组无关改动率 = 2/10（实验缺失计 unrelated=True） :: treatment=2/10 rate=0.2
PASS [T08-4] 补全后对照组无关改动率 = 1/10（既有 1 对；对照缺失计 unrelated=False） :: control=1/10 rate=0.1
PASS [T08-11] base(25795b8)/head 同输入不变性：排除 worst_case_imputation 后逐字段一致 :: identical=True bytes=9052 head_has_worst_case=True conclusion=evidence_insufficient
```

### 4. T08/Q4 制品 SHA 正误两例

```
$ .venv/bin/python eval/stats/t08_q4_sha_test.py
exit=0
（6 行 PASS / 0 行 FAIL，末行）T08-Q4-SHA: PASS
PASS [Q4-4] 正例：证据链完整（evidence_reasons 为空，结论是达标判定 not_meets_prereg 而非证据不足） :: conclusion=not_meets_prereg reasons=[]
PASS [Q4-6] 反例：错制品 SHA 不能用于达标 → 结论 evidence_insufficient（不得 meets_prereg） :: conclusion=evidence_insufficient reasons=['冻结条件矛盾 1 条运行被标 invalid（保留成本，排除效果指标）']
```

## 工具级 vs 真实数据验证区分

- **本报告覆盖（工具级）**：合成已知答案与不变性比较，证明 report.py 的统计逻辑（含 T08 新增的最不利补全并列段与制品 SHA 冻结条件路径）自洽、可复算、不改 LOCKED 判定。
- **不在本报告范围（真实数据级）**：B4 真实盲评标签、B6 正式批次的 runs.json、真实 reviewer/kappa/成本数据；这些以各自 evidence 目录为准，且 LOCKED 判定（PREREG v1.3）只能由真实批次数据触发。
- D-11（缺失补全是否作为正式口径）仍未批准：worst_case_imputation 仅是并列敏感性段，正式执行口径待负责人确认。
