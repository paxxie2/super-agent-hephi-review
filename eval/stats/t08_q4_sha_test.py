#!/usr/bin/env python3
"""T08/Q4（v5.4 附录A）：制品 SHA 正误两例统计工具验证（合成数据，不跑正式实验）。

Q4 判据：两组必须加载同一 G1 配置（实载制品 SHA 与锁定值一致、回读 verified）；
正确制品 SHA + 可靠性条件满足 + 范围持平 → 可分开报告可靠性和范围；
错制品 SHA → 不能用于达标（运行 invalid → 证据不足，不得 meets）。

用例：
  正例：8 对，两臂实载各自的锁定 HEPHI/SA、回读 verified、标签齐全（kappa=0.9
  绑定当前 batch）、范围持平（两臂 outOfScope 同率）→ 冻结条件全 ok、可靠性与
  范围两节分开给出、evidence_reasons 为空（结论为达标判定而非证据不足）。
  反例：同输入但 1 条整包运行实载错误 HEPHI SHA（回读 verified，矛盾可核验）→
  该运行 invalid、排除出效果配对、结论 evidence_insufficient（错制品不能用于达标）。

用法：
    python eval/stats/t08_q4_sha_test.py [--json]

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
from b6_known_answers import BATCH, SEED, make_record  # noqa: E402  复用同一严格契约合成数据写法

TREATMENT = "native"
CONTROL = "off"
WRONG_HEPHI_SHA = "f" * 40  # 40 位全 f：任何前缀/全值核对都不可能与锁定值相符


def make_q4_run(task: str, arm: str, wrong_hephi: bool = False, **overrides):
    """构造 Q4 运行：默认实载锁定制品（_default_condition_fields），标签绑定当前 batch。

    wrong_hephi=True 时把实载 loadedSha 换成错误 SHA（回读仍 verified → 可核验矛盾，
    而非缺失证据），用于反例。
    """
    record = make_record(task, arm, **overrides)
    record["label"] = {**record["label"], "batchId": BATCH}  # 校准证据绑定当前 batch（Q4 可靠性条件）
    if wrong_hephi:
        record["plugin"] = {**record["plugin"], "loadedSha": WRONG_HEPHI_SHA}
    return report.parse_run(record)


def build_runs(wrong_tasks: set[str] | None = None) -> list:
    wrong_tasks = wrong_tasks or set()
    runs = []
    for index in range(1, 9):
        task = f"q{index:02d}"
        runs.append(make_q4_run(task, CONTROL, out_of_scope=False))
        runs.append(make_q4_run(task, TREATMENT, out_of_scope=False, wrong_hephi=task in wrong_tasks))
    return runs


def analyze(runs: list) -> dict:
    return report.analyze(runs, {"seed": SEED, "n_boot": 500, "min_pairs": 5})


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="T08/Q4 制品 SHA 正误两例验证（合成数据）")
    parser.add_argument("--json", action="store_true", help="JSON 输出")
    args = parser.parse_args(argv)

    # 正例：正确制品 SHA + 可靠性满足 + 范围持平。
    positive = analyze(build_runs())
    frozen_ok = positive["frozen_conditions"]
    scope = positive["primary"]["outOfScopeRate"]
    reliability = positive["guardrails"]["requiredCompleteRate"]

    # 反例：q05 整包运行实载错误 HEPHI SHA。
    negative = analyze(build_runs(wrong_tasks={"q05"}))

    def check(ok: bool) -> bool:
        return ok is True

    steps = [
        {"id": "Q4-1", "name": "正例：正确制品 SHA → 冻结条件全 ok（16 条运行，无 invalid/unverified）",
         "ok": check(frozen_ok["ok_runs"] == 16 and frozen_ok["invalid_runs"] == 0
                     and frozen_ok["unverified_runs"] == 0 and positive["counts"]["paired_tasks"] == 8),
         "detail": json.dumps({k: frozen_ok[k] for k in ("checked_runs", "ok_runs", "invalid_runs", "unverified_runs")})},
        {"id": "Q4-2", "name": "正例：范围与可靠性可分开报告（outOfScopeRate 与 requiredCompleteRate 两节均 ok 且独立给出）",
         "ok": check(scope.get("status") == "ok" and reliability.get("status") == "ok"
                     and "off" in scope and "native" in scope and "off" in reliability and "native" in reliability),
         "detail": f"scope_status={scope.get('status')} reliability_status={reliability.get('status')}"},
        {"id": "Q4-3", "name": "正例：范围持平（两臂越界率同为 0 → 绝对差 0，不得误报范围变化）",
         "ok": check(scope["absolute_difference"] == 0.0 and scope["off"]["rate"] == 0.0
                     and scope["native"]["rate"] == 0.0 and scope["superiority"]["worsened"] is False),
         "detail": f"off={scope['off']['rate']} native={scope['native']['rate']} diff={scope['absolute_difference']}"},
        {"id": "Q4-4", "name": "正例：证据链完整（evidence_reasons 为空，结论是达标判定 not_meets_prereg 而非证据不足）",
         "ok": check(positive["decision"]["evidence_reasons"] == []
                     and positive["decision"]["conclusion"] == "not_meets_prereg"),
         "detail": f"conclusion={positive['decision']['conclusion']} reasons={positive['decision']['evidence_reasons']}"},
        {"id": "Q4-5", "name": "反例：错制品 SHA → 该运行 condition_invalid（实载 HEPHI 不符），排除出效果配对",
         "ok": check(negative["frozen_conditions"]["invalid_runs"] == 1
                     and any(entry["runId"] == "q05-native" and any("实载 HEPHI" in r for r in entry["reasons"])
                             for entry in negative["condition_invalid_runs"])
                     and negative["counts"]["condition_invalid"] == 1
                     and negative["counts"]["paired_tasks"] == 7),
         "detail": json.dumps(negative["condition_invalid_runs"], ensure_ascii=False)},
        {"id": "Q4-6", "name": "反例：错制品 SHA 不能用于达标 → 结论 evidence_insufficient（不得 meets_prereg）",
         "ok": check(negative["decision"]["conclusion"] == "evidence_insufficient"
                     and negative["decision"]["meets_prereg"] is False
                     and any("冻结条件矛盾" in r for r in negative["decision"]["evidence_reasons"])),
         "detail": f"conclusion={negative['decision']['conclusion']} reasons={negative['decision']['evidence_reasons']}"},
    ]

    ok = all(step["ok"] for step in steps)
    if args.json:
        print(json.dumps({"t08Q4Sha": ok, "steps": steps}, ensure_ascii=False, indent=2))
    else:
        for step in steps:
            print(f"{'PASS' if step['ok'] else 'FAIL'} [{step['id']}] {step['name']} :: {step['detail']}")
        print("T08-Q4-SHA: PASS" if ok else "T08-Q4-SHA: FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
