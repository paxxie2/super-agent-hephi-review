#!/usr/bin/env python3
"""T08（v5.4）：最不利缺失补全已知答案验证（合成数据，不跑正式实验）。

构造 T08 指定的 10 父任务对输入：
  - 8 对可双侧评分（标签齐全），其中 1 对仅对照有无关改动（实验 unrelated=False、
    对照 unrelated=True），其余 7 对两臂均 unrelated=False；
  - 2 对“对照无（unrelated=False 已标注）、实验缺失（unrelated=None）”。

预期（最不利补全，D-11 未批准硬门口径）：
  - 有效已标注配对 = 8（补全不改变 LOCKED 判定与有效配对分母）；
  - 补全后实验组无关改动率 = 2/10（实验缺失按 unrelated=True 计）；
  - 补全后对照组无关改动率 = 1/10（仅既有那 1 对；对照缺失按 unrelated=False 计）。

用法：
    python eval/stats/t08_worst_case_test.py [--json]

退出码：0=全部断言通过；1=有断言失败。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import report  # noqa: E402
from b6_known_answers import BATCH, SEED, make_run  # noqa: E402  复用同一严格契约合成数据写法

TREATMENT = "native"
CONTROL = "off"


def build_runs() -> list:
    runs = []
    # 8 对标签齐全：t08 仅对照有无关改动，其余两臂均无。
    for index in range(1, 9):
        task = f"t{index:02d}"
        control_unrelated = index == 8
        runs.append(make_run(task, CONTROL, unrelated=control_unrelated))
        runs.append(make_run(task, TREATMENT, unrelated=False))
    # 2 对实验缺失（unrelated=None）：对照已标注为无（False）。
    for index in (9, 10):
        task = f"t{index:02d}"
        runs.append(make_run(task, CONTROL, unrelated=False))
        runs.append(make_run(task, TREATMENT, unrelated=None))
    return runs


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="T08 最不利缺失补全已知答案验证（合成数据）")
    parser.add_argument("--json", action="store_true", help="JSON 输出")
    args = parser.parse_args(argv)

    analyzed = report.analyze(build_runs(), {"seed": SEED, "n_boot": 500, "min_pairs": 5})
    counts = analyzed["counts"]
    worst = analyzed.get("worst_case_imputation")

    def check(ok: bool) -> bool:
        return ok is True

    steps = [
        {"id": "T08-1", "name": "输入结构：结构配对=10、标签不完整=2、有效已标注配对=8",
         "ok": check(counts["structural_pairs"] == 10 and counts["label_incomplete_pairs"] == 2 and counts["paired_tasks"] == 8),
         "detail": f"structural={counts['structural_pairs']} incomplete={counts['label_incomplete_pairs']} paired={counts['paired_tasks']}"},
        {"id": "T08-2", "name": "最不利补全段存在且口径标注为 D-11 未批准硬门",
         "ok": check(worst is not None and "D-11 未批准" in worst["note"] and "最不利补全为硬门口径" in worst["note"]),
         "detail": (worst or {}).get("note", "缺失 worst_case_imputation 段")},
        {"id": "T08-3", "name": "补全后实验组无关改动率 = 2/10（实验缺失计 unrelated=True）",
         "ok": check(worst is not None and worst["treatment_unrelated_count"] == 2 and worst["total_pairs"] == 10
                     and abs(worst["treatment_unrelated_rate"] - 0.2) < 1e-12),
         "detail": f"treatment={worst['treatment_unrelated_count']}/{worst['total_pairs']} rate={worst['treatment_unrelated_rate']}"},
        {"id": "T08-4", "name": "补全后对照组无关改动率 = 1/10（既有 1 对；对照缺失计 unrelated=False）",
         "ok": check(worst is not None and worst["control_unrelated_count"] == 1 and worst["total_pairs"] == 10
                     and abs(worst["control_unrelated_rate"] - 0.1) < 1e-12),
         "detail": f"control={worst['control_unrelated_count']}/{worst['total_pairs']} rate={worst['control_unrelated_rate']}"},
        {"id": "T08-5", "name": "补全明细：2 对实验缺失均补全为 treatment_unrelated=True",
         "ok": check(worst is not None and len(worst["imputed_details"]) == 2
                     and all(d["imputed"]["treatment_unrelated"] is True and d["imputed"]["control_unrelated"] is False
                             for d in worst["imputed_details"])),
         "detail": json.dumps(worst["imputed_details"], ensure_ascii=False)},
        {"id": "T08-6", "name": "并列敏感性不改变 LOCKED 判定路径（decision 键齐全、有效配对分母仍为 8）",
         "ok": check(all(k in analyzed["decision"] for k in ("meets_prereg", "conclusion", "note"))
                     and counts["paired_tasks"] == 8),
         "detail": f"conclusion={analyzed['decision']['conclusion']} paired={counts['paired_tasks']}"},
        {"id": "T08-7", "name": "markdown 渲染包含最不利补全并列段与 D-11 标注",
         "ok": check("最不利缺失补全" in report.render_markdown(analyzed, f"batch:{BATCH}")
                     and "D-11 未批准" in report.render_markdown(analyzed, f"batch:{BATCH}")),
         "detail": "render_markdown 含『最不利缺失补全』与『D-11 未批准』"},
    ]

    ok = all(step["ok"] for step in steps)
    if args.json:
        print(json.dumps({"t08WorstCase": ok, "steps": steps}, ensure_ascii=False, indent=2))
    else:
        for step in steps:
            print(f"{'PASS' if step['ok'] else 'FAIL'} [{step['id']}] {step['name']} :: {step['detail']}")
        print("T08-WORST-CASE: PASS" if ok else "T08-WORST-CASE: FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
