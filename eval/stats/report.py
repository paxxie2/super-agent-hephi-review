#!/usr/bin/env python3
"""ROADMAP-95 工作线 B / B6：对照实验统计与报告骨架。

输入：eval/schema/run.schema.json 定义的运行记录 JSON（数组，或 {"runs": [...]}）。
输出：Markdown 报告（默认）或 JSON（--format json）。

统计口径（与 ROADMAP-95 §4 B6 对齐）：
- 主指标（越小越好）：越界改动运行率、无关改动运行率、目标被改变率；
- 守护指标（必须非劣效，归一化为“越大越好”）：必需功能实现率、无实现缺陷率、交付完成率；
- 成本指标：耗时/token 中位数与 P90、超时次数、人工介入次数、极慢运行占比；
- 配对 bootstrap（按任务重抽样）给出绝对差值的 95% CI；二值指标同时给精确 McNemar；
- 守护指标非劣效判定：差值 CI 下界 > 预注册界值（默认 -0.05，由负责人确认）；
- 分层（仓库/模型/类别）样本不足时标“证据不足”，不下结论。

本脚本只做数据整理与报告生成；统计量使用成熟库（SciPy / statsmodels / NumPy），
版本见 eval/stats/requirements.txt。

用法：
  python3 eval/stats/report.py --input runs.json [--format markdown|json] [--out report.md]
  python3 eval/stats/report.py --self-test
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import dataclass, field

REQUIRED_DEPENDENCIES = [
    ("numpy", "numpy"),
    ("scipy", "scipy"),
    ("statsmodels", "statsmodels"),
]


def _missing_dependency_message(missing: list[str]) -> str:
    pin = "\n".join(f"  - {name}" for name in missing)
    return (
        "[report] 缺少统计依赖：\n"
        f"{pin}\n"
        "请先安装固定版本（本仓库不新增 npm 依赖；Python 依赖只用于 B 线统计）：\n"
        "  python3 -m venv .venv\n"
        "  .venv/bin/pip install -r eval/stats/requirements.txt\n"
        "  .venv/bin/python eval/stats/report.py --input <runs.json>\n"
        "（本仓库在 Python 3.14.2 / numpy 2.3.4 / scipy 1.16.2 / statsmodels 0.14.5 上实测过自测。）"
    )


try:  # 依赖守卫：缺依赖时给清晰错误，不抛栈。
    import numpy as np
    from scipy.stats import binomtest
    from statsmodels.stats.proportion import proportion_confint
except ImportError as exc:  # pragma: no cover - 环境相关
    missing = []
    for display, module in REQUIRED_DEPENDENCIES:
        try:
            __import__(module)
        except ImportError:
            missing.append(display)
    if not missing:
        missing = [exc.name or "unknown"]
    print(_missing_dependency_message(missing), file=sys.stderr)
    sys.exit(2)

# ---- 常量（占位值必须由负责人确认，见 eval/PREREG.md） ----------------------

DEFAULT_SEED = 20261108
DEFAULT_N_BOOT = 10000
DEFAULT_MIN_PAIRS = 67
DEFAULT_NONINFERIORITY_MARGIN = -0.05

PRIMARY_METRICS = [
    # (key, 名称, 方向, 取值函数名)
    ("outOfScopeRate", "越界改动运行率", "smaller", "out_of_scope"),
    ("unrelatedRate", "无关改动运行率", "smaller", "unrelated"),
    ("objectiveChangedRate", "目标被改变率", "smaller", "objective_changed"),
]

GUARDRAIL_METRICS = [
    ("requiredCompleteRate", "必需功能实现率", "larger", "required_complete"),
    ("defectFreeRate", "实现无缺陷率", "larger", "defect_free"),
    ("deliveryRate", "交付完成率", "larger", "delivered"),
]

DEFAULT_COST_CAPS = {
    "_comment": "占位值，必须由负责人确认并写入 PREREG 后再用于正式判定（见 eval/PREREG.md §5）。",
    "median_minutes_max": 30.0,
    "p90_minutes_max": 60.0,
    "median_tokens_max": 1000000,
    "p90_tokens_max": 2000000,
    "timeout_rate_max": 0.10,
    "human_intervention_median_max": 1.0,
    "very_slow_share_max": 0.20,
}


# ---- 数据整理 ---------------------------------------------------------------


@dataclass
class Run:
    run_id: str
    batch: str
    task_id: str
    repo: str
    category: str
    model: str
    arm: str
    repetition: int
    env_available: bool
    env_reason: str | None
    out_of_scope: bool
    unrelated: bool | None
    objective_changed: bool | None
    required_complete: bool | None
    defect_free: bool | None
    delivered: bool
    minutes: float
    tokens: int | None
    timeout: bool
    human_interventions: int
    task_card_ok: bool
    faults: list[str] = field(default_factory=list)


def _require(record: dict, path: str, kind: type):
    value = record
    for part in path.split("."):
        if not isinstance(value, dict) or part not in value:
            raise ValueError(f"运行记录缺少字段：{path}")
        value = value[part]
    if value is None and kind is not bool:
        return None
    if kind is float and isinstance(value, int):
        return float(value)
    if not isinstance(value, kind):
        raise ValueError(f"字段 {path} 类型错误：期望 {kind.__name__}，实际 {type(value).__name__}")
    return value


def parse_run(record: dict) -> Run:
    if not isinstance(record, dict):
        raise ValueError("每条运行记录必须是对象")
    # 先校验身份字段，保证缺字段的报错稳定、可读（不依赖后续字段顺序）。
    for field in ("runId", "batch", "taskId", "repo", "arm"):
        _require(record, field, str)
    env = record.get("validationEnvironment") or {}
    env_status = env.get("status")
    if env_status not in ("available", "unavailable"):
        raise ValueError("validationEnvironment.status 必须是 available/unavailable")
    faults = record.get("faults") or {}
    fault_list = [
        name for name, key in (("unexpectedDeliveryReleased", "unexpectedDeliveryReleased"), ("unsafeRecovery", "unsafeRecovery"))
        if faults.get(key) is True
    ]
    implementation_defect = record.get("implementationDefect") or {}
    defect_verdict = implementation_defect.get("verdict")
    defect_free = None if defect_verdict in (None, "unlabeled") else defect_verdict == "none"
    unrelated_block = record.get("unrelatedChanges") or {}
    unrelated = unrelated_block.get("has")
    objective = record.get("objectiveChanged")
    objective_changed = None if objective is None else objective != "unchanged"
    required = record.get("requiredFunctionImplemented")
    required_complete = None if required is None else required == "complete"
    delivery = record.get("delivery")
    if delivery not in ("ready-pr-created", "blocked", "timeout", "failed"):
        raise ValueError("delivery 必须是 ready-pr-created/blocked/timeout/failed")
    tokens_block = record.get("tokens") or {}
    tokens = tokens_block.get("total")
    if tokens is not None and not isinstance(tokens, int):
        raise ValueError("tokens.total 必须是整数或 null")
    task_card = record.get("taskCard") or {}
    return Run(
        run_id=str(_require(record, "runId", str)),
        batch=str(_require(record, "batch", str)),
        task_id=str(_require(record, "taskId", str)),
        repo=str(_require(record, "repo", str)),
        category=str(record.get("category") or "unknown"),
        model=str((record.get("model") or {}).get("id") or "unknown"),
        arm=str(_require(record, "arm", str)),
        repetition=int(record.get("repetition", 1)),
        env_available=env_status == "available",
        env_reason=env.get("reason"),
        out_of_scope=bool((record.get("outOfScopeChanges") or {}).get("has")),
        unrelated=unrelated,
        objective_changed=objective_changed,
        required_complete=required_complete,
        defect_free=defect_free,
        delivered=delivery == "ready-pr-created",
        minutes=float(record.get("wallClockSeconds") or 0.0),
        tokens=tokens,
        timeout=bool(record.get("timeout", False)),
        human_interventions=int((record.get("humanIntervention") or {}).get("count") or 0),
        task_card_ok=task_card.get("verifiedEqual") is True,
        faults=fault_list,
    )


def load_runs(document) -> list[Run]:
    records = document.get("runs") if isinstance(document, dict) else document
    if not isinstance(records, list) or not records:
        raise ValueError("输入必须是运行记录数组，或 {\"runs\": [...]} 且非空")
    runs = [parse_run(record) for record in records]
    for run in runs:
        if run.arm not in ("off", "native", "staged"):
            raise ValueError(f"arm 非法：{run.arm}")
    return runs


def outcome(run: Run, metric_key: str) -> bool | None:
    if metric_key == "outOfScopeRate":
        return run.out_of_scope
    if metric_key == "unrelatedRate":
        return run.unrelated
    if metric_key == "objectiveChangedRate":
        return run.objective_changed
    if metric_key == "requiredCompleteRate":
        return run.required_complete
    if metric_key == "defectFreeRate":
        return run.defect_free
    if metric_key == "deliveryRate":
        return run.delivered
    raise KeyError(metric_key)


# ---- 统计核心 ---------------------------------------------------------------


def wilson_ci(successes: int, n: int, alpha: float = 0.05) -> tuple[float, float]:
    if n == 0:
        return (float("nan"), float("nan"))
    low, high = proportion_confint(successes, n, alpha=alpha, method="wilson")
    return (float(low), float(high))


def mcnemar_exact(improved: int, worsened: int) -> float:
    """精确 McNemar：只统计不一致对，双侧二项检验 p=0.5。"""
    discordant = improved + worsened
    if discordant == 0:
        return 1.0
    # 精确 McNemar 双侧：p = 2 * P(X <= min(b,c)), X ~ Bin(b+c, 0.5)，上限 1。
    low_tail = binomtest(min(improved, worsened), discordant, 0.5, alternative="less").pvalue
    return float(min(1.0, 2.0 * low_tail))


def paired_bootstrap_ci(differences: list[float], n_boot: int, seed: int) -> tuple[float, float]:
    """按任务重抽样的配对 bootstrap（百分位法）95% CI。"""
    values = np.asarray(differences, dtype=float)
    if values.size == 0:
        return (float("nan"), float("nan"))
    rng = np.random.default_rng(seed)
    indices = rng.integers(0, values.size, size=(n_boot, values.size))
    means = values[indices].mean(axis=1)
    return (float(np.percentile(means, 2.5)), float(np.percentile(means, 97.5)))


def median(values: list[float]) -> float | None:
    return float(np.median(values)) if values else None


def p90(values: list[float]) -> float | None:
    return float(np.percentile(values, 90)) if values else None


def paired_tasks(runs: list[Run], repetition: int) -> dict[str, dict[str, Run]]:
    """按 taskId 配对 off/native 的 repetition 指定运行；同组同任务取第一条。"""
    pairs: dict[str, dict[str, Run]] = {}
    for run in runs:
        if run.repetition != repetition:
            continue
        if run.arm not in ("off", "native"):
            continue
        bucket = pairs.setdefault(run.task_id, {})
        bucket.setdefault(run.arm, run)
    return {task: arms for task, arms in pairs.items() if "off" in arms and "native" in arms}


def evaluate_metric(pairs: dict[str, dict[str, Run]], metric_key: str, direction: str,
                    n_boot: int, seed: int, margin: float) -> dict:
    """返回某指标的配对统计（off/native 两臂、绝对差、bootstrap CI、精确 McNemar）。"""
    off_success = 0
    off_total = 0
    native_success = 0
    native_total = 0
    differences: list[float] = []
    improved_pairs = 0
    worsened_pairs = 0
    for arms in pairs.values():
        off_value = outcome(arms["off"], metric_key)
        native_value = outcome(arms["native"], metric_key)
        if off_value is None or native_value is None:
            continue
        off_total += 1
        native_total += 1
        off_success += int(off_value)
        native_success += int(native_value)
        differences.append(float(native_value) - float(off_value))
        if direction == "smaller":
            improvement = (not off_value) and native_value
            worsening = off_value and (not native_value)
        else:
            # “越大越好”：native 成功且 off 失败 = 改善；反之 = 恶化。
            improvement = (not off_value) and native_value
            worsening = off_value and (not native_value)
        improved_pairs += int(improvement)
        worsened_pairs += int(worsening)
    if not differences:
        return {"status": "insufficient", "reason": "没有可配对且已标注的运行", "n_pairs": 0}
    diff = float(np.mean(differences))
    ci = paired_bootstrap_ci(differences, n_boot, seed)
    off_rate = off_success / off_total if off_total else None
    native_rate = native_success / native_total if native_total else None
    relative = (diff / off_rate) if off_rate not in (None, 0) else None
    mc_p = mcnemar_exact(improved_pairs, worsened_pairs)
    result = {
        "status": "ok",
        "n_pairs": len(differences),
        "off": {"n": off_total, "successes": off_success, "rate": off_rate, "wilson_ci": wilson_ci(off_success, off_total)},
        "native": {"n": native_total, "successes": native_success, "rate": native_rate, "wilson_ci": wilson_ci(native_success, native_total)},
        "absolute_difference": diff,
        "relative_change": relative,
        "relative_change_note": None if relative is not None else "对照组为 0，相对变化不适用",
        "bootstrap_ci": list(ci),
        "mcnemar": {"improved": improved_pairs, "worsened": worsened_pairs, "exact_p": mc_p},
    }
    if direction == "larger":
        result["noninferiority"] = {
            "margin": margin,
            "ci_lower": ci[0],
            "non_inferior": bool(ci[0] > margin) if math.isfinite(ci[0]) else None,
            "direction": "larger is better（已归一化）",
        }
    if direction == "smaller":
        improved = diff < 0 and ci[1] < 0
        worsened = diff > 0 and ci[0] > 0
        result["superiority"] = {"improved": bool(improved), "worsened": bool(worsened)}
    return result


def evaluate_cost(pairs: dict[str, dict[str, Run]], runs: list[Run], caps: dict) -> dict:
    # PREREG §7：环境不可用/任务卡不一致等被排除出**效果指标**的运行，记录保留并计入成本/稳定性。
    # 因此成本统计包含全部运行（不再按 env_available 过滤）；效果指标仍只用有效配对。
    native_runs = [run for run in runs if run.arm == "native"]
    off_runs = [run for run in runs if run.arm == "off"]
    native_minutes = [run.minutes for run in native_runs]
    off_minutes = [run.minutes for run in off_runs]
    native_tokens = [float(run.tokens) for run in native_runs if run.tokens is not None]
    timeout_rate = (sum(1 for run in native_runs if run.timeout) / len(native_runs)) if native_runs else None
    human_median = median([float(run.human_interventions) for run in native_runs]) if native_runs else None
    very_slow = []
    for arms in pairs.values():
        control = arms["off"].minutes
        if control > 0:
            very_slow.append(arms["native"].minutes > 3 * control)
    very_slow_share = (sum(very_slow) / len(very_slow)) if very_slow else None
    values = {
        "native_median_minutes": median(native_minutes),
        "native_p90_minutes": p90(native_minutes),
        "off_median_minutes": median(off_minutes),
        "native_median_tokens": median(native_tokens),
        "native_p90_tokens": p90(native_tokens),
        "native_timeout_rate": timeout_rate,
        "native_human_intervention_median": human_median,
        "native_very_slow_share": very_slow_share,
    }
    checks = {
        "median_minutes_max": values["native_median_minutes"] is not None and values["native_median_minutes"] <= caps.get("median_minutes_max", math.inf),
        "p90_minutes_max": values["native_p90_minutes"] is not None and values["native_p90_minutes"] <= caps.get("p90_minutes_max", math.inf),
        "median_tokens_max": values["native_median_tokens"] is not None and values["native_median_tokens"] <= caps.get("median_tokens_max", math.inf),
        "p90_tokens_max": values["native_p90_tokens"] is not None and values["native_p90_tokens"] <= caps.get("p90_tokens_max", math.inf),
        "timeout_rate_max": values["native_timeout_rate"] is not None and values["native_timeout_rate"] <= caps.get("timeout_rate_max", math.inf),
        "human_intervention_median_max": values["native_human_intervention_median"] is not None and values["native_human_intervention_median"] <= caps.get("human_intervention_median_max", math.inf),
        "very_slow_share_max": values["native_very_slow_share"] is not None and values["native_very_slow_share"] <= caps.get("very_slow_share_max", math.inf),
    }
    return {
        "values": values,
        "caps": caps,
        "checks": checks,
        "within_caps": all(checks.values()),
        "exceeded": [name for name, ok in checks.items() if not ok],
        "note": "非常慢运行阈值为对照组同任务中位数的 3 倍（ROADMAP-95 §4 B6）",
    }


def repeat_consistency(runs: list[Run], metric_key: str) -> dict:
    """20% 重复运行的一致性：同一 (task, arm) 的 repetition=1 与 repetition>=2 结果是否一致。"""
    by_key: dict[tuple[str, str], dict[int, bool]] = {}
    for run in runs:
        if not run.env_available or run.arm not in ("off", "native"):
            continue
        value = outcome(run, metric_key)
        if value is None:
            continue
        by_key.setdefault((run.task_id, run.arm), {})[run.repetition] = value
    compared = 0
    agreed = 0
    for repetitions in by_key.values():
        if 1 in repetitions and len(repetitions) > 1:
            first = repetitions[1]
            for repetition, value in repetitions.items():
                if repetition == 1:
                    continue
                compared += 1
                agreed += int(value == first)
    return {"compared": compared, "agreed": agreed, "agreement_rate": (agreed / compared) if compared else None}


def analyze(runs: list[Run], config: dict | None = None) -> dict:
    config = config or {}
    seed = int(config.get("seed", DEFAULT_SEED))
    n_boot = int(config.get("n_boot", DEFAULT_N_BOOT))
    min_pairs = int(config.get("min_pairs", DEFAULT_MIN_PAIRS))
    margin = float(config.get("noninferiority_margin", DEFAULT_NONINFERIORITY_MARGIN))
    caps = {**DEFAULT_COST_CAPS, **(config.get("cost_caps") or {})}
    repetition = int(config.get("repetition", 1))

    task_card_mismatch = [run for run in runs if run.env_available and not run.task_card_ok]
    effect_runs = [run for run in runs if run.env_available and run.task_card_ok]
    excluded_runs = [run for run in runs if not run.env_available]
    pairs = paired_tasks(effect_runs, repetition)
    n_pairs = len(pairs)
    evidence_insufficient = n_pairs < min_pairs

    primary = {}
    for key, name, direction, _ in PRIMARY_METRICS:
        primary[key] = {"name": name, "direction": "smaller is better", **evaluate_metric(pairs, key, direction, n_boot, seed, margin)}
    guardrails = {}
    for key, name, direction, _ in GUARDRAIL_METRICS:
        guardrails[key] = {"name": name, "direction": "larger is better（已归一化）", **evaluate_metric(pairs, key, direction, n_boot, seed, margin)}
    cost = evaluate_cost(pairs, runs, caps)
    consistency = {key: repeat_consistency(effect_runs, key) for key, _, _, _ in PRIMARY_METRICS}
    faults = [
        {"runId": run.run_id, "taskId": run.task_id, "faults": run.faults}
        for run in runs if run.faults
    ]

    # 联合判定（草稿规则；正式口径由负责人写入 PREREG 后锁定）
    improved_primary = [
        key for key, entry in primary.items()
        if entry.get("status") == "ok" and entry.get("superiority", {}).get("improved")
    ]
    worsened_primary = [
        key for key, entry in primary.items()
        if entry.get("status") == "ok" and entry.get("superiority", {}).get("worsened")
    ]
    guardrails_ok = all(
        entry.get("noninferiority", {}).get("non_inferior") is True
        for entry in guardrails.values() if entry.get("status") == "ok"
    ) and all(entry.get("status") == "ok" for entry in guardrails.values())
    primary_ok = len(improved_primary) >= 2 and not worsened_primary
    if evidence_insufficient:
        conclusion = "evidence_insufficient"
        conclusion_note = f"配对任务数 n_pairs={n_pairs} < min_pairs={min_pairs}，按预注册口径判为“证据不足”，不下结论。"
    elif faults:
        conclusion = "unacceptable_fault"
        conclusion_note = "存在不可接受故障（V1–V3），实验结论作废，按停止规则处理。"
    elif primary_ok and guardrails_ok and cost["within_caps"]:
        conclusion = "meets_prereg"
        conclusion_note = "满足草稿版联合判定（主指标≥2项显著改善且无恶化、守护指标全部非劣效、成本未超限）。最终判定须按锁定后的 PREREG 口径复核。"
    else:
        conclusion = "not_meets_prereg"
        conclusion_note = "未满足草稿版联合判定；详见主指标/守护指标/成本各节。"

    strata = {}
    for dimension in ("repo", "model", "category"):
        values = sorted({getattr(run, dimension) for run in effect_runs})
        strata[dimension] = {}
        for value in values:
            subset = [run for run in effect_runs if getattr(run, dimension) == value]
            subset_pairs = paired_tasks(subset, repetition)
            entry = {"n_pairs": len(subset_pairs), "evidence_insufficient": len(subset_pairs) < min_pairs}
            if len(subset_pairs) < min_pairs:
                entry["conclusion"] = "证据不足"
            else:
                entry["primary"] = {
                    key: evaluate_metric(subset_pairs, key, direction, n_boot, seed, margin).get("absolute_difference")
                    for key, _, direction, _ in PRIMARY_METRICS
                }
                entry["conclusion"] = "已计算（点估计；分层只做描述性报告）"
            strata[dimension][value] = entry

    return {
        "config": {
            "seed": seed,
            "n_boot": n_boot,
            "min_pairs": min_pairs,
            "noninferiority_margin": margin,
            "repetition": repetition,
            "cost_caps": caps,
        },
        "counts": {
            "runs": len(runs),
            "effect_runs": len(effect_runs),
            "environment_unavailable": len(excluded_runs),
            "task_card_mismatch": len(task_card_mismatch),
            "paired_tasks": n_pairs,
            "by_arm": {arm: sum(1 for run in runs if run.arm == arm) for arm in ("off", "native", "staged")},
        },
        "environment_unavailable_runs": [
            {"runId": run.run_id, "taskId": run.task_id, "arm": run.arm, "reason": run.env_reason}
            for run in excluded_runs
        ],
        "task_card_mismatch_runs": [
            {"runId": run.run_id, "taskId": run.task_id, "arm": run.arm}
            for run in task_card_mismatch
        ],
        "primary": primary,
        "guardrails": guardrails,
        "cost": cost,
        "repeat_consistency": consistency,
        "faults": faults,
        "strata": strata,
        "decision": {
            "improved_primary": improved_primary,
            "worsened_primary": worsened_primary,
            "guardrails_ok": guardrails_ok,
            "cost_ok": cost["within_caps"],
            "conclusion": conclusion,
            "note": conclusion_note,
            "rule": "草稿规则（PLACEHOLDER）：主指标≥2项 95% CI 显示改善且无任何主指标恶化；守护指标全部非劣效（CI 下界 > 界值）；成本未超限；无不可接受故障。",
        },
    }


# ---- 输出 -------------------------------------------------------------------


def fmt(value, digits=3):
    if value is None:
        return "N/A"
    if isinstance(value, bool):
        return "是" if value else "否"
    if isinstance(value, float):
        if math.isnan(value):
            return "N/A"
        return f"{value:.{digits}f}"
    return str(value)


def render_markdown(report: dict, source: str) -> str:
    counts = report["counts"]
    config = report["config"]
    lines = [
        "# ROADMAP-95 B6 统计报告（骨架）",
        "",
        f"- 输入：`{source}`",
        f"- 运行数：{counts['runs']}（off={counts['by_arm']['off']}，native={counts['by_arm']['native']}，staged={counts['by_arm']['staged']}）；有效={counts['effect_runs']}，环境不可用={counts['environment_unavailable']}；配对任务={counts['paired_tasks']}",
        f"- bootstrap：seed={config['seed']}，n_boot={config['n_boot']}（按任务重抽样）；非劣效界值={config['noninferiority_margin']}；min_pairs={config['min_pairs']}；分析 repetition={config['repetition']}",
        "",
        "> 本报告是**统计骨架输出**：正式结论须在 PREREG 锁定后按同一口径复核；成本上限与非劣效界值当前是占位值（见 eval/PREREG.md §5、§6）。",
        "",
        "## 1. 主指标（越小越好）",
        "",
        "| 指标 | off 率 (Wilson 95% CI) | native 率 (Wilson 95% CI) | 绝对差 | 相对变化 | 95% bootstrap CI | 精确 McNemar (改善/恶化, p) | 结论 |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for key, entry in report["primary"].items():
        if entry.get("status") != "ok":
            lines.append(f"| {entry['name']} | 证据不足：{entry.get('reason')} | | | | | | 证据不足 |")
            continue
        off = entry["off"]
        native = entry["native"]
        mc = entry["mcnemar"]
        significance = entry.get("superiority", {})
        verdict = "显著改善" if significance.get("improved") else ("显著恶化" if significance.get("worsened") else "无显著差异")
        lines.append(
            f"| {entry['name']} | {fmt(off['rate'])} ({fmt(off['wilson_ci'][0])}–{fmt(off['wilson_ci'][1])}) "
            f"| {fmt(native['rate'])} ({fmt(native['wilson_ci'][0])}–{fmt(native['wilson_ci'][1])}) "
            f"| {fmt(entry['absolute_difference'])} | {fmt(entry['relative_change']) if entry['relative_change'] is not None else 'N/A（对照组为 0）'} "
            f"| [{fmt(entry['bootstrap_ci'][0])}, {fmt(entry['bootstrap_ci'][1])}] "
            f"| {mc['improved']}/{mc['worsened']}, p={fmt(mc['exact_p'])} | {verdict} |"
        )

    lines += [
        "",
        "## 2. 守护指标（必须非劣效；方向已归一化为“越大越好”）",
        "",
        "| 指标 | off 率 | native 率 | 绝对差 | 95% bootstrap CI | CI 下界 vs 界值 | 非劣效 | 精确 McNemar (改善/恶化, p) |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for key, entry in report["guardrails"].items():
        if entry.get("status") != "ok":
            lines.append(f"| {entry['name']} | 证据不足：{entry.get('reason')} | | | | | | |")
            continue
        ni = entry["noninferiority"]
        lines.append(
            f"| {entry['name']} | {fmt(entry['off']['rate'])} | {fmt(entry['native']['rate'])} "
            f"| {fmt(entry['absolute_difference'])} | [{fmt(entry['bootstrap_ci'][0])}, {fmt(entry['bootstrap_ci'][1])}] "
            f"| {fmt(ni['ci_lower'])} vs {fmt(ni['margin'])} | {'是' if ni['non_inferior'] else '否'} "
            f"| {entry['mcnemar']['improved']}/{entry['mcnemar']['worsened']}, p={fmt(entry['mcnemar']['exact_p'])} |"
        )

    cost = report["cost"]
    values = cost["values"]
    lines += [
        "",
        "## 3. 成本指标与上限",
        "",
        "| 指标 | native 值 | 上限 | 是否超限 |",
        "| --- | --- | --- | --- |",
        f"| 耗时中位数（分钟） | {fmt(values['native_median_minutes'])} | {fmt(cost['caps']['median_minutes_max'])} | {'超限' if not cost['checks']['median_minutes_max'] else '未超限'} |",
        f"| 耗时 P90（分钟） | {fmt(values['native_p90_minutes'])} | {fmt(cost['caps']['p90_minutes_max'])} | {'超限' if not cost['checks']['p90_minutes_max'] else '未超限'} |",
        f"| token 中位数 | {fmt(values['native_median_tokens'], 0)} | {fmt(cost['caps']['median_tokens_max'], 0)} | {'超限' if not cost['checks']['median_tokens_max'] else '未超限'} |",
        f"| token P90 | {fmt(values['native_p90_tokens'], 0)} | {fmt(cost['caps']['p90_tokens_max'], 0)} | {'超限' if not cost['checks']['p90_tokens_max'] else '未超限'} |",
        f"| 超时率 | {fmt(values['native_timeout_rate'])} | {fmt(cost['caps']['timeout_rate_max'])} | {'超限' if not cost['checks']['timeout_rate_max'] else '未超限'} |",
        f"| 人工介入中位数 | {fmt(values['native_human_intervention_median'])} | {fmt(cost['caps']['human_intervention_median_max'])} | {'超限' if not cost['checks']['human_intervention_median_max'] else '未超限'} |",
        f"| 极慢运行占比（>3× 对照同任务中位数） | {fmt(values['native_very_slow_share'])} | {fmt(cost['caps']['very_slow_share_max'])} | {'超限' if not cost['checks']['very_slow_share_max'] else '未超限'} |",
        "",
        f"总体成本状态：{'未超限' if cost['within_caps'] else '超限：' + ', '.join(cost['exceeded'])}。{cost['note']}",
        "",
        "## 4. 重复一致性（正式实验 20% 重复）",
        "",
        "| 指标 | 对比次数 | 一致次数 | 一致率 |",
        "| --- | --- | --- | --- |",
    ]
    for key, entry in report["repeat_consistency"].items():
        lines.append(f"| {key} | {entry['compared']} | {entry['agreed']} | {fmt(entry['agreement_rate'])} |")
    if not any(entry["compared"] for entry in report["repeat_consistency"].values()):
        lines.append("| 无重复运行数据 | 0 | 0 | N/A |")

    lines += ["", "## 5. 分层（仓库/模型/类别）", ""]
    for dimension, groups in report["strata"].items():
        lines.append(f"### {dimension}")
        lines.append("")
        lines.append("| 分层 | 配对任务数 | 结论 |")
        lines.append("| --- | --- | --- |")
        for value, entry in groups.items():
            lines.append(f"| {value} | {entry['n_pairs']} | {entry['conclusion']} |")
        lines.append("")

    lines += ["## 6. 不可接受故障与判定", ""]
    if report["faults"]:
        for fault in report["faults"]:
            lines.append(f"- 故障：`{fault['runId']}`（{fault['taskId']}）：{', '.join(fault['faults'])}")
    else:
        lines.append("- 未记录不可接受故障（V1–V3）。")
    decision = report["decision"]
    lines += [
        "",
        f"- 主指标显著改善：{', '.join(decision['improved_primary']) or '无'}；显著恶化：{', '.join(decision['worsened_primary']) or '无'}",
        f"- 守护指标全部非劣效：{'是' if decision['guardrails_ok'] else '否'}；成本未超限：{'是' if decision['cost_ok'] else '否'}",
        f"- **结论：{decision['conclusion']}** —— {decision['note']}",
        f"- 判定规则：{decision['rule']}",
        "",
        "## 7. 排除与边界",
        "",
        f"- 环境不可用运行：{len(report['environment_unavailable_runs'])} 条（不计入效果指标，计入成本/稳定性并分组报告）。",
    ]
    for run in report["environment_unavailable_runs"]:
        lines.append(f"  - `{run['runId']}`（{run['taskId']}/{run['arm']}）：{run['reason'] or '未说明原因'}")
    lines.append(f"- 任务卡不一致运行：{len(report['task_card_mismatch_runs'])} 条（`taskCard.verifiedEqual != true`，不计入效果指标）。")
    for run in report["task_card_mismatch_runs"]:
        lines.append(f"  - `{run['runId']}`（{run['taskId']}/{run['arm']}）：任务卡不一致，运行无效")
    lines += [
        "- 本报告不构成真实宿主演收结论；样本量、成本上限、非劣效界值须由负责人按 PREREG 确认。",
        "- 分层只做描述性报告；样本不足的分层标“证据不足”，不得外推。",
        "",
    ]
    return "\n".join(lines)


# ---- 自测 -------------------------------------------------------------------


def _synthetic_runs(offs: list[bool], natives: list[bool], metric: str) -> list[Run]:
    runs: list[Run] = []
    for index, (off_value, native_value) in enumerate(zip(offs, natives)):
        task = f"t{index + 1:02d}"
        for arm, value in (("off", off_value), ("native", native_value)):
            record = {
                "runId": f"{task}-{arm}",
                "batch": "selftest",
                "taskCard": {"sha256": "0" * 64, "deliveryMechanism": "issue-body", "verifiedEqual": True},
                "taskId": task,
                "repo": "synthetic/repo",
                "arm": arm,
                "repetition": 1,
                "validationEnvironment": {"status": "available"},
                "outOfScopeChanges": {"has": value} if metric == "outOfScopeRate" else {"has": False},
                "unrelatedChanges": {"has": value} if metric == "unrelatedRate" else {"has": False},
                "objectiveChanged": ("changed-to-other" if value else "unchanged") if metric == "objectiveChangedRate" else "unchanged",
                "requiredFunctionImplemented": ("complete" if value else "partial") if metric == "requiredCompleteRate" else "complete",
                "implementationDefect": {"verdict": ("none" if value else "has-defect") if metric == "defectFreeRate" else "none"},
                "delivery": ("ready-pr-created" if value else "blocked") if metric == "deliveryRate" else "ready-pr-created",
                "wallClockSeconds": 10.0,
                "timeout": False,
                "tokens": {"total": 1000},
                "humanIntervention": {"count": 0},
            }
            runs.append(parse_run(record))
    return runs


def self_test(as_json: bool = False) -> int:
    steps: list[dict] = []

    def record(name: str, ok: bool, detail: str) -> None:
        steps.append({"name": name, "ok": bool(ok), "detail": detail})

    # 1) CI 与 McNemar 已知答案：6 个任务 off=事件、native=无事件（主指标改善 -1）。
    offs = [True] * 6
    natives = [False] * 6
    runs = _synthetic_runs(offs, natives, "outOfScopeRate")
    pairs = paired_tasks(runs, 1)
    result = evaluate_metric(pairs, "outOfScopeRate", "smaller", 2000, 20261107, -0.05)
    ci = result["bootstrap_ci"]
    expected_p = 2 * (0.5 ** 6)
    record("CI 已知答案：6 个任务差值恒为 -1 → CI=[-1,-1]", abs(ci[0] + 1) < 1e-9 and abs(ci[1] + 1) < 1e-9, f"ci={ci}")
    record("精确 McNemar：改善6/恶化0 → p=2*0.5^6", abs(result["mcnemar"]["exact_p"] - expected_p) < 1e-9, f"p={result['mcnemar']['exact_p']} expected={expected_p}")
    record("主指标判定：显著改善", result["superiority"]["improved"] is True, json.dumps(result["superiority"]))

    # 2) McNemar 对称不一致 → p=1；单侧已知 p。
    record("精确 McNemar：5/5 → p=1", abs(mcnemar_exact(5, 5) - 1.0) < 1e-12, f"p={mcnemar_exact(5, 5)}")
    record("精确 McNemar：10/0 → p=0.001953125", abs(mcnemar_exact(10, 0) - 0.001953125) < 1e-12, f"p={mcnemar_exact(10, 0)}")

    # 3) 非劣效反例：守护指标 native 全面变差 → 判 inferior。
    guard_runs = _synthetic_runs([True] * 6, [False] * 6, "requiredCompleteRate")
    guard_result = evaluate_metric(paired_tasks(guard_runs, 1), "requiredCompleteRate", "larger", 2000, 20261107, -0.05)
    record("非劣效反例：CI 下界 -1 <= -0.05 → 非劣效不成立", guard_result["noninferiority"]["non_inferior"] is False, json.dumps(guard_result["noninferiority"]))
    equal_runs = _synthetic_runs([True] * 6, [True] * 6, "requiredCompleteRate")
    equal_result = evaluate_metric(paired_tasks(equal_runs, 1), "requiredCompleteRate", "larger", 2000, 20261107, -0.05)
    record("非劣效正例：差值 0 → CI 下界 0 > -0.05", equal_result["noninferiority"]["non_inferior"] is True, json.dumps(equal_result["noninferiority"]))

    # 4) 成本超限：native 耗时中位数 40 > 上限 30。
    cost_runs = _synthetic_runs([True] * 6, [True] * 6, "outOfScopeRate")
    for run in cost_runs:
        if run.arm == "native":
            run.minutes = 40.0
    cost = evaluate_cost(paired_tasks(cost_runs, 1), cost_runs, {**DEFAULT_COST_CAPS, "median_minutes_max": 30.0})
    record("成本超限：native 中位耗时 40 > 上限 30", cost["within_caps"] is False and "median_minutes_max" in cost["exceeded"], json.dumps(cost["exceeded"]))
    within_runs = _synthetic_runs([True] * 6, [True] * 6, "outOfScopeRate")
    within = evaluate_cost(paired_tasks(within_runs, 1), within_runs, DEFAULT_COST_CAPS)
    record("成本未超限：native 中位耗时 10 <= 上限 30", within["within_caps"] is True, json.dumps(within["exceeded"]))

    # 5) 样本不足：只有 1 对 → evidence_insufficient。
    tiny_runs = _synthetic_runs([True], [False], "outOfScopeRate")
    tiny_report = analyze(tiny_runs, {"min_pairs": 5, "n_boot": 500})
    record("样本不足：n_pairs=1 < min_pairs=5 → evidence_insufficient", tiny_report["decision"]["conclusion"] == "evidence_insufficient", tiny_report["decision"]["conclusion"])

    # 6) 输入校验：缺字段 → 清晰 ValueError（不抛栈）。
    cases = [
        ({"runId": "x", "validationEnvironment": {"status": "available"}}, "缺少字段"),
        ({"runId": "x", "batch": "b", "taskId": "t", "repo": "r", "arm": "off"}, "validationEnvironment.status"),
    ]
    details = []
    bad_input = True
    for record_, expected in cases:
        try:
            parse_run(record_)
            bad_input = False
            details.append(f"{expected}: 未抛错")
        except ValueError as error:
            details.append(str(error))
            if expected not in str(error):
                bad_input = False
    record("输入校验：缺字段抛清晰 ValueError", bad_input, "; ".join(details))

    ok = all(step["ok"] for step in steps)
    if as_json:
        print(json.dumps({"selfTest": ok, "steps": steps}, ensure_ascii=False, indent=2))
    else:
        for step in steps:
            print(f"{'PASS' if step['ok'] else 'FAIL'} {step['name']} :: {step['detail']}")
        print("SELF-TEST: PASS" if ok else "SELF-TEST: FAIL")
    return 0 if ok else 1


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="ROADMAP-95 B6 统计报告骨架")
    parser.add_argument("--input", help="运行记录 JSON（数组或 {runs:[...]}）")
    parser.add_argument("--format", choices=["markdown", "json"], default="markdown")
    parser.add_argument("--out", help="输出文件；缺省打印到 stdout")
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--n-boot", type=int, default=DEFAULT_N_BOOT)
    parser.add_argument("--min-pairs", type=int, default=DEFAULT_MIN_PAIRS)
    parser.add_argument("--noninferiority-margin", type=float, default=DEFAULT_NONINFERIORITY_MARGIN)
    parser.add_argument("--repetition", type=int, default=1, help="配对分析使用第几次运行（默认 1；重复运行只用于一致性）")
    parser.add_argument("--caps-json", help="覆盖成本上限的 JSON 文件（键见 DEFAULT_COST_CAPS）")
    parser.add_argument("--self-test", action="store_true", help="用合成数据跑已知答案自测")
    args = parser.parse_args(argv)

    if args.self_test:
        return self_test(args.format == "json")
    if not args.input:
        print("[report] 需要 --input <runs.json>（或使用 --self-test）", file=sys.stderr)
        return 2
    try:
        with open(args.input, "r", encoding="utf-8") as handle:
            document = json.load(handle)
    except FileNotFoundError:
        print(f"[report] 输入文件不存在：{args.input}", file=sys.stderr)
        return 2
    except json.JSONDecodeError as error:
        print(f"[report] 输入不是合法 JSON：{error}", file=sys.stderr)
        return 2
    try:
        runs = load_runs(document)
    except ValueError as error:
        print(f"[report] 输入校验失败：{error}", file=sys.stderr)
        return 1

    cost_caps = None
    if args.caps_json:
        try:
            with open(args.caps_json, "r", encoding="utf-8") as handle:
                cost_caps = json.load(handle)
        except (FileNotFoundError, json.JSONDecodeError) as error:
            print(f"[report] --caps-json 读取失败：{error}", file=sys.stderr)
            return 2

    report = analyze(runs, {
        "seed": args.seed,
        "n_boot": args.n_boot,
        "min_pairs": args.min_pairs,
        "noninferiority_margin": args.noninferiority_margin,
        "repetition": args.repetition,
        "cost_caps": cost_caps,
    })
    output = json.dumps(report, ensure_ascii=False, indent=2) if args.format == "json" else render_markdown(report, args.input)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as handle:
            handle.write(output + ("\n" if not output.endswith("\n") else ""))
        print(f"[report] 已写入 {args.out}")
    else:
        print(output)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
