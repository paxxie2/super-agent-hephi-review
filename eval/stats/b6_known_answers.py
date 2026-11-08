#!/usr/bin/env python3
"""ROADMAP-95 工作线 B / B6：已知答案验证（不跑正式实验，只用合成数据）。

覆盖任务书列出的已知答案项：

    B6-01  6 改善 / 0 恶化 → 精确 McNemar p=0.03125、bootstrap CI=[-1,-1]
    B6-02  native 在更差方向差 10pp（主指标更高 / 守护指标更低）→ 不得判改善或非劣效
    B6-04  成本缺失（tokens.total=null）不等于 0，不得让成本检查静默通过
    B6-05  对照组比率为 0 时相对变化标“不适用”；分层配对不足 → “证据不足”
    B6-06  环境不可用运行不计效果指标，但其成本仍保留并计入成本统计
    B6-07  同一数据 + 同一 seed 可复算（两次 CLI 输出逐字节一致）

说明：
- B6-02 的任务书写法是“native 高 10pp 不得判非劣效”。报告里非劣效只定义在
  “越大越好”的守护指标上（PREREG §3），因此本脚本按两个方向验证：
  (a) 守护指标 native 比 off 低 10pp（更差方向）→ non_inferior=False；
  (b) 主指标 native 比 off 高 10pp（越界率更高 = 更差）→ 不得判为改善/达标。
- 本脚本是**工具验证**，不能替代真实实验数据、真人盲评或负责人对 PREREG 的锁定。

用法：
    python eval/stats/b6_known_answers.py [--json]

退出码：0=全部已知答案通过；1=有断言失败；2=环境/依赖错误。
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy
import scipy
import statsmodels

HERE = Path(__file__).resolve().parent
REPORT = HERE / "report.py"
sys.path.insert(0, str(HERE))

import report  # noqa: E402  （report.py 自带依赖守卫，缺依赖时 exit 2）

BATCH = "b6-known-answers"
SEED = 20261107


def make_record(task: str, arm: str, **overrides) -> dict:
    """构造一条符合 report.parse_run 严格契约的运行记录（合成数据；含冻结条件与标注证据）。"""
    condition = report._default_condition_fields(arm)
    condition["label"] = {"batchId": f"{BATCH}-labels", "labelers": ["reviewer-a", "reviewer-b"], "kappa": 0.9}
    record = {
        "schemaVersion": 1,
        "runId": f"{task}-{arm}",
        "batch": BATCH,
        "taskId": task,
        "repo": overrides.pop("repo", "synthetic/repo"),
        "category": overrides.pop("category", "new-feature"),
        "base": "a" * 40,
        "head": "b" * 40,
        "arm": arm,
        "executionMode": "normal",
        "repetition": overrides.pop("repetition", 1),
        "seed": SEED,
        "startedAt": "2026-11-09T00:00:00Z",
        "endedAt": "2026-11-09T00:00:10Z",
        "model": condition["model"],
        "host": condition["host"],
        "plugin": condition["plugin"],
        "decisionLog": None,
        "label": condition["label"],
        "validationEnvironment": {
            "status": overrides.pop("env", "available"),
            "reason": overrides.pop("env_reason", None),
        },
        "taskCard": {"sha256": "0" * 64, "deliveryMechanism": "issue-body", "verifiedEqual": overrides.pop("task_card_ok", True)},
        "outOfScopeChanges": {"has": overrides.pop("out_of_scope", False)},
        "unrelatedChanges": {"has": overrides.pop("unrelated", False)},
        "objectiveChanged": overrides.pop("objective", "unchanged"),
        "requiredFunctionImplemented": overrides.pop("required", "complete"),
        "implementationDefect": {"verdict": overrides.pop("defect", "none")},
        "delivery": overrides.pop("delivery", "ready-pr-created"),
        "wallClockSeconds": overrides.pop("minutes", 10.0),
        "timeout": overrides.pop("timeout", False),
        "tokens": {"total": overrides.pop("tokens", 1000)},
        "humanIntervention": {"count": overrides.pop("human", 0)},
        "testWeakening": {"has": False},
    }
    if overrides:
        raise AssertionError(f"未使用的覆盖字段：{sorted(overrides)}")
    return record


def make_run(task: str, arm: str, **overrides) -> "report.Run":
    return report.parse_run(make_record(task, arm, **overrides))


def metric_pairs(runs: list, metric_key: str, direction: str, **kwargs) -> dict:
    return report.evaluate_metric(report.paired_tasks(runs, kwargs.pop("repetition", 1)), metric_key,
                                  direction, kwargs.pop("n_boot", 2000), kwargs.pop("seed", SEED),
                                  kwargs.pop("margin", report.DEFAULT_NONINFERIORITY_MARGIN))


def steps_result(steps: list[dict], as_json: bool) -> int:
    ok = all(step["ok"] for step in steps)
    if as_json:
        print(json.dumps({
            "knownAnswers": ok,
            "versions": {
                "numpy": numpy.__version__,
                "scipy": scipy.__version__,
                "statsmodels": statsmodels.__version__,
            },
            "steps": steps,
        }, ensure_ascii=False, indent=2))
    else:
        for step in steps:
            print(f"{'PASS' if step['ok'] else 'FAIL'} [{step['id']}] {step['name']} :: {step['detail']}")
        print("KNOWN-ANSWERS: PASS" if ok else "KNOWN-ANSWERS: FAIL")
    return 0 if ok else 1


def b6_01(record) -> None:
    offs = [True] * 6
    natives = [False] * 6
    runs = []
    for index, (off_value, native_value) in enumerate(zip(offs, natives)):
        task = f"t{index + 1:02d}"
        runs.append(make_run(task, "off", out_of_scope=off_value))
        runs.append(make_run(task, "native", out_of_scope=native_value))
    result = metric_pairs(runs, "outOfScopeRate", "smaller")
    expected_p = 2 * (0.5 ** 6)
    ci = result["bootstrap_ci"]
    record(
        "B6-01",
        "6 改善 / 0 恶化 → McNemar p=0.03125 且 CI=[-1,-1]",
        abs(result["mcnemar"]["exact_p"] - expected_p) < 1e-12
        and abs(ci[0] + 1.0) < 1e-12
        and abs(ci[1] + 1.0) < 1e-12
        and result["superiority"]["improved"] is True,
        f"p={result['mcnemar']['exact_p']} ci={ci} improved={result['superiority']['improved']}",
    )


def b6_02(record) -> None:
    # (a) 守护指标：10 对里仅 1 对 native 更差（低 10pp）→ CI 下界 <= -0.05，非劣效不成立。
    runs = []
    for index in range(10):
        task = f"g{index + 1:02d}"
        runs.append(make_run(task, "off", required="complete"))
        runs.append(make_run(task, "native", required=("partial" if index == 0 else "complete")))
    guard = metric_pairs(runs, "requiredCompleteRate", "larger")
    record(
        "B6-02",
        "守护指标 native 低 10pp（更差方向）→ 不得判非劣效",
        abs(guard["absolute_difference"] + 0.10) < 1e-12
        and guard["noninferiority"]["non_inferior"] is False,
        f"diff={guard['absolute_difference']} ci={guard['bootstrap_ci']} non_inferior={guard['noninferiority']['non_inferior']}",
    )

    # (b) 主指标：native 越界率高 10pp（更差方向）→ 不得判改善，也不得判“达到预注册”。
    primary_runs = []
    for index in range(10):
        task = f"m{index + 1:02d}"
        primary_runs.append(make_run(task, "off", out_of_scope=False))
        primary_runs.append(make_run(task, "native", out_of_scope=(index == 0)))
    primary = metric_pairs(primary_runs, "outOfScopeRate", "smaller")
    decision = report.analyze(primary_runs, {"seed": SEED, "n_boot": 2000, "min_pairs": 5})
    record(
        "B6-02",
        "主指标 native 高 10pp（越界率更差）→ 不得判改善/达标",
        abs(primary["absolute_difference"] - 0.10) < 1e-12
        and primary["superiority"]["improved"] is False
        and decision["decision"]["conclusion"] != "meets_prereg"
        and not decision["decision"]["improved_primary"],
        f"diff={primary['absolute_difference']} improved={primary['superiority']['improved']} conclusion={decision['decision']['conclusion']}",
    )


def b6_04(record) -> None:
    # tokens.total=null 的运行不得按 0 计入中位数；全部缺失时成本检查不得通过。
    runs = []
    for index in range(2):
        task = f"c{index + 1:02d}"
        runs.append(make_run(task, "off", tokens=50))
        runs.append(make_run(task, "native", tokens=(100 if index == 0 else 200)))
    pairs = report.paired_tasks(runs, 1)
    cost = report.evaluate_cost(runs, report.DEFAULT_COST_CAPS)
    record(
        "B6-04",
        "部分 token 缺失 → 中位数只用已知值（1 个 100 + 1 个 200 → 150，而非按 0 混入）",
        abs(cost["values"]["native_median_tokens"] - 150.0) < 1e-12,
        f"native_median_tokens={cost['values']['native_median_tokens']}",
    )

    missing_runs = []
    for index in range(2):
        task = f"c{index + 1:02d}"
        missing_runs.append(make_run(task, "off", tokens=50))
        missing_runs.append(make_run(task, "native", tokens=None))
    missing_cost = report.evaluate_cost(missing_runs, report.DEFAULT_COST_CAPS)
    record(
        "B6-04",
        "全部 token 缺失 → 中位数 N/A、成本检查不通过（缺失不等于 0）",
        missing_cost["values"]["native_median_tokens"] is None
        and missing_cost["checks"]["median_tokens_max"] is False
        and missing_cost["within_caps"] is False
        and "median_tokens_max" in missing_cost["exceeded"],
        f"median={missing_cost['values']['native_median_tokens']} exceeded={missing_cost['exceeded']}",
    )


def b6_05(record) -> None:
    # (a) 对照组比率为 0：相对变化必须“不适用”，不得除零。
    zero_runs = []
    for index in range(3):
        task = f"z{index + 1:02d}"
        zero_runs.append(make_run(task, "off", out_of_scope=False))
        zero_runs.append(make_run(task, "native", out_of_scope=True))
    zero = metric_pairs(zero_runs, "outOfScopeRate", "smaller")
    record(
        "B6-05",
        "对照组 off 比率=0 → relative_change=None 且标注不适用（不除零）",
        zero["off"]["rate"] == 0.0
        and zero["relative_change"] is None
        and "不适用" in (zero["relative_change_note"] or ""),
        f"off_rate={zero['off']['rate']} relative={zero['relative_change']} note={zero['relative_change_note']}",
    )

    # (b) 分层配对不足：repo A 有 4 对、repo B 有 6 对，min_pairs=5 → A 标“证据不足”。
    runs = []
    for repo, count in (("repo/a", 4), ("repo/b", 6)):
        for index in range(count):
            task = f"{repo.replace('/', '-')}-{index + 1}"
            runs.append(make_run(task, "off", repo=repo, out_of_scope=False))
            runs.append(make_run(task, "native", repo=repo, out_of_scope=False))
    analyzed = report.analyze(runs, {"seed": SEED, "n_boot": 500, "min_pairs": 5})
    repo_a = analyzed["strata"]["repo"]["repo/a"]
    repo_b = analyzed["strata"]["repo"]["repo/b"]
    record(
        "B6-05",
        "分层不足（4 对 < min_pairs=5）→ 该层结论“证据不足”，不强行下结论",
        repo_a["n_pairs"] == 4
        and repo_a["evidence_insufficient"] is True
        and repo_a["conclusion"] == "证据不足"
        and repo_b["n_pairs"] == 6
        and repo_b["evidence_insufficient"] is False,
        f"repo/a={repo_a} repo/b={repo_b}",
    )


def b6_06(record) -> None:
    # 环境不可用：排除出效果指标，但成本（tokens/耗时）仍保留并计入成本统计。
    runs = [
        make_run("e01", "off", minutes=600.0, tokens=50),
        make_run("e01", "native", minutes=600.0, tokens=100),
        make_run("e02", "off", minutes=1200.0, tokens=50),
        make_run("e02", "native", minutes=1200.0, tokens=200),
        make_run("e03", "native", minutes=3600.0, tokens=1000, env="unavailable", env_reason="构建失败"),
    ]
    analyzed = report.analyze(runs, {"seed": SEED, "n_boot": 500, "min_pairs": 1})
    cost_values = analyzed["cost"]["values"]
    record(
        "B6-06",
        "环境不可用运行不计效果（n_pairs=2）但仍保留成本（tokens 中位数 200、耗时中位数 20）",
        analyzed["counts"]["environment_unavailable"] == 1
        and analyzed["counts"]["paired_tasks"] == 2
        and cost_values["native_median_tokens"] == 200.0
        and cost_values["native_median_minutes"] == 20.0,
        f"env_unavailable={analyzed['counts']['environment_unavailable']} pairs={analyzed['counts']['paired_tasks']} "
        f"tokens={cost_values['native_median_tokens']} minutes={cost_values['native_median_minutes']}",
    )


def b6_07(record) -> None:
    runs = []
    for index in range(4):
        task = f"r{index + 1:02d}"
        runs.append(make_record(task, "off", out_of_scope=(index % 2 == 0)))
        runs.append(make_record(task, "native", out_of_scope=(index % 3 == 0)))
    document = {"runs": runs}
    with tempfile.TemporaryDirectory(prefix="hephi-b6-") as tmp:
        path = Path(tmp) / "runs.json"
        path.write_text(json.dumps(document), encoding="utf-8")
        command = [sys.executable, str(REPORT), "--input", str(path), "--format", "json", "--seed", str(SEED), "--n-boot", "500"]
        first = subprocess.run(command, capture_output=True, text=True, timeout=300)
        second = subprocess.run(command, capture_output=True, text=True, timeout=300)
        record(
            "B6-07",
            "同数据 + 同 seed 两次 CLI 输出逐字节一致（可复算）",
            first.returncode == 0 and second.returncode == 0 and first.stdout == second.stdout and first.stdout.strip().startswith("{"),
            f"exit={first.returncode}/{second.returncode} bytes={len(first.stdout)} identical={first.stdout == second.stdout}",
        )


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="B6 已知答案验证（合成数据，不跑正式实验）")
    parser.add_argument("--json", action="store_true", help="JSON 输出")
    args = parser.parse_args(argv)

    steps: list[dict] = []

    def record(step_id: str, name: str, ok: bool, detail: str) -> None:
        steps.append({"id": step_id, "name": name, "ok": bool(ok), "detail": detail})

    for function in (b6_01, b6_02, b6_04, b6_05, b6_06, b6_07):
        function(record)
    return steps_result(steps, args.json)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
