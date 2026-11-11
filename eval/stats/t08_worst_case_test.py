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
import importlib.util
import json
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent.parent
BASE_COMMIT = "25795b8"  # T08 之前的基线（task-18 改动前）

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


def _analyze(runs, min_pairs: int = 5) -> dict:
    return report.analyze(runs, {"seed": SEED, "n_boot": 500, "min_pairs": min_pairs})


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="T08 最不利缺失补全已知答案验证（合成数据）")
    parser.add_argument("--json", action="store_true", help="JSON 输出")
    args = parser.parse_args(argv)

    analyzed = _analyze(build_runs())
    counts = analyzed["counts"]
    worst = analyzed.get("worst_case_imputation")

    def check(ok: bool) -> bool:
        return ok is True

    # 附加用例（task-19）：对照 unrelated 缺失 → 补 False。
    control_missing_runs = [
        make_run("cm-01", CONTROL, unrelated=False),
        make_run("cm-01", TREATMENT, unrelated=False),
        make_run("cm-02", CONTROL, unrelated=False),
        make_run("cm-02", TREATMENT, unrelated=False),
        make_run("cm-03", CONTROL, unrelated=None),      # 对照缺失
        make_run("cm-03", TREATMENT, unrelated=True),    # 实验已知 True
    ]
    control_missing = _analyze(control_missing_runs)["worst_case_imputation"]

    # 附加用例（task-19）：双侧 unrelated 缺失 → 实验 True / 对照 False。
    both_missing_runs = [
        make_run("bm-01", CONTROL, unrelated=False),
        make_run("bm-01", TREATMENT, unrelated=False),
        make_run("bm-02", CONTROL, unrelated=None),
        make_run("bm-02", TREATMENT, unrelated=None),
    ]
    both_missing = _analyze(both_missing_runs)["worst_case_imputation"]

    # 附加用例（task-19）：仅其他标签缺失（defect_free 未标注）但 unrelated 已知 → 保留已知值不覆盖。
    other_missing_runs = [
        make_run("om-01", CONTROL, unrelated=False),
        make_run("om-01", TREATMENT, unrelated=False),
        make_run("om-02", CONTROL, unrelated=False),                        # 对照标签齐全
        make_run("om-02", TREATMENT, unrelated=True, defect="unlabeled"),   # defect_free 缺失、unrelated 已知 True
    ]
    other_missing = _analyze(other_missing_runs)["worst_case_imputation"]

    steps = [
        {"id": "T08-1", "name": "输入结构：结构配对=10、标签不完整=2、有效已标注配对=8",
         "ok": check(counts["structural_pairs"] == 10 and counts["label_incomplete_pairs"] == 2 and counts["paired_tasks"] == 8),
         "detail": f"structural={counts['structural_pairs']} incomplete={counts['label_incomplete_pairs']} paired={counts['paired_tasks']}"},
        {"id": "T08-2", "name": "最不利补全段存在且口径标注为 D-11 未批准硬门（含覆盖范围与判定豁免声明）",
         "ok": check(worst is not None and "D-11 未批准" in worst["note"] and "最不利补全为硬门口径" in worst["note"]
                     and "仅覆盖标签不完整配对，非所有缺失结果的完整补全" in worst["note"]
                     and "本段不参与当前 LOCKED 判定，正式执行口径待负责人确认 D-11" in worst["note"]),
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
        {"id": "T08-8", "name": "对照 unrelated 缺失 → 补 False；实验已知 True 保留",
         "ok": check(control_missing is not None
                     and control_missing["control_unrelated_count"] == 0
                     and control_missing["treatment_unrelated_count"] == 1
                     and control_missing["total_pairs"] == 3
                     and control_missing["imputed_details"][0]["imputed"] == {
                         "treatment_unrelated": True, "control_unrelated": False}),
         "detail": json.dumps(control_missing, ensure_ascii=False)},
        {"id": "T08-9", "name": "双侧 unrelated 缺失 → 补（实验 True / 对照 False）",
         "ok": check(both_missing is not None
                     and both_missing["treatment_unrelated_count"] == 1
                     and both_missing["control_unrelated_count"] == 0
                     and both_missing["total_pairs"] == 2
                     and both_missing["imputed_details"][0]["missing"] == ["control:unrelated", "treatment:unrelated"]
                     and both_missing["imputed_details"][0]["imputed"] == {
                         "treatment_unrelated": True, "control_unrelated": False}),
         "detail": json.dumps(both_missing["imputed_details"], ensure_ascii=False)},
        {"id": "T08-10", "name": "仅其他标签缺失（defect_free 未标注）但 unrelated 已知 → 保留已知值不覆盖",
         "ok": check(other_missing is not None
                     and other_missing["imputed_pairs"] == 1
                     and other_missing["imputed_details"][0]["missing"] == ["treatment:defect_free"]
                     and other_missing["imputed_details"][0]["imputed"] == {
                         "treatment_unrelated": True, "control_unrelated": False}
                     and other_missing["treatment_unrelated_count"] == 1
                     and other_missing["control_unrelated_count"] == 0),
         "detail": json.dumps(other_missing["imputed_details"], ensure_ascii=False)},
    ]

    # T08-11（task-19）：base(25795b8) 与 head 同输入不变性——排除新增 worst_case_imputation 键后逐字段一致。
    with tempfile.TemporaryDirectory(prefix="hephi-t08-") as tmp:
        base_path = Path(tmp) / "report_base.py"
        git_show = subprocess.run(
            ["git", "-C", str(REPO_ROOT), "show", f"{BASE_COMMIT}:eval/stats/report.py"],
            capture_output=True, text=True, timeout=60,
        )
        invariance_ok = git_show.returncode == 0
        invariance_detail = f"git show exit={git_show.returncode}"
        if invariance_ok:
            base_path.write_text(git_show.stdout, encoding="utf-8")
            spec = importlib.util.spec_from_file_location("report_base", base_path)
            report_base = importlib.util.module_from_spec(spec)
            sys.modules["report_base"] = report_base  # dataclass 装饰器要求模块已注册
            spec.loader.exec_module(report_base)
            config = {"seed": SEED, "n_boot": 500, "min_pairs": 5}
            base_result = report_base.analyze(build_runs(), dict(config))
            head_result = report.analyze(build_runs(), dict(config))
            head_stripped = {k: v for k, v in head_result.items() if k != "worst_case_imputation"}
            base_json = json.dumps(base_result, sort_keys=True, ensure_ascii=False, default=str)
            head_json = json.dumps(head_stripped, sort_keys=True, ensure_ascii=False, default=str)
            invariance_ok = base_json == head_json and "worst_case_imputation" in head_result
            invariance_detail = (
                f"identical={base_json == head_json} bytes={len(base_json)} "
                f"head_has_worst_case={'worst_case_imputation' in head_result} "
                f"conclusion={head_result['decision']['conclusion']}"
            )
    steps.append({"id": "T08-11", "name": f"base({BASE_COMMIT})/head 同输入不变性：排除 worst_case_imputation 后逐字段一致",
                  "ok": check(invariance_ok), "detail": invariance_detail})

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
