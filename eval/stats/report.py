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
import re
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

# ---- 常量（数值以 PREREG v1.3 LOCKED 为准，见 eval/PREREG.md） ----------------

DEFAULT_SEED = 20261108
# PREREG v1.2 分组：legacy-system=原系统组(对照) / full-package=整包组(处理)；
# off/native 为旧 B5 历史值，读取时归一化为 control/treatment。
CONTROL_ARMS = ("legacy-system", "off")
TREATMENT_ARMS = ("full-package", "native")
def normalize_arm(arm: str) -> str:
    if arm in CONTROL_ARMS: return "control"
    if arm in TREATMENT_ARMS: return "treatment"
    return arm
DEFAULT_N_BOOT = 10000
DEFAULT_MIN_PAIRS = 67
DEFAULT_NONINFERIORITY_MARGIN = -0.05
# F16：标注一致性（Cohen's kappa）显式低于该阈值时，报告不得给出 meets_prereg。
MIN_LABEL_KAPPA = 0.7

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
    "_comment": "成本上限以 PREREG v1.3 LOCKED 为准；本工具不自行改动门槛（见 eval/PREREG.md §5）。",
    "median_minutes_max": 30.0,
    "p90_minutes_max": 60.0,
    "median_tokens_max": 1000000,
    "p90_tokens_max": 2000000,
    "timeout_rate_max": 0.10,
    "human_intervention_median_max": 1.0,
    "very_slow_share_max": 0.20,
}

# S02：PREREG v1.3 LOCKED 的冻结实验条件（§1 Q1 / §7.5 / §9）。
# HEPHI/SA 以锁定短 SHA 为准（SA d0e64d6 只记录了 7 位，按前缀核对；其余为完整 SHA）。
LOCKED_MODEL_ID = "deepseek-flash"
LOCKED_ARTIFACTS = {
    "control": {"hephi": "6d24e1b39b75948b02c7dbd5fbac3e1af3c5ff80", "sa": "62d7d53723e5841eca5e02b151c1b48653650ea4"},
    "treatment": {"hephi": "055491d016078b6d92eaa4d95364b097938e58fc", "sa": "d0e64d6"},
}
# S06：PREREG §5 单次运行停止线（达到任一下限即停）。
HARD_STOP_MINUTES = 60.0
HARD_STOP_TOKENS = 3_000_000


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
    minutes: float | None
    tokens: int | None
    tokens_input: int | None
    tokens_output: int | None
    timeout: bool
    human_interventions: int
    task_card_ok: bool
    task_sha256: str | None
    base: str | None
    acceptance_invalid: bool
    test_weakening: bool | None
    label_kappa: float | None
    label_batch_id: str | None = None
    labelers: list[str] = field(default_factory=list)
    label_present: bool = False
    model_temperature: object = None
    host_version: str | None = None
    plugin_loaded: str | None = None
    plugin_candidate: str | None = None
    plugin_readback: str | None = None
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


SHORT_ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{1,63}$")
SHA40_RE = re.compile(r"^[0-9a-f]{40}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
DELIVERIES = ("ready-pr-created", "blocked", "timeout", "failed")
ARMS = ("legacy-system", "full-package", "off", "native", "staged")
IMPLEMENTATION_VERDICTS = ("none", "has-defect", "unlabeled")


def _is_number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value))


def _is_int(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def record_contract_errors(record: dict) -> list[str]:
    """S01：统计入口的完整字段契约（与 run.schema.json 的 required/类型/枚举/数值下限一致）。

    缺失/类型错/枚举非法/数值非法一律拒绝或保留 unknown，不把缺失默认成有利值。
    """
    if not isinstance(record, dict):
        return ["每条运行记录必须是对象"]
    errors: list[str] = []

    def get(path: str, *, required: bool = True):
        current = record
        for part in path.split("."):
            if not isinstance(current, dict) or part not in current:
                if required:
                    errors.append(f"缺少字段：{path}")
                return None
            current = current[part]
        return current

    def expect(path: str, ok: bool, detail: str):
        if not ok:
            errors.append(f"字段 {path} 非法：{detail}")

    def require_string(path: str, *, nullable: bool = False):
        value = get(path)
        if value is None:
            if not nullable and not any(item == f"缺少字段：{path}" for item in errors):
                errors.append(f"字段 {path} 不可为 null")
            return
        expect(path, isinstance(value, str) and value != "", f"期望非空字符串，实际 {type(value).__name__}")

    def require_bool(path: str):
        value = get(path)
        expect(path, isinstance(value, bool), f"期望 boolean，实际 {type(value).__name__}")

    def require_int(path: str, *, minimum: int | None = None, nullable: bool = False):
        value = get(path, required=not nullable)
        if value is None:
            if not nullable and not any(item == f"缺少字段：{path}" for item in errors):
                errors.append(f"字段 {path} 不可为 null")
            return
        expect(path, _is_int(value), f"期望 integer，实际 {type(value).__name__}")
        if _is_int(value) and minimum is not None:
            expect(path, value >= minimum, f"必须 >= {minimum}，实际 {value}")

    def require_number(path: str, *, minimum: float | None = None, nullable: bool = False):
        value = get(path, required=not nullable)
        if value is None:
            if not nullable and not any(item == f"缺少字段：{path}" for item in errors):
                errors.append(f"字段 {path} 不可为 null")
            return
        expect(path, _is_number(value), f"期望有限数字，实际 {type(value).__name__}")
        if _is_number(value) and minimum is not None:
            expect(path, float(value) >= minimum, f"必须 >= {minimum}，实际 {value}")

    def require_sha(path: str, pattern, *, nullable: bool = False):
        require_string(path, nullable=nullable)
        value = get(path)
        if isinstance(value, str):
            expect(path, bool(pattern.match(value)), "不是合法 SHA（小写十六进制）")

    require_int("schemaVersion")
    expect("schemaVersion", get("schemaVersion") == 1, "必须为 1")
    for field in ("runId", "batch", "taskId"):
        require_string(field)
        value = get(field)
        if isinstance(value, str):
            expect(field, bool(SHORT_ID_RE.match(value)), "必须匹配 ^[a-z0-9][a-z0-9._-]{1,63}$")
    require_string("repo")
    require_sha("base", SHA40_RE)
    require_sha("head", SHA40_RE)
    arm = get("arm")
    expect("arm", arm in ARMS, f"必须是 {ARMS}")
    execution_mode = get("executionMode")
    expect("executionMode", execution_mode in ("normal", "shadow"), "必须是 normal/shadow")
    require_int("repetition", minimum=1)
    require_int("seed")
    require_string("startedAt")
    require_string("endedAt")
    require_number("wallClockSeconds", minimum=0)
    require_bool("timeout")
    category = get("category", required=False)
    expect("category", category is None or category in ("defect-fix", "new-feature", "behavior-preserving-refactor", "cross-module", "staged-suitable", "unknown"), "category 枚举非法")

    model = get("model")
    expect("model", isinstance(model, dict), "必须是对象")
    if isinstance(model, dict):
        expect("model.id", isinstance(model.get("id"), str) and model.get("id") != "", "id 必须是非空字符串")
        provider = model.get("provider", "<missing>")
        expect("model.provider", provider is None or isinstance(provider, str), "provider 必须是字符串或 null")
        parameters = model.get("parameters")
        expect("model.parameters", isinstance(parameters, dict), "必须是对象")
        temperature = parameters.get("temperature") if isinstance(parameters, dict) else None
        expect("model.parameters.temperature", temperature == "uncontrolled" or _is_number(temperature), "必须是 number 或 uncontrolled")
        expect("model.parametersSource", model.get("parametersSource") in ("host-config", "run-config", "unavailable"), "必须 host-config/run-config/unavailable")

    host = get("host")
    expect("host", isinstance(host, dict), "必须是对象")
    if isinstance(host, dict):
        expect("host.version", isinstance(host.get("version"), str) and host.get("version") != "", "version 必须是非空字符串")

    plugin = get("plugin")
    expect("plugin", isinstance(plugin, dict), "必须是对象")
    if isinstance(plugin, dict):
        for field in ("candidateSha", "baselineSha", "loadedSha"):
            value = plugin.get(field, "<missing>")
            expect(f"plugin.{field}", value is None or (isinstance(value, str) and bool(SHA40_RE.match(value))), "必须是 40hex SHA 或 null")
        expect("plugin.loadedShaReadback", plugin.get("loadedShaReadback") in ("verified", "unverified", "unavailable"), "必须 verified/unverified/unavailable")

    card = get("taskCard")
    expect("taskCard", isinstance(card, dict), "必须是对象")
    if isinstance(card, dict):
        sha = card.get("sha256")
        expect("taskCard.sha256", sha is None or (isinstance(sha, str) and bool(SHA256_RE.match(sha))), "必须是 64hex 或 null")
        expect("taskCard.deliveryMechanism", isinstance(card.get("deliveryMechanism"), str) and card.get("deliveryMechanism") != "", "必须是非空字符串")
        expect("taskCard.verifiedEqual", isinstance(card.get("verifiedEqual"), bool), "必须是 boolean")

    tokens = get("tokens")
    expect("tokens", isinstance(tokens, dict), "必须是对象")
    if isinstance(tokens, dict):
        for field in ("input", "output", "total", "cacheRead", "cacheWrite"):
            if field in tokens:
                value = tokens.get(field)
                expect(f"tokens.{field}", value is None or (_is_int(value) and value >= 0), "必须是 >=0 integer 或 null")
        total = tokens.get("total")
        input_tokens = tokens.get("input")
        output_tokens = tokens.get("output")
        # S05/N05：每个已知分量独立核验下界，不依赖另一分量是否存在。
        if _is_int(total) and _is_int(output_tokens):
            expect("tokens.total", total >= output_tokens, f"total({total}) 不能小于 output({output_tokens})")
        if _is_int(total) and _is_int(input_tokens):
            expect("tokens.total", total >= input_tokens, f"total({total}) 不能小于 input({input_tokens})")
        if _is_int(total) and _is_int(input_tokens) and _is_int(output_tokens):
            expect("tokens.total", total >= input_tokens + output_tokens, f"total({total}) 不能小于 input+output({input_tokens + output_tokens})")

    decision_log = get("decisionLog")
    if decision_log is not None and not isinstance(decision_log, dict):
        errors.append("字段 decisionLog 必须是对象或 null")
    expect("objectiveChanged", isinstance(get("objectiveChanged"), str) and get("objectiveChanged") != "", "必须是字符串")
    expect("requiredFunctionImplemented", isinstance(get("requiredFunctionImplemented"), str) and get("requiredFunctionImplemented") != "", "必须是字符串")
    defect = get("implementationDefect")
    expect("implementationDefect", isinstance(defect, dict), "必须是对象")
    if isinstance(defect, dict):
        expect("implementationDefect.verdict", defect.get("verdict") in IMPLEMENTATION_VERDICTS, f"必须是 {IMPLEMENTATION_VERDICTS}")
    env = get("validationEnvironment")
    expect("validationEnvironment", isinstance(env, dict), "必须是对象")
    if isinstance(env, dict):
        expect("validationEnvironment.status", env.get("status") in ("available", "unavailable"), "必须是 available/unavailable")
        expect("validationEnvironment.reason", env.get("reason") is None or isinstance(env.get("reason"), str), "reason 必须是字符串或 null")
    delivery = get("delivery")
    expect("delivery", delivery in DELIVERIES, f"必须是 {DELIVERIES}")
    out_of_scope = get("outOfScopeChanges")
    expect("outOfScopeChanges", isinstance(out_of_scope, dict), "必须是对象")
    if isinstance(out_of_scope, dict):
        expect("outOfScopeChanges.has", isinstance(out_of_scope.get("has"), bool), "has 必须是 boolean（缺失不得默认 false）")
    unrelated = get("unrelatedChanges")
    expect("unrelatedChanges", isinstance(unrelated, dict), "必须是对象")
    if isinstance(unrelated, dict):
        expect("unrelatedChanges.has", unrelated.get("has") is None or isinstance(unrelated.get("has"), bool), "has 必须是 boolean 或 null")
    weakening = get("testWeakening")
    expect("testWeakening", isinstance(weakening, dict), "必须是对象")
    if isinstance(weakening, dict):
        expect("testWeakening.has", weakening.get("has") is None or isinstance(weakening.get("has"), bool), "has 必须是 boolean 或 null")
    human = get("humanIntervention")
    expect("humanIntervention", isinstance(human, dict), "必须是对象")
    if isinstance(human, dict):
        expect("humanIntervention.count", _is_int(human.get("count")) and human.get("count") >= 0, "count 必须是 >=0 integer（缺失不得默认 0）")
    faults = get("faults", required=False)
    if faults is not None:
        expect("faults", isinstance(faults, dict), "必须是对象")
        if isinstance(faults, dict):
            for key in ("unexpectedDeliveryReleased", "unsafeRecovery"):
                if key in faults:
                    expect(f"faults.{key}", isinstance(faults.get(key), bool), "必须是 boolean")
    label = get("label", required=False)
    if label is not None:
        expect("label", isinstance(label, dict), "必须是对象")
        if isinstance(label, dict):
            kappa = label.get("kappa")
            expect("label.kappa", kappa is None or (_is_number(kappa) and -1 <= float(kappa) <= 1), "必须是 [-1,1] 数字或 null")
            labelers = label.get("labelers")
            expect("label.labelers", labelers is None or (isinstance(labelers, list) and all(isinstance(item, str) and item for item in labelers)), "labelers 必须是字符串数组")
    return errors


def parse_run(record: dict) -> Run:
    if not isinstance(record, dict):
        raise ValueError("每条运行记录必须是对象")
    contract_errors = record_contract_errors(record)
    if contract_errors:
        raise ValueError("运行记录字段契约不满足：" + "；".join(contract_errors[:10]))
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
    tokens_input = tokens_block.get("input")
    tokens_output = tokens_block.get("output")
    for name, value in (("tokens.input", tokens_input), ("tokens.output", tokens_output)):
        if value is not None and not isinstance(value, int):
            raise ValueError(f"{name} 必须是整数或 null")
    task_card = record.get("taskCard") or {}
    card_sha = task_card.get("sha256")
    if card_sha is not None and not isinstance(card_sha, str):
        raise ValueError("taskCard.sha256 必须是字符串或 null")
    # R8：testWeakening.has 属于 B4 必填盲评字段；保留 null（未标注）而不是改成 False。
    test_weakening_block = record.get("testWeakening") or {}
    test_weakening = test_weakening_block.get("has")
    if test_weakening is not None and not isinstance(test_weakening, bool):
        raise ValueError("testWeakening.has 必须是布尔或 null")
    label = record.get("label") or {}
    kappa = label.get("kappa")
    if kappa is not None and not isinstance(kappa, (int, float)):
        raise ValueError("label.kappa 必须是数字或 null")
    if isinstance(kappa, bool):
        raise ValueError("label.kappa 必须是数字或 null")
    acceptance = record.get("acceptanceVerdict")
    wall_clock = record.get("wallClockSeconds")
    if wall_clock is not None and not isinstance(wall_clock, (int, float)):
        raise ValueError("wallClockSeconds 必须是数字或 null")
    model_block = record["model"]
    plugin_block = record["plugin"]
    host_block = record["host"]
    label_block = record.get("label") if isinstance(record.get("label"), dict) else None
    return Run(
        run_id=str(_require(record, "runId", str)),
        batch=str(_require(record, "batch", str)),
        task_id=str(_require(record, "taskId", str)),
        repo=str(_require(record, "repo", str)),
        category=str(record.get("category") or "unknown"),
        model=str(model_block["id"]),
        arm=str(_require(record, "arm", str)),
        repetition=int(record.get("repetition", 1)),
        env_available=env_status == "available",
        env_reason=env.get("reason"),
        out_of_scope=record["outOfScopeChanges"]["has"],
        unrelated=unrelated,
        objective_changed=objective_changed,
        required_complete=required_complete,
        defect_free=defect_free,
        delivered=delivery == "ready-pr-created",
        # F03：记录单位是秒，比较与展示统一用分钟。
        minutes=None if wall_clock is None else float(wall_clock) / 60.0,
        tokens=tokens,
        tokens_input=tokens_input,
        tokens_output=tokens_output,
        timeout=record["timeout"],
        human_interventions=record["humanIntervention"]["count"],
        task_card_ok=task_card.get("verifiedEqual") is True,
        task_sha256=card_sha,
        base=record.get("base") if isinstance(record.get("base"), str) else None,
        acceptance_invalid=acceptance == "invalid",
        test_weakening=test_weakening,
        label_kappa=None if kappa is None else float(kappa),
        label_batch_id=(label_block or {}).get("batchId"),
        labelers=list((label_block or {}).get("labelers") or []),
        label_present=label_block is not None,
        model_temperature=(model_block.get("parameters") or {}).get("temperature"),
        host_version=host_block.get("version"),
        plugin_loaded=plugin_block.get("loadedSha"),
        plugin_candidate=plugin_block.get("candidateSha"),
        plugin_readback=plugin_block.get("loadedShaReadback"),
        faults=fault_list,
    )


def validate_runs(runs: list[Run]) -> list[Run]:
    """F09：单批/混代/任务同一性/重复记录的输入级校验；CLI 与直接 analyze() 共用同一公共路径。"""
    if not runs:
        raise ValueError("输入必须包含至少一条运行记录")
    for run in runs:
        if run.arm not in ("legacy-system", "full-package", "off", "native", "staged"):
            raise ValueError(f"arm 非法：{run.arm}")
    # PREREG v1.2：禁止新旧对照对象混配（off/native=旧B5，legacy-system/full-package=现行）。
    # 同一输入同时出现两代 arm 值即拒绝，防止旧批次 off 与新批次 full-package 被配成一对。
    arms = {run.arm for run in runs}
    if arms & {"off", "native"} and arms & {"legacy-system", "full-package"}:
        raise ValueError("arm 混代：off/native（旧 B5 对照）与 legacy-system/full-package（PREREG v1.2 现行对照）不得混入同一输入")
    batches = {run.batch for run in runs}
    if len(batches) > 1:
        raise ValueError(f"多批次输入：{sorted(batches)}；本统计入口一次只接受一个 batch（防跨批虚增独立任务数/重复关联），跨批汇总不在本工具范围")
    # S03：输入级 runId 唯一性（同 task 不同 repetition 仍允许，但 runId 不得重复）。
    seen_run_ids: dict[str, str] = {}
    for run in runs:
        if run.run_id in seen_run_ids:
            raise ValueError(
                f"重复 runId：{run.run_id} 同时出现在 task={seen_run_ids[run.run_id]} 与 {run.task_id}；"
                "runId 必须唯一，拒绝用重复 ID 代表多次运行"
            )
        seen_run_ids[run.run_id] = run.task_id
    # F10：输入级检查全部 repetition 的 (task, arm, repetition) 唯一性；重复记录一律拒绝。
    seen: dict[tuple[str, str, str, int], str] = {}
    for run in runs:
        key = (run.task_id, run.batch, normalize_arm(run.arm), run.repetition)
        if key in seen:
            raise ValueError(
                f"重复运行记录：task={run.task_id} batch={run.batch} arm={run.arm} repetition={run.repetition} "
                f"同时出现在 {seen[key]} 与 {run.run_id}；拒绝静默覆盖（含 repetition>=2）"
            )
        seen[key] = run.run_id
    # F02：同一 taskId 的冻结条件（repo/base/model）必须一致；不一致即拒绝，不把人工布尔值当全部证据。
    by_task: dict[tuple[str, str], list[Run]] = {}
    for run in runs:
        by_task.setdefault((run.task_id, run.batch), []).append(run)
    for (task_id, batch), group in by_task.items():
        for name in ("repo", "base", "model"):
            values = {getattr(run, name) for run in group if getattr(run, name) is not None}
            if len(values) > 1:
                raise ValueError(
                    f"同 taskId 的 {name} 不一致：task={task_id} batch={batch} -> {sorted(values)}；两臂不可配对"
                )
    return runs


def load_runs(document) -> list[Run]:
    records = document.get("runs") if isinstance(document, dict) else document
    if not isinstance(records, list) or not records:
        raise ValueError("输入必须是运行记录数组，或 {\"runs\": [...]} 且非空")
    return validate_runs([parse_run(record) for record in records])


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
    """按 (taskId, batch) 配对两臂的 repetition 指定运行；跨批次不得配对；
    同 (taskId, batch, arm) 出现多条主记录时 fail-closed 拒绝（不静默取第一条）。"""
    pairs: dict[tuple[str, str], dict[str, Run]] = {}
    for run in runs:
        if run.repetition != repetition:
            continue
        arm = normalize_arm(run.arm)
        if arm not in ("control", "treatment"):
            continue
        key = (run.task_id, run.batch)
        bucket = pairs.setdefault(key, {})
        if arm in bucket:
            raise ValueError(f"重复主记录：task={run.task_id} batch={run.batch} arm={run.arm} 出现多条 repetition={repetition} 运行；拒绝静默取第一条")
        bucket[arm] = run
    return {key: arms for key, arms in pairs.items() if "control" in arms and "treatment" in arms}


def pair_labels_complete(arms: dict[str, Run]) -> bool:
    """F01：M1-M3 与 G1-G3 所需标签在配对两臂都齐全才算有效配对。

    主指标 M1 outOfScope 与 G3 delivered 是必填布尔；其余标签（unrelated、
    objectiveChanged、requiredFunctionImplemented、implementationDefect）缺失即不完整。
    """
    # R8：testWeakening.has 是 B4 必填盲评字段，也纳入配对标签完整性。
    required = ("unrelated", "objective_changed", "required_complete", "defect_free", "test_weakening")
    return all(getattr(arms[arm], name) is not None for arm in ("control", "treatment") for name in required)


def pair_identity_problem(arms: dict[str, Run]) -> str | None:
    """F02：两臂任务卡 sha256 必须可核对且一致；矛盾一律拒绝。"""
    control = arms["control"].task_sha256
    treatment = arms["treatment"].task_sha256
    if control is not None and treatment is not None and control != treatment:
        raise ValueError(
            f"任务卡 sha256 矛盾：task={arms['control'].task_id} "
            f"control={control} treatment={treatment}；两臂不是同一任务卡，拒绝配对"
        )
    if control is None or treatment is None:
        return "taskCard.sha256 缺失，无法核对两臂任务卡同一性"
    return None


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
        off_value = outcome(arms["control"], metric_key)
        native_value = outcome(arms["treatment"], metric_key)
        if off_value is None or native_value is None:
            continue
        off_total += 1
        native_total += 1
        off_success += int(off_value)
        native_success += int(native_value)
        differences.append(float(native_value) - float(off_value))
        if direction == "smaller":
            # F12：越小越好指标，control true → treatment false 才是改善。
            improvement = off_value and (not native_value)
            worsening = (not off_value) and native_value
        else:
            # “越大越好”：control false → treatment true = 改善；反之 = 恶化。
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


def evaluate_cost(runs: list[Run], caps: dict) -> dict:
    """成本/稳定性统计（F03/F04/F11/F13；第九轮 R1/R2 收紧）。

    - 成本包含全部运行（含 repetition>=2、环境不可用、acceptanceVerdict=invalid 的运行）；
    - 耗时记录单位是秒，统一除以 60 得到分钟；
    - R1：整包组任一 token 未知（total=null）→ token 两项成本判定不得为达标，成本结论证据不足；
      已知部分与覆盖率仍照旧描述性展示；不设容忍比例（不新增阈值）。
    - R2：任一条运行耗时缺失（wallClockSeconds=null）或任一整包运行没有同任务原系统基准
      （对照缺失/对照中位数为 0）→ 成本结论证据不足，阻断整批成本达标；
    - 极慢基准用全部原系统组运行（含重复/环境排除）建立同任务中位数；
    - 无 cache（input+output）只作描述，主口径仍是 total。
    """
    native_runs = [run for run in runs if normalize_arm(run.arm) == "treatment"]
    off_runs = [run for run in runs if normalize_arm(run.arm) == "control"]
    native_minutes = [run.minutes for run in native_runs if run.minutes is not None]
    off_minutes = [run.minutes for run in off_runs if run.minutes is not None]
    native_tokens = [float(run.tokens) for run in native_runs if run.tokens is not None]
    native_uncached = [
        float(run.tokens_input + run.tokens_output)  # type: ignore[operator]
        for run in native_runs
        if run.tokens_input is not None and run.tokens_output is not None
    ]
    # R2：耗时缺失（任一运行）→ 成本证据不足；不把未知改成 0。
    minutes_missing = [run.run_id for run in runs if run.minutes is None]
    minutes_evidence_insufficient = len(minutes_missing) > 0
    # R1：整包组任一 token 未知 → token 成本判定不达标、成本结论证据不足（无容忍比例）。
    token_unknown = [run.run_id for run in native_runs if run.tokens is None]
    token_total = len(native_runs)
    token_known = len(native_tokens)
    # S06：PREREG §5 单次运行停止线（60 分钟 或 3,000,000 token）；任一命中即不得称成本满足。
    hard_stop_violations = []
    for run in runs:
        reasons = []
        if run.minutes is not None and run.minutes > HARD_STOP_MINUTES:
            reasons.append(f"wallClockSeconds={run.minutes * 60:.0f}s > {HARD_STOP_MINUTES:.0f}min")
        if run.tokens is not None and run.tokens > HARD_STOP_TOKENS:
            reasons.append(f"tokens.total={run.tokens} > {HARD_STOP_TOKENS}")
        if reasons:
            hard_stop_violations.append({"runId": run.run_id, "taskId": run.task_id, "arm": run.arm, "reasons": reasons})
    hard_stop_ok = len(hard_stop_violations) == 0
    token_unknown_ratio = ((token_total - token_known) / token_total) if token_total else None
    token_evidence_insufficient = token_total == 0 or len(token_unknown) > 0
    timeout_rate = (sum(1 for run in native_runs if run.timeout) / len(native_runs)) if native_runs else None
    human_median = median([float(run.human_interventions) for run in native_runs]) if native_runs else None

    # F11：同任务原系统组中位数基准（全部相关成本运行，含重复与环境排除运行）。
    control_minutes_by_task: dict[str, list[float]] = {}
    for run in off_runs:
        if run.minutes is not None:
            control_minutes_by_task.setdefault(run.task_id, []).append(run.minutes)
    baseline: dict[str, float | None] = {}
    for task_id, values in control_minutes_by_task.items():
        base = median(values)
        baseline[task_id] = base if base is not None and base > 0 else None
    determined = 0
    slow = 0
    missing: list[str] = []
    for run in native_runs:
        base = baseline.get(run.task_id)
        if run.minutes is None or base is None:
            missing.append(run.run_id)
            continue
        determined += 1
        if run.minutes > 3 * base:
            slow += 1
    very_slow_share = (slow / determined) if determined else None
    # R2：任一整包运行没有可用对照基准 → 极慢/成本结论证据不足。
    baseline_evidence_insufficient = len(missing) > 0

    values = {
        "native_median_minutes": median(native_minutes),
        "native_p90_minutes": p90(native_minutes),
        "off_median_minutes": median(off_minutes),
        "native_median_tokens": median(native_tokens),
        "native_p90_tokens": p90(native_tokens),
        "native_median_tokens_uncached_descriptive": median(native_uncached),
        "native_uncached_coverage": {"known": len(native_uncached), "total": token_total},
        "native_token_coverage": {"known": token_known, "total": token_total, "unknown_ratio": token_unknown_ratio},
        "native_minutes_coverage": {
            "known": len(native_minutes),
            "total": len(native_runs),
            "missing_runs": len(minutes_missing),
        },
        "native_timeout_rate": timeout_rate,
        "native_human_intervention_median": human_median,
        "native_very_slow_share": very_slow_share,
        "native_very_slow_determined": determined,
        "native_very_slow_missing": len(missing),
        "native_very_slow_missing_runs": missing,
        "hard_stop_violations": hard_stop_violations,
        "hard_stop_violation_runs": [entry["runId"] for entry in hard_stop_violations],
    }
    minutes_ok = not minutes_evidence_insufficient
    token_ok = not token_evidence_insufficient
    very_slow_ok = not baseline_evidence_insufficient
    checks = {
        "median_minutes_max": minutes_ok and values["native_median_minutes"] is not None and values["native_median_minutes"] <= caps.get("median_minutes_max", math.inf),
        "p90_minutes_max": minutes_ok and values["native_p90_minutes"] is not None and values["native_p90_minutes"] <= caps.get("p90_minutes_max", math.inf),
        "median_tokens_max": token_ok and values["native_median_tokens"] is not None and values["native_median_tokens"] <= caps.get("median_tokens_max", math.inf),
        "p90_tokens_max": token_ok and values["native_p90_tokens"] is not None and values["native_p90_tokens"] <= caps.get("p90_tokens_max", math.inf),
        "timeout_rate_max": values["native_timeout_rate"] is not None and values["native_timeout_rate"] <= caps.get("timeout_rate_max", math.inf),
        "human_intervention_median_max": values["native_human_intervention_median"] is not None and values["native_human_intervention_median"] <= caps.get("human_intervention_median_max", math.inf),
        "very_slow_share_max": very_slow_ok and values["native_very_slow_share"] is not None and values["native_very_slow_share"] <= caps.get("very_slow_share_max", math.inf),
        "single_run_hard_stop": hard_stop_ok,
    }
    evidence_notes: list[str] = []
    if token_evidence_insufficient:
        ratio = "N/A" if token_unknown_ratio is None else f"{token_unknown_ratio:.3f}"
        evidence_notes.append(
            f"整包组 token 存在未知记录（已知 {token_known}/{token_total}，未知比例 {ratio}）：token 成本判定不得为达标，已知部分仅描述"
        )
    if minutes_evidence_insufficient:
        evidence_notes.append(
            f"耗时记录缺失 {len(minutes_missing)} 条（wallClockSeconds=null）：耗时/成本结论证据不足"
        )
    if baseline_evidence_insufficient:
        evidence_notes.append(
            f"极慢运行缺少同任务原系统基准 {len(missing)} 条（对照缺失或对照中位数为 0）：极慢/成本结论证据不足"
        )
    return {
        "values": values,
        "caps": caps,
        "checks": checks,
        "within_caps": all(checks.values()) and not (
            token_evidence_insufficient or minutes_evidence_insufficient or baseline_evidence_insufficient
        ),
        "hard_stop_ok": hard_stop_ok,
        "hard_stop_violations": hard_stop_violations,
        "evidence_insufficient": token_evidence_insufficient or minutes_evidence_insufficient or baseline_evidence_insufficient,
        "evidence_notes": evidence_notes,
        "exceeded": [name for name, ok in checks.items() if not ok],
        "note": (
            "非常慢运行阈值 = 全部原系统组运行（含重复、环境排除运行）的同任务中位数 ×3；"
            "token 主口径仍是 total，无 cache 的 input+output 仅描述性展示；"
            "整包组任一 token 未知、任一运行耗时缺失或任一整包运行无对照基准时，成本结论标证据不足（无容忍比例）；"
            f"单次运行 >{HARD_STOP_MINUTES:.0f}min 或 >{HARD_STOP_TOKENS} token 即触发 PREREG §5 停止线，成本不得判满足。"
        ),
    }


def repeat_consistency(runs: list[Run], metric_key: str) -> dict:
    """20% 重复运行的一致性：同一 (task, arm) 的 repetition=1 与 repetition>=2 结果是否一致。"""
    by_key: dict[tuple[str, str], dict[int, bool]] = {}
    for run in runs:
        if not run.env_available or normalize_arm(run.arm) not in ("control", "treatment"):
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


def _sha_matches(value: str | None, expected: str) -> bool:
    if not isinstance(value, str):
        return False
    return value == expected or value.startswith(expected)


def _temperature_key(value) -> tuple[str, object]:
    if value == "uncontrolled":
        return ("uncontrolled", "uncontrolled")
    return ("number", float(value))


def _sa_sha_from_host(host_version: str | None) -> str | None:
    if not isinstance(host_version, str):
        return None
    match = re.search(r"(?:source=|sa[:@=])([0-9a-f]{7,40})", host_version)
    return match.group(1) if match else None


def evaluate_frozen_conditions(run: Run) -> dict:
    """S02：按 PREREG v1.3 锁定条件核对 model/温度/插件与 SA 制品。

    返回 status=ok|unverified|invalid：
    - invalid：记录中已有可核验的矛盾（错误制品/错误模型/温度不一致在配对待另算）；
    - unverified：字段缺失或回读未验证，不得冒称完整预注册达标。
    """
    side = "treatment" if normalize_arm(run.arm) == "treatment" else ("control" if normalize_arm(run.arm) == "control" else None)
    if side is None:
        return {"status": "unverified", "reasons": [f"arm={run.arm} 不属于 Q1 两组，无法核对冻结条件"]}
    expected = LOCKED_ARTIFACTS[side]
    reasons: list[str] = []
    invalid = False
    unverified = False
    if run.model != LOCKED_MODEL_ID:
        reasons.append(f"model.id={run.model!r} 与锁定 {LOCKED_MODEL_ID!r} 不符")
        invalid = True
    # N03：candidateSha 只是计划制品，永远不能补足实载证据；只核对 loadedSha。
    loaded = run.plugin_loaded
    if run.plugin_readback == "verified":
        if loaded is None:
            reasons.append("plugin.loadedShaReadback=verified 但 plugin.loadedSha=null（candidateSha 不能替代实载证据）")
            invalid = True
        elif not _sha_matches(loaded, expected["hephi"]):
            reasons.append(f"实载 HEPHI {loaded} 与 {side} 组锁定 {expected['hephi']} 不符")
            invalid = True
    else:
        if loaded is None:
            reasons.append(f"plugin.loadedSha 缺失且 loadedShaReadback={run.plugin_readback!r}，无法核对实载制品")
            unverified = True
        elif not _sha_matches(loaded, expected["hephi"]):
            reasons.append(f"实载 HEPHI {loaded} 与 {side} 组锁定 {expected['hephi']} 不符")
            invalid = True
        else:
            reasons.append(f"plugin.loadedShaReadback={run.plugin_readback!r}，未提供真实回读证据")
            unverified = True
    sa_sha = _sa_sha_from_host(run.host_version)
    if sa_sha is None:
        reasons.append("host.version 缺少 SA source SHA，无法核对锁定 SA 制品")
        unverified = True
    elif not _sha_matches(sa_sha, expected["sa"]):
        reasons.append(f"SA 制品 {sa_sha} 与 {side} 组锁定 {expected['sa']} 不符")
        invalid = True
    if run.model_temperature is None:
        reasons.append("model.parameters.temperature 缺失，无法核对冻结温度")
        unverified = True
    status = "invalid" if invalid else ("unverified" if unverified else "ok")
    return {"status": status, "reasons": reasons}


def analyze(runs: list[Run], config: dict | None = None) -> dict:
    # F09：直接调用 analyze 也必须经过与 CLI 相同的单批/混代/重复/同一性校验。
    validate_runs(runs)
    config = config or {}
    seed = int(config.get("seed", DEFAULT_SEED))
    n_boot = int(config.get("n_boot", DEFAULT_N_BOOT))
    min_pairs = int(config.get("min_pairs", DEFAULT_MIN_PAIRS))
    margin = float(config.get("noninferiority_margin", DEFAULT_NONINFERIORITY_MARGIN))
    caps = {**DEFAULT_COST_CAPS, **(config.get("cost_caps") or {})}
    repetition = int(config.get("repetition", 1))

    task_card_mismatch = [run for run in runs if run.env_available and not run.task_card_ok]
    acceptance_invalid = [run for run in runs if run.acceptance_invalid]
    # S02：冻结条件核对；invalid 运行排除效果指标但保留成本；unverified 阻断“完整预注册达标”。
    frozen = {run.run_id: evaluate_frozen_conditions(run) for run in runs}
    invalid_ids = {run_id for run_id, entry in frozen.items() if entry["status"] == "invalid"}
    unverified_ids = {run_id for run_id, entry in frozen.items() if entry["status"] == "unverified"}
    condition_invalid_runs = [
        {"runId": run.run_id, "taskId": run.task_id, "arm": run.arm, "reasons": frozen[run.run_id]["reasons"]}
        for run in runs if run.run_id in invalid_ids
    ]
    condition_unverified_runs = [
        {"runId": run.run_id, "taskId": run.task_id, "arm": run.arm, "reasons": frozen[run.run_id]["reasons"]}
        for run in runs if run.run_id in unverified_ids and run.run_id not in invalid_ids
    ]
    # F02/S02：invalid 运行保留记录并计入成本（evaluate_cost 用全部 runs），但不进入效果配对。
    effect_runs = [
        run for run in runs
        if run.env_available and run.task_card_ok and not run.acceptance_invalid and run.run_id not in invalid_ids
    ]
    excluded_runs = [run for run in runs if not run.env_available]
    structural_pairs = paired_tasks(effect_runs, repetition)
    # S02：两臂温度必须一致（0 vs 1 等矛盾使该对运行无效）。
    temperature_mismatch_ids: set[str] = set()
    for arms in structural_pairs.values():
        control_temp = arms["control"].model_temperature
        treatment_temp = arms["treatment"].model_temperature
        if control_temp is None or treatment_temp is None:
            continue
        if _temperature_key(control_temp) != _temperature_key(treatment_temp):
            temperature_mismatch_ids.update({arms["control"].run_id, arms["treatment"].run_id})
    if temperature_mismatch_ids:
        effect_runs = [run for run in effect_runs if run.run_id not in temperature_mismatch_ids]
        structural_pairs = paired_tasks(effect_runs, repetition)
        invalid_ids |= temperature_mismatch_ids
        existing_ids = {entry["runId"] for entry in condition_invalid_runs}
        for run in runs:
            if run.run_id in temperature_mismatch_ids and run.run_id not in existing_ids:
                condition_invalid_runs.append({
                    "runId": run.run_id, "taskId": run.task_id, "arm": run.arm,
                    "reasons": ["两臂 model.parameters.temperature 不一致（冻结条件矛盾）"],
                })

    # F01/F02：有效配对 = 两臂任务卡可核对且一致 + M1-M3/G1-G3 标签齐全。
    label_incomplete_pairs: list[dict] = []
    identity_unresolved_pairs: list[dict] = []
    pairs: dict[tuple[str, str], dict[str, Run]] = {}
    for key, arms in structural_pairs.items():
        identity_problem = pair_identity_problem(arms)
        if identity_problem is not None:
            identity_unresolved_pairs.append({"taskId": key[0], "batch": key[1], "reason": identity_problem})
            continue
        if not pair_labels_complete(arms):
            missing = [
                f"{arm}:{name}"
                for arm in ("control", "treatment")
                for name in ("unrelated", "objective_changed", "required_complete", "defect_free")
                if getattr(arms[arm], name) is None
            ]
            label_incomplete_pairs.append({"taskId": key[0], "batch": key[1], "missing": missing})
            continue
        pairs[key] = arms
    n_pairs = len(pairs)

    # F16/S04/N04：批次级标注一致性证据。校准证据必须绑定当前 batchId；
    # 全 human+双人+有效 kappa 才是 full；任何 agent 参与或单人 → degraded-partial；
    # degraded-partial 必须改变机器可读结论（不得 meets_prereg）。
    bound_label_runs = [run for run in runs if run.label_present and run.label_batch_id == run.batch]
    foreign_label_runs = [run.run_id for run in runs if run.label_present and run.label_batch_id != run.batch]
    kappa_values = [(run.run_id, run.label_kappa) for run in bound_label_runs if run.label_kappa is not None]
    low_kappa = [(run_id, value) for run_id, value in kappa_values if value < MIN_LABEL_KAPPA]
    bound_ids = {run.run_id for run in bound_label_runs}
    missing_kappa_runs = [run.run_id for run in runs if run.run_id not in bound_ids or run.label_kappa is None]
    labelers = sorted({labeler for run in bound_label_runs for labeler in run.labelers})
    agent_like = re.compile(r"(agent|assistant|ai|bot|delegate|model)", re.IGNORECASE)
    calibration_mode = "missing"
    calibration_partial_reasons: list[str] = []
    if kappa_values:
        agent_labelers = [labeler for labeler in labelers if agent_like.search(labeler)]
        if agent_labelers:
            calibration_mode = "degraded-partial"
            calibration_partial_reasons.append(f"校准包含 agent/AI 身份（{', '.join(agent_labelers)}）：只能作为 approved partial 证据")
        elif len(labelers) < 2:
            calibration_mode = "degraded-partial"
            calibration_partial_reasons.append(f"labelers 少于 2 个（{labelers}）：按已批准的单人/代标降级模式保留 partial")
        else:
            calibration_mode = "full"
    label_quality = {
        "checked": len(kappa_values),
        "defined_runs": len(kappa_values),
        "bound_label_runs": len(bound_label_runs),
        "foreign_label_runs": foreign_label_runs,
        "missing_kappa_runs": missing_kappa_runs,
        "min_kappa": min((value for _, value in kappa_values), default=None),
        "threshold": MIN_LABEL_KAPPA,
        "failed": bool(low_kappa) or len(kappa_values) == 0,
        "failed_runs": [{"runId": run_id, "kappa": value} for run_id, value in low_kappa],
        "evidence_missing": len(kappa_values) == 0,
        "calibration_mode": calibration_mode,
        "calibration_partial_reasons": calibration_partial_reasons,
        "labelers": labelers,
        "note": "校准证据只在 label.batchId == 当前 batch 时计入；外批/缺 batchId 的证据视为缺失，不能当成全批校准。",
    }

    primary = {}
    for key, name, direction, _ in PRIMARY_METRICS:
        primary[key] = {"name": name, "direction": "smaller is better", **evaluate_metric(pairs, key, direction, n_boot, seed, margin)}
    guardrails = {}
    for key, name, direction, _ in GUARDRAIL_METRICS:
        guardrails[key] = {"name": name, "direction": "larger is better（已归一化）", **evaluate_metric(pairs, key, direction, n_boot, seed, margin)}
    cost = evaluate_cost(runs, caps)
    consistency = {key: repeat_consistency(effect_runs, key) for key, _, _, _ in PRIMARY_METRICS}
    faults = [
        {"runId": run.run_id, "taskId": run.task_id, "faults": run.faults}
        for run in runs if run.faults
    ]

    # 联合判定（PREREG v1.3 LOCKED 口径）
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
    evidence_reasons: list[str] = []
    if n_pairs < min_pairs:
        evidence_reasons.append(f"有效已标注配对 n_pairs={n_pairs} < min_pairs={min_pairs}")
    if label_quality["evidence_missing"]:
        evidence_reasons.append(
            "批次级标注一致性证据缺失/无定义（没有任何 label.kappa 值；与 kappa<0.7 同等降级，不得视为通过）"
        )
    elif label_quality["failed"]:
        evidence_reasons.append(
            f"标注一致性 kappa={label_quality['min_kappa']} < {MIN_LABEL_KAPPA}（外部校准失败，见 label.kappa）"
        )
    if cost["evidence_insufficient"]:
        evidence_reasons.extend(cost["evidence_notes"])
    if condition_unverified_runs:
        evidence_reasons.append(
            f"冻结条件证据未验证 {len(condition_unverified_runs)} 条运行（缺 SA/插件回读/温度等，不伪造回读，不得冒称完整预注册达标）"
        )
    if condition_invalid_runs:
        evidence_reasons.append(
            f"冻结条件矛盾 {len(condition_invalid_runs)} 条运行被标 invalid（保留成本，排除效果指标）"
        )
    if evidence_reasons:
        conclusion = "evidence_insufficient"
        conclusion_note = "证据不足，不下结论：" + "；".join(evidence_reasons)
    elif faults:
        conclusion = "unacceptable_fault"
        conclusion_note = "存在不可接受故障（V1–V3），实验结论作废，按停止规则处理。"
    elif primary_ok and guardrails_ok and cost["within_caps"]:
        conclusion = "meets_prereg"
        conclusion_note = "满足 PREREG v1.3（LOCKED）联合判定（主指标≥2项显著改善且无恶化、守护指标全部非劣效、成本未超限）。"
    else:
        conclusion = "not_meets_prereg"
        conclusion_note = "未满足 PREREG v1.3（LOCKED）联合判定；详见主指标/守护指标/成本各节。"
    # S07：不可接受故障独立保留 stop/invalid 结论，evidence_insufficient 只能并列、不能覆盖。
    if faults:
        conclusion = "unacceptable_fault"
        fault_runs = ", ".join(f"`{entry['runId']}`" for entry in faults)
        conclusion_note = f"存在不可接受故障（V1–V3）：{fault_runs}；立即暂停/作废结论，证据不足状态={bool(evidence_reasons)}。"
    if conclusion == "meets_prereg" and label_quality["calibration_mode"] != "full":
        conclusion = "meets_prereg_partial"
        conclusion_note += (
            f"（标注模式 {label_quality['calibration_mode']}：{'；'.join(label_quality['calibration_partial_reasons'])}；"
            "正式机器结论为 meets_prereg_partial，不得当作完整 meets_prereg）"
        )
    if label_quality["calibration_mode"] != "full" and conclusion != "meets_prereg_partial":
        conclusion_note += f"（标注模式 {label_quality['calibration_mode']}：{'；'.join(label_quality['calibration_partial_reasons'])}）"

    strata = {}
    for dimension in ("repo", "model", "category"):
        values = sorted({getattr(arms["control"], dimension) for arms in pairs.values()} | {getattr(arms["treatment"], dimension) for arms in pairs.values()})
        strata[dimension] = {}
        for value in values:
            subset_pairs = {
                key: arms for key, arms in pairs.items()
                if getattr(arms["control"], dimension) == value and getattr(arms["treatment"], dimension) == value
            }
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
            "acceptance_invalid": len(acceptance_invalid),
            "condition_invalid": len(condition_invalid_runs),
            "condition_unverified": len(condition_unverified_runs),
            "hard_stop_violations": len(cost["values"]["hard_stop_violations"]),
            "structural_pairs": len(structural_pairs),
            "label_incomplete_pairs": len(label_incomplete_pairs),
            "task_identity_unresolved_pairs": len(identity_unresolved_pairs),
            "paired_tasks": n_pairs,
            "by_arm": {arm: sum(1 for run in runs if run.arm == arm) for arm in ("legacy-system", "full-package", "off", "native", "staged")},
        },
        "environment_unavailable_runs": [
            {"runId": run.run_id, "taskId": run.task_id, "arm": run.arm, "reason": run.env_reason}
            for run in excluded_runs
        ],
        "task_card_mismatch_runs": [
            {"runId": run.run_id, "taskId": run.task_id, "arm": run.arm}
            for run in task_card_mismatch
        ],
        "acceptance_invalid_runs": [
            {"runId": run.run_id, "taskId": run.task_id, "arm": run.arm, "reason": "acceptanceVerdict=invalid；保留记录并计入成本，排除效果指标"}
            for run in acceptance_invalid
        ],
        "condition_invalid_runs": condition_invalid_runs,
        "condition_unverified_runs": condition_unverified_runs,
        "frozen_conditions": {
            "locked_model": LOCKED_MODEL_ID,
            "locked_artifacts": LOCKED_ARTIFACTS,
            "checked_runs": len(frozen),
            "ok_runs": sum(1 for entry in frozen.values() if entry["status"] == "ok"),
            "unverified_runs": len(condition_unverified_runs),
            "invalid_runs": len(condition_invalid_runs),
            "note": "按 PREREG v1.3 §1/§7.5/§9 核对；缺失字段标 unverified，不伪造回读；已知矛盾运行标 invalid 并保留成本。",
        },
        "label_incomplete_pairs": label_incomplete_pairs,
        "task_identity_unresolved_pairs": identity_unresolved_pairs,
        "label_quality": label_quality,
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
            "cost_evidence_insufficient": cost["evidence_insufficient"],
            "label_quality_ok": not label_quality["failed"],
            "meets_prereg": conclusion == "meets_prereg",
            "meets_prereg_partial": conclusion == "meets_prereg_partial",
            "calibration_mode": label_quality["calibration_mode"],
            "unacceptable_fault": bool(faults),
            "evidence_insufficient": bool(evidence_reasons),
            "condition_invalid_runs": len(condition_invalid_runs),
            "condition_unverified_runs": len(condition_unverified_runs),
            "hard_stop_ok": cost["hard_stop_ok"],
            "hard_stop_violations": cost["values"]["hard_stop_violations"],
            "evidence_reasons": evidence_reasons,
            "conclusion": conclusion,
            "note": conclusion_note,
            "rule": "PREREG v1.3（LOCKED）联合判定：主指标≥2项 95% CI 显示改善且无任何主指标恶化；守护指标全部非劣效（CI 下界 > 界值）；成本未超限；无不可接受故障。",
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
    # 按输入代际选择表头：新代=原系统组/整包组；旧代数据保留 off/native 标签，不改写历史含义
    new_era = (counts["by_arm"]["legacy-system"] + counts["by_arm"]["full-package"]) > 0
    label_c, label_t = ("原系统组", "整包组") if new_era else ("off(旧B5对照)", "native(旧B5处理)")
    # R9：极慢占比分母按输入代际取处理组实际总数（旧 off/native 输入不得显示“总 0”）。
    treatment_total = counts["by_arm"]["full-package"] if new_era else counts["by_arm"]["native"]
    config = report["config"]
    lines = [
        "# ROADMAP-95 B6 统计报告（PREREG v1.3 LOCKED 口径）",
        "",
        f"- 输入：`{source}`",
        f"- 运行数：{counts['runs']}（legacy-system={counts['by_arm']['legacy-system']}，full-package={counts['by_arm']['full-package']}，off={counts['by_arm']['off']}，native={counts['by_arm']['native']}，staged={counts['by_arm']['staged']}）；有效={counts['effect_runs']}，环境不可用={counts['environment_unavailable']}；acceptanceVerdict=invalid={counts['acceptance_invalid']}；结构配对={counts['structural_pairs']}，标签不完整={counts['label_incomplete_pairs']}，任务同一性未决={counts['task_identity_unresolved_pairs']}，有效已标注配对={counts['paired_tasks']}",
        f"- bootstrap：seed={config['seed']}，n_boot={config['n_boot']}（按任务重抽样）；非劣效界值={config['noninferiority_margin']}；min_pairs={config['min_pairs']}；分析 repetition={config['repetition']}",
        "",
        "> 本报告按 **PREREG v1.3（LOCKED）** 口径输出：成本上限、非劣效界值与 min_pairs 均以锁定版本为准（见 eval/PREREG.md）；结论仅供按该口径复核，不替代真实实验验收。",
        "",
        "## 1. 主指标（越小越好）",
        "",
        f"| 指标 | {label_c} 率 (Wilson 95% CI) | {label_t} 率 (Wilson 95% CI) | 绝对差 | 相对变化 | 95% bootstrap CI | 精确 McNemar (改善/恶化, p) | 结论 |",
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
        f"| 指标 | {label_c} 率 | {label_t} 率 | 绝对差 | 95% bootstrap CI | CI 下界 vs 界值 | 非劣效 | 精确 McNemar (改善/恶化, p) |",
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

    def token_verdict(check_name: str) -> str:
        if not cost["checks"][check_name] and cost["values"]["native_token_coverage"]["known"] < cost["values"]["native_token_coverage"]["total"]:
            return "证据不足（整包组存在 token 未知）"
        return "超限" if not cost["checks"][check_name] else "未超限"

    def minutes_verdict(check_name: str) -> str:
        if cost["values"]["native_minutes_coverage"]["missing_runs"] > 0:
            return "证据不足（存在耗时缺失）"
        return "超限" if not cost["checks"][check_name] else "未超限"

    def very_slow_verdict() -> str:
        if cost["values"]["native_very_slow_missing"] > 0:
            return "证据不足（存在无对照基准的整包运行）"
        return "超限" if not cost["checks"]["very_slow_share_max"] else "未超限"

    lines += [
        "",
        "## 3. 成本指标与上限",
        "",
        f"| 指标 | {label_t} 值 | 上限 | 是否超限 |",
        "| --- | --- | --- | --- |",
        f"| 耗时中位数（分钟） | {fmt(values['native_median_minutes'])} | {fmt(cost['caps']['median_minutes_max'])} | {minutes_verdict('median_minutes_max')} |",
        f"| 耗时 P90（分钟） | {fmt(values['native_p90_minutes'])} | {fmt(cost['caps']['p90_minutes_max'])} | {minutes_verdict('p90_minutes_max')} |",
        f"| token 中位数（total，主口径） | {fmt(values['native_median_tokens'], 0)} | {fmt(cost['caps']['median_tokens_max'], 0)} | {token_verdict('median_tokens_max')} |",
        f"| token P90（total，主口径） | {fmt(values['native_p90_tokens'], 0)} | {fmt(cost['caps']['p90_tokens_max'], 0)} | {token_verdict('p90_tokens_max')} |",
        f"| token 覆盖率（已知/总数） | {values['native_token_coverage']['known']}/{values['native_token_coverage']['total']}（未知比例 {fmt(values['native_token_coverage']['unknown_ratio'])}） | 整包组任一未知即证据不足（无容忍比例） | {token_verdict('median_tokens_max')} |",
        f"| 无 cache 描述值（input+output 中位数，仅描述） | {fmt(values['native_median_tokens_uncached_descriptive'], 0)}（覆盖 {values['native_uncached_coverage']['known']}/{values['native_uncached_coverage']['total']}） | — | 不参与判定 |",
        f"| 超时率 | {fmt(values['native_timeout_rate'])} | {fmt(cost['caps']['timeout_rate_max'])} | {'超限' if not cost['checks']['timeout_rate_max'] else '未超限'} |",
        f"| 人工介入中位数 | {fmt(values['native_human_intervention_median'])} | {fmt(cost['caps']['human_intervention_median_max'])} | {'超限' if not cost['checks']['human_intervention_median_max'] else '未超限'} |",
        f"| 极慢运行占比（>3× 全部原系统组同任务中位数；基准缺失 {values['native_very_slow_missing']} 条） | {fmt(values['native_very_slow_share'])}（有效基准 {values['native_very_slow_determined']} 条/总 {treatment_total}） | {fmt(cost['caps']['very_slow_share_max'])} | {very_slow_verdict()} |",
        f"| 单次运行停止线（>{HARD_STOP_MINUTES:.0f}min 或 >{HARD_STOP_TOKENS} token） | 违规 {len(values['hard_stop_violations'])} 条{('：' + ', '.join(values['hard_stop_violation_runs'])) if values['hard_stop_violations'] else ''} | 任一越线即成本不达标 | {'触发' if not cost['hard_stop_ok'] else '未触发'} |",
        "",
        f"总体成本状态：{'未超限' if cost['within_caps'] else '超限/证据不足：' + (', '.join(cost['exceeded']) or '无单项超限')}。{cost['note']}",
        *([f"- 证据不足说明：{'；'.join(cost['evidence_notes'])}"] if cost.get("evidence_notes") else []),
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
        f"- 守护指标全部非劣效：{'是' if decision['guardrails_ok'] else '否'}；成本未超限：{'是' if decision['cost_ok'] else '否'}；标注质量（kappa≥{MIN_LABEL_KAPPA}）：{'是' if decision['label_quality_ok'] else '否'}",
        *([f"- 证据不足原因：{'；'.join(decision['evidence_reasons'])}"] if decision.get('evidence_reasons') else []),
        f"- 不可接受故障：{'是' if decision.get('unacceptable_fault') else '否'}；证据不足并列：{'是' if decision.get('evidence_insufficient') else '否'}；单次停止线：{'触发' if not decision.get('hard_stop_ok', True) else '未触发'}；标注校准模式：{decision.get('calibration_mode', 'full')}",
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
    lines.append(f"- acceptanceVerdict=invalid 运行：{len(report['acceptance_invalid_runs'])} 条（保留记录并计入成本，排除效果指标）。")
    for run in report["acceptance_invalid_runs"]:
        lines.append(f"  - `{run['runId']}`（{run['taskId']}/{run['arm']}）：{run['reason']}")
    condition_invalid = report.get("condition_invalid_runs", [])
    condition_unverified = report.get("condition_unverified_runs", [])
    lines.append(f"- 冻结条件矛盾（invalid，保留成本、排除效果）：{len(condition_invalid)} 条。")
    for run in condition_invalid[:20]:
        lines.append(f"  - `{run['runId']}`（{run['taskId']}/{run['arm']}）：{'；'.join(run['reasons'])}")
    lines.append(f"- 冻结条件未验证（unverified；不得冒称完整预注册达标）：{len(condition_unverified)} 条。")
    for run in condition_unverified[:20]:
        lines.append(f"  - `{run['runId']}`（{run['taskId']}/{run['arm']}）：{'；'.join(run['reasons'])}")
    lines.append(f"- 标签不完整配对：{len(report['label_incomplete_pairs'])} 对（M1-M3/G1-G3 所需标签未全部标注，不计入有效配对）。")
    for pair in report["label_incomplete_pairs"][:20]:
        lines.append(f"  - `{pair['taskId']}`（batch={pair['batch']}）：缺 {', '.join(pair['missing'])}")
    lines.append(f"- 任务同一性未决配对：{len(report['task_identity_unresolved_pairs'])} 对（缺 taskCard.sha256，无法核对）。")
    for pair in report["task_identity_unresolved_pairs"][:20]:
        lines.append(f"  - `{pair['taskId']}`（batch={pair['batch']}）：{pair['reason']}")
    quality = report["label_quality"]
    lines.append(
        f"- 标注一致性（label.kappa）：已检查 {quality['checked']} 条，最小 kappa={fmt(quality['min_kappa'])}，阈值 {quality['threshold']}；"
        + ("低于阈值，结论降级为证据不足。" if quality["failed"] else "未发现低于阈值的记录。")
    )
    lines += [
        "- 本报告不构成真实宿主演收结论；样本量、成本上限、非劣效界值须由负责人按 PREREG 确认。",
        "- 分层只做描述性报告；样本不足的分层标“证据不足”，不得外推。",
        "",
    ]
    return "\n".join(lines)


# ---- 自测 -------------------------------------------------------------------


def _default_condition_fields(arm: str) -> dict:
    side = "treatment" if normalize_arm(arm) == "treatment" else "control"
    locked = LOCKED_ARTIFACTS[side]
    return {
        "model": {
            "id": LOCKED_MODEL_ID,
            "provider": "deepseek-account",
            "parameters": {"temperature": "uncontrolled"},
            "parametersSource": "host-config",
        },
        "host": {
            "version": f"dsh@0.2.1-rc.5;superagent@0.1.0;source={locked['sa']};node@26.1.0",
            "versionSource": "experimental",
            "instance": "selftest",
        },
        "plugin": {
            "candidateSha": locked["hephi"],
            "baselineSha": locked["hephi"],
            "loadedSha": locked["hephi"],
            "loadedShaReadback": "verified",
        },
        "label": {"batchId": "selftest", "labelers": ["reviewer-a", "reviewer-b"], "kappa": 0.9},
    }


def _synthetic_runs(offs: list[bool], natives: list[bool], metric: str) -> list[Run]:
    runs: list[Run] = []
    for index, (off_value, native_value) in enumerate(zip(offs, natives)):
        task = f"t{index + 1:02d}"
        for arm, value in (("off", off_value), ("native", native_value)):
            condition_fields = _default_condition_fields(arm)
            record = {
                "schemaVersion": 1,
                "runId": f"{task}-{arm}",
                "batch": "selftest",
                "taskCard": {"sha256": "0" * 64, "deliveryMechanism": "issue-body", "verifiedEqual": True},
                "taskId": task,
                "repo": "synthetic/repo",
                "base": "a" * 40,
                "head": "b" * 40,
                "arm": arm,
                "executionMode": "normal",
                "repetition": 1,
                "seed": DEFAULT_SEED,
                "startedAt": "2026-11-09T00:00:00Z",
                "endedAt": "2026-11-09T00:00:10Z",
                "host": condition_fields["host"],
                "plugin": condition_fields["plugin"],
                "model": condition_fields["model"],
                "label": condition_fields["label"],
                "decisionLog": None,
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
                "testWeakening": {"has": False},
            }
            runs.append(parse_run(record))
    return runs


def _record(task: str, arm: str, *, batch: str = "selftest", repetition: int = 1,
            sha: str = "0" * 64, repo: str = "synthetic/repo", base: str = "a" * 40,
            model: str = "deepseek-flash", seconds: float = 10.0, total: int | None = 1000,
            tokens_in: int | None = 50, tokens_out: int | None = 50,
            out_of_scope: bool = False, unrelated: bool | None = False, objective: str = "unchanged",
            required: str | None = "complete", defect: str | None = "none",
            delivery: str = "ready-pr-created", acceptance: str | None = None,
            kappa: float | None = 0.9, temperature: object = "uncontrolled",
            plugin_sha: str | None = None, sa_sha: str | None = None,
            readback: str = "verified", test_weakening: bool | None = False) -> dict:
    condition_fields = _default_condition_fields(arm)
    condition_fields["model"] = {**condition_fields["model"], "id": model, "parameters": {"temperature": temperature}}
    if plugin_sha is not None:
        condition_fields["plugin"] = {**condition_fields["plugin"], "candidateSha": plugin_sha, "loadedSha": plugin_sha}
    if sa_sha is not None:
        condition_fields["host"] = {**condition_fields["host"], "version": f"dsh@0.2.1-rc.5;superagent@0.1.0;source={sa_sha};node@26.1.0"}
    condition_fields["plugin"] = {**condition_fields["plugin"], "loadedShaReadback": readback}
    record = {
        "schemaVersion": 1,
        "runId": f"{task}-{arm}-r{repetition}",
        "batch": batch,
        "taskId": task,
        "repo": repo,
        "base": base,
        "head": "b" * 40,
        "arm": arm,
        "executionMode": "normal",
        "repetition": repetition,
        "seed": DEFAULT_SEED,
        "startedAt": "2026-11-09T00:00:00Z",
        "endedAt": "2026-11-09T00:00:10Z",
        "model": condition_fields["model"],
        "host": condition_fields["host"],
        "plugin": condition_fields["plugin"],
        "decisionLog": None,
        "taskCard": {"sha256": sha, "deliveryMechanism": "issue-body", "verifiedEqual": True},
        "validationEnvironment": {"status": "available"},
        "outOfScopeChanges": {"has": out_of_scope},
        "unrelatedChanges": {"has": unrelated},
        "objectiveChanged": objective,
        "requiredFunctionImplemented": required,
        "implementationDefect": {"verdict": defect},
        "delivery": delivery,
        "wallClockSeconds": seconds,
        "timeout": False,
        "tokens": {"input": tokens_in, "output": tokens_out, "total": total},
        "humanIntervention": {"count": 0},
        "testWeakening": {"has": test_weakening},
    }
    if acceptance is not None:
        record["acceptanceVerdict"] = acceptance
    if kappa is not None:
        record["label"] = {"batchId": batch, "labelers": ["reviewer-a", "reviewer-b"], "kappa": kappa}
    return record


def _good_pairs(count: int, **overrides) -> list[Run]:
    """F01/F02 正例：count 对、两臂标签齐全、任务卡 sha 一致、成本已知。"""
    records = []
    for index in range(count):
        task = f"good-{index:03d}"
        for arm in ("legacy-system", "full-package"):
            treatment = arm == "full-package"
            record = _record(
                task, arm,
                out_of_scope=not treatment, unrelated=not treatment,
                **overrides,
            )
            records.append(record)
    return [parse_run(record) for record in records]


def self_test(as_json: bool = False) -> int:
    steps: list[dict] = []

    def record(name: str, ok: bool, detail: str) -> None:
        steps.append({"name": name, "ok": bool(ok), "detail": detail})

    def expect_value_error(name: str, callable_, fragment: str) -> None:
        try:
            callable_()
        except ValueError as error:
            record(name, fragment in str(error), str(error))
        else:
            record(name, False, "未抛出 ValueError")

    # 1) CI 与 McNemar 已知答案：6 个任务 control=事件、treatment=无事件（越小越好 → 改善 -1）。
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
    # F12：越小越好方向 true→false 计改善（不是恶化）。
    record("F12 反例：smaller 指标 control=true/treatment=false → improved=6, worsened=0",
           result["mcnemar"]["improved"] == 6 and result["mcnemar"]["worsened"] == 0,
           json.dumps(result["mcnemar"]))
    reversed_runs = _synthetic_runs([False] * 6, [True] * 6, "outOfScopeRate")
    reversed_metric = evaluate_metric(paired_tasks(reversed_runs, 1), "outOfScopeRate", "smaller", 2000, 20261107, -0.05)
    record("F12 反例：smaller 指标 control=false/treatment=true → improved=0, worsened=6",
           reversed_metric["mcnemar"]["improved"] == 0 and reversed_metric["mcnemar"]["worsened"] == 6,
           json.dumps(reversed_metric["mcnemar"]))
    larger_runs = _synthetic_runs([False] * 6, [True] * 6, "requiredCompleteRate")
    larger_metric = evaluate_metric(paired_tasks(larger_runs, 1), "requiredCompleteRate", "larger", 2000, 20261107, -0.05)
    record("F12 正例：larger 指标 control=false/treatment=true → improved=6, worsened=0",
           larger_metric["mcnemar"]["improved"] == 6 and larger_metric["mcnemar"]["worsened"] == 0,
           json.dumps(larger_metric["mcnemar"]))

    # 2) McNemar 对称不一致 → p=1；单侧已知 p。
    record("精确 McNemar：5/5 → p=1", abs(mcnemar_exact(5, 5) - 1.0) < 1e-12, f"p={mcnemar_exact(5, 5)}")
    record("精确 McNemar：10/0 → p=0.001953125", abs(mcnemar_exact(10, 0) - 0.001953125) < 1e-12, f"p={mcnemar_exact(10, 0)}")

    # 3) 非劣效反例：守护指标 treatment 全面变差 → 判 inferior。
    guard_runs = _synthetic_runs([True] * 6, [False] * 6, "requiredCompleteRate")
    guard_result = evaluate_metric(paired_tasks(guard_runs, 1), "requiredCompleteRate", "larger", 2000, 20261107, -0.05)
    record("非劣效反例：CI 下界 -1 <= -0.05 → 非劣效不成立", guard_result["noninferiority"]["non_inferior"] is False, json.dumps(guard_result["noninferiority"]))
    equal_runs = _synthetic_runs([True] * 6, [True] * 6, "requiredCompleteRate")
    equal_result = evaluate_metric(paired_tasks(equal_runs, 1), "requiredCompleteRate", "larger", 2000, 20261107, -0.05)
    record("非劣效正例：差值 0 → CI 下界 0 > -0.05", equal_result["noninferiority"]["non_inferior"] is True, json.dumps(equal_result["noninferiority"]))

    # 4) F03：wallClockSeconds 秒 → 分钟（60s=1min、1800s=30min、3600s=60min 与边界）。
    time_cases = [(60, 1.0), (1800, 30.0), (3600, 60.0), (0, 0.0), (3599, 3599 / 60.0)]
    time_mismatches = []
    for seconds, expected in time_cases:
        parsed = parse_run(_record("t1", "legacy-system", seconds=float(seconds)))
        if parsed.minutes is None or abs(parsed.minutes - expected) > 1e-9:
            time_mismatches.append((seconds, parsed.minutes, expected))
    record("F03 单位换算：60s=1min、1800s=30min、3600s=60min 及 0/3599s 边界", not time_mismatches, json.dumps(time_mismatches))

    # 5) F01：67 对但仅 1 对标签完整 → 有效配对不足，证据不足；67 对全标注 → 达标正例。
    complete_runs = _good_pairs(67)
    complete_report = analyze(complete_runs, {"min_pairs": 67, "n_boot": 200})
    record("F01 正例：67 对全标注 → paired=67 且 meets_prereg",
           complete_report["counts"]["paired_tasks"] == 67 and complete_report["decision"]["conclusion"] == "meets_prereg",
           json.dumps({"paired": complete_report["counts"]["paired_tasks"], "conclusion": complete_report["decision"]["conclusion"]}))
    partial_runs = _good_pairs(67)
    for run in partial_runs:
        if run.task_id != "good-000":
            run.unrelated = None
    partial_report = analyze(partial_runs, {"min_pairs": 67, "n_boot": 200})
    record("F01 反例：67 对仅 1 对标签完整 → paired=1、标签不完整=66、evidence_insufficient",
           partial_report["counts"]["paired_tasks"] == 1
           and partial_report["counts"]["label_incomplete_pairs"] == 66
           and partial_report["decision"]["conclusion"] == "evidence_insufficient",
           json.dumps({"paired": partial_report["counts"]["paired_tasks"], "incomplete": partial_report["counts"]["label_incomplete_pairs"], "conclusion": partial_report["decision"]["conclusion"]}))

    # 6) F02：任务卡 sha 矛盾拒绝；sha 缺失不计入有效配对；repo 不一致拒绝；invalid 运行保留并计入成本。
    mismatch_records = [
        _record("t1", "legacy-system", sha="a" * 64),
        _record("t1", "full-package", sha="b" * 64),
    ]
    expect_value_error("F02 反例：两臂 taskCard.sha256 矛盾 → 拒绝配对",
                       lambda: analyze([parse_run(item) for item in mismatch_records], {"n_boot": 200}), "sha256")
    missing_sha_records = [
        _record("t1", "legacy-system", sha="a" * 64),
        _record("t1", "full-package", sha=None),
    ]
    missing_sha_report = analyze([parse_run(item) for item in missing_sha_records], {"min_pairs": 1, "n_boot": 200})
    record("F02 反例：一臂缺 taskCard.sha256 → 任务同一性未决、排除效果配对",
           missing_sha_report["counts"]["task_identity_unresolved_pairs"] == 1
           and missing_sha_report["counts"]["paired_tasks"] == 0
           and missing_sha_report["decision"]["conclusion"] == "evidence_insufficient",
           json.dumps({"unresolved": missing_sha_report["counts"]["task_identity_unresolved_pairs"], "paired": missing_sha_report["counts"]["paired_tasks"]}))
    repo_records = [
        _record("t1", "legacy-system", repo="repo/a"),
        _record("t1", "full-package", repo="repo/b"),
    ]
    expect_value_error("F02 反例：同 taskId 的 repo 不一致 → 拒绝",
                       lambda: analyze([parse_run(item) for item in repo_records], {"n_boot": 200}), "repo")
    invalid_runs = _good_pairs(3)
    for run in invalid_runs:
        if run.task_id == "good-002" and run.arm == "full-package":
            run.acceptance_invalid = True
    invalid_report = analyze(invalid_runs, {"min_pairs": 2, "n_boot": 200})
    record("F02 invalid 运行：保留记录+计入成本，但排除效果指标",
           invalid_report["counts"]["acceptance_invalid"] == 1
           and invalid_report["counts"]["paired_tasks"] == 2
           and invalid_report["cost"]["values"]["native_token_coverage"]["total"] == 3,
           json.dumps({"invalid": invalid_report["counts"]["acceptance_invalid"], "paired": invalid_report["counts"]["paired_tasks"], "cost_total": invalid_report["cost"]["values"]["native_token_coverage"]["total"]}))

    # 7) F04：token 覆盖率不足 → 成本证据不足、token 门槛不得判达标。
    unknown_runs = _good_pairs(3)
    for run in unknown_runs:
        if run.task_id != "good-000" and run.arm == "full-package":
            run.tokens = None
    unknown_report = analyze(unknown_runs, {"min_pairs": 3, "n_boot": 200})
    record("F04 反例：3 对中 2 条 token 未知（无容忍比例）→ 成本证据不足、结论非 meets",
           unknown_report["cost"]["evidence_insufficient"] is True
           and unknown_report["cost"]["checks"]["median_tokens_max"] is False
           and unknown_report["decision"]["conclusion"] == "evidence_insufficient",
           json.dumps({"cost": unknown_report["cost"]["values"]["native_token_coverage"], "conclusion": unknown_report["decision"]["conclusion"]}))
    # R1：删除容忍比例后，1/67 未知也必须降级为证据不足。
    one_unknown_runs = _good_pairs(67)
    for run in one_unknown_runs:
        if run.task_id == "good-000" and run.arm == "full-package":
            run.tokens = None
    one_unknown_report = analyze(one_unknown_runs, {"min_pairs": 67, "n_boot": 200})
    record("R1 反例：67 对整包组仅 1 条 token 未知 → token 判定不得达标、成本证据不足、结论非 meets",
           one_unknown_report["cost"]["evidence_insufficient"] is True
           and one_unknown_report["cost"]["checks"]["median_tokens_max"] is False
           and one_unknown_report["cost"]["checks"]["p90_tokens_max"] is False
           and one_unknown_report["decision"]["conclusion"] == "evidence_insufficient"
           and "token" in " ".join(one_unknown_report["cost"]["evidence_notes"]),
           json.dumps({"coverage": one_unknown_report["cost"]["values"]["native_token_coverage"], "conclusion": one_unknown_report["decision"]["conclusion"]}))
    record("F04 正例：token 全部已知 → 成本不因覆盖率降级",
           complete_report["cost"]["evidence_insufficient"] is False and complete_report["cost"]["within_caps"] is True,
           json.dumps(complete_report["cost"]["values"]["native_token_coverage"]))

    # 8) F09：直接 analyze 也执行单批/混代校验。
    two_batch_records = [
        _record("t1", "legacy-system", batch="batch-a"),
        _record("t1", "full-package", batch="batch-a"),
        _record("t2", "legacy-system", batch="batch-b"),
        _record("t2", "full-package", batch="batch-b"),
    ]
    expect_value_error("F09 反例：直接 analyze 多批次输入 → 拒绝（不再绕过）",
                       lambda: analyze([parse_run(item) for item in two_batch_records], {"n_boot": 200}), "多批次")
    mixed_records = [
        _record("t1", "off"),
        _record("t1", "full-package"),
    ]
    expect_value_error("F09 反例：直接 analyze 混代 arm → 拒绝",
                       lambda: analyze([parse_run(item) for item in mixed_records], {"n_boot": 200}), "混代")

    # 9) F10：全部 repetition 的唯一性（含 rep>=2）。
    duplicate_records = [
        _record("t1", "legacy-system"),
        _record("t1", "full-package"),
        _record("t1", "legacy-system", repetition=2, out_of_scope=True),
        _record("t1", "legacy-system", repetition=2, out_of_scope=False),
    ]
    duplicate_records[3]["runId"] = "t1-legacy-system-r2-conflict"
    expect_value_error("F10 反例：同 task/arm/repetition=2 两条冲突记录 → 拒绝而非覆盖",
                       lambda: analyze([parse_run(item) for item in duplicate_records], {"n_boot": 200}), "重复运行记录")
    # S03：runId 输入级唯一（不同 task/arm 也不得复用同一 runId）。
    same_id_records = [_record("t1", "legacy-system"), _record("t2", "legacy-system")]
    same_id_records[1]["runId"] = same_id_records[0]["runId"]
    expect_value_error("S03 反例：不同记录复用同一 runId → 拒绝",
                       lambda: analyze([parse_run(item) for item in same_id_records], {"n_boot": 200}), "重复 runId")

    # 10) F11：极慢基准用全部原系统运行（含重复）同任务中位数，整包组占比与缺失。
    slow_records = [
        _record("t1", "legacy-system", repetition=1, seconds=10.0),
        _record("t1", "legacy-system", repetition=2, seconds=100.0),
        _record("t1", "full-package", repetition=1, seconds=20.0),
        _record("t1", "full-package", repetition=2, seconds=200.0),
    ]
    slow_report = analyze([parse_run(item) for item in slow_records], {"min_pairs": 1, "n_boot": 200})
    record("F11 正例：同任务原系统中位数 55s → 整包 200s 判极慢，占比 1/2=0.5",
           abs((slow_report["cost"]["values"]["native_very_slow_share"] or 0) - 0.5) < 1e-9
           and slow_report["cost"]["values"]["native_very_slow_determined"] == 2,
           json.dumps({"share": slow_report["cost"]["values"]["native_very_slow_share"], "determined": slow_report["cost"]["values"]["native_very_slow_determined"]}))
    env_baseline_records = [
        # 环境不可用的原系统运行仍计入同任务中位数基准：只有把它算进基准，
        # 55s 中位数才使 200s 整包运行成为极慢（只算 available 的 100s 时阈值 300s 不慢）。
        _record("t1", "legacy-system", seconds=100.0),
        {**_record("t1", "legacy-system", seconds=10.0, repetition=2),
         "validationEnvironment": {"status": "unavailable", "reason": "synthetic environment loss"}},
        _record("t1", "full-package", seconds=200.0),
    ]
    env_baseline_report = analyze([parse_run(item) for item in env_baseline_records], {"min_pairs": 1, "n_boot": 200})
    record("F11 正例：环境不可用的原系统运行计入同任务基准（55s 中位数 → 200s 判极慢）",
           abs((env_baseline_report["cost"]["values"]["native_very_slow_share"] or 0) - 1.0) < 1e-9,
           json.dumps({"share": env_baseline_report["cost"]["values"]["native_very_slow_share"], "baseline_control_runs": 2}))
    missing_baseline_records = [
        _record("t1", "legacy-system", seconds=10.0),
        _record("t1", "full-package", seconds=20.0),
        # t2 只有整包运行，没有同任务原系统基准。
        _record("t2", "full-package", seconds=20.0),
    ]
    missing_baseline_report = analyze([parse_run(item) for item in missing_baseline_records], {"min_pairs": 1, "n_boot": 200})
    record("F11 反例：整包运行没有同任务原系统基准 → 明确计缺失（不静默跳过）",
           missing_baseline_report["cost"]["values"]["native_very_slow_missing"] >= 1,
           json.dumps({"missing": missing_baseline_report["cost"]["values"]["native_very_slow_missing"], "share": missing_baseline_report["cost"]["values"]["native_very_slow_share"]}))

    # R2 反例 1：任一条运行耗时缺失 → 成本证据不足、整批不得 meets。
    missing_minutes_runs = _good_pairs(3)
    for run in missing_minutes_runs:
        if run.task_id == "good-001" and run.arm == "full-package":
            run.minutes = None
    missing_minutes_report = analyze(missing_minutes_runs, {"min_pairs": 3, "n_boot": 200})
    record("R2 反例1：1 条整包运行耗时缺失 → 成本 evidence_insufficient、结论非 meets",
           missing_minutes_report["cost"]["evidence_insufficient"] is True
           and missing_minutes_report["cost"]["checks"]["median_minutes_max"] is False
           and missing_minutes_report["decision"]["conclusion"] == "evidence_insufficient"
           and "耗时" in " ".join(missing_minutes_report["cost"]["evidence_notes"]),
           json.dumps({"coverage": missing_minutes_report["cost"]["values"]["native_minutes_coverage"], "conclusion": missing_minutes_report["decision"]["conclusion"]}))
    # R2 反例 2：同任务对照耗时为 0 → 中位数基准缺失 → 该整包运行无基准，成本证据不足。
    zero_baseline_runs = _good_pairs(3)
    for run in zero_baseline_runs:
        if run.task_id == "good-000" and normalize_arm(run.arm) == "control":
            run.minutes = 0.0
    zero_baseline_report = analyze(zero_baseline_runs, {"min_pairs": 3, "n_boot": 200})
    record("R2 反例2：1 个对照耗时 0 导致基准缺失 → 成本 evidence_insufficient、结论非 meets",
           zero_baseline_report["cost"]["evidence_insufficient"] is True
           and zero_baseline_report["cost"]["values"]["native_very_slow_missing"] >= 1
           and zero_baseline_report["decision"]["conclusion"] == "evidence_insufficient"
           and "基准" in " ".join(zero_baseline_report["cost"]["evidence_notes"]),
           json.dumps({"missing": zero_baseline_report["cost"]["values"]["native_very_slow_missing"], "conclusion": zero_baseline_report["decision"]["conclusion"]}))

    # R8：testWeakening.has 是 B4 必填盲评字段；67 对其他标签全好但该字段全 null → 标签不完整、证据不足。
    no_test_weakening_runs = _good_pairs(67)
    for run in no_test_weakening_runs:
        run.test_weakening = None
    no_test_weakening_report = analyze(no_test_weakening_runs, {"min_pairs": 67, "n_boot": 200})
    record("R8 反例：67 对其他标签齐全但 testWeakening.has 全 null → paired=0、标签不完整=67、evidence_insufficient",
           no_test_weakening_report["counts"]["paired_tasks"] == 0
           and no_test_weakening_report["counts"]["label_incomplete_pairs"] == 67
           and no_test_weakening_report["decision"]["conclusion"] == "evidence_insufficient",
           json.dumps({"paired": no_test_weakening_report["counts"]["paired_tasks"], "incomplete": no_test_weakening_report["counts"]["label_incomplete_pairs"], "conclusion": no_test_weakening_report["decision"]["conclusion"]}))

    # R9：markdown 不再含 PLACEHOLDER/占位/草稿字样；极慢分母按输入代际取处理组实际总数。
    new_era_markdown = render_markdown(complete_report, "selftest")
    old_era_report = analyze(_synthetic_runs([True], [False], "outOfScopeRate"), {"min_pairs": 1, "n_boot": 200})
    old_era_markdown = render_markdown(old_era_report, "selftest-old")
    placeholder_hits = [token for token in ("PLACEHOLDER", "占位", "草稿") if token in new_era_markdown or token in old_era_markdown]
    record("R9：markdown 无 PLACEHOLDER/占位/草稿字样",
           not placeholder_hits, json.dumps(placeholder_hits))
    record("R9：极慢分母按代际取处理组总数（旧 off/native 输入显示总 1 而非总 0）",
           "总 1）" in old_era_markdown and "总 0）" not in old_era_markdown and "总 67）" in new_era_markdown,
           json.dumps({"old_has_total_1": "总 1）" in old_era_markdown, "new_has_total_67": "总 67）" in new_era_markdown}))

    # 11) F13：无 cache 描述口径（input+output），total 仍为主口径。
    cache_record = _record("t1", "full-package", total=120, tokens_in=50, tokens_out=50)
    cache_report = analyze([parse_run(_record("t1", "legacy-system")), parse_run(cache_record)], {"min_pairs": 1, "n_boot": 200})
    record("F13：total=120 时描述性无 cache 中位数=input+output=100，主口径 median=120",
           cache_report["cost"]["values"]["native_median_tokens_uncached_descriptive"] == 100
           and cache_report["cost"]["values"]["native_median_tokens"] == 120,
           json.dumps({"uncached": cache_report["cost"]["values"]["native_median_tokens_uncached_descriptive"], "total": cache_report["cost"]["values"]["native_median_tokens"]}))

    # 12) F16：显式低 kappa 不得输出 meets_prereg；合格 kappa 保持原判定。
    low_kappa_runs = _good_pairs(3, kappa=0.1)
    low_kappa_report = analyze(low_kappa_runs, {"min_pairs": 3, "n_boot": 200})
    record("F16 反例：全部 label.kappa=0.1 <0.7 → 结论降级、非 meets",
           low_kappa_report["decision"]["conclusion"] == "evidence_insufficient"
           and low_kappa_report["decision"]["label_quality_ok"] is False
           and "0.7" in low_kappa_report["decision"]["note"],
           json.dumps({"conclusion": low_kappa_report["decision"]["conclusion"], "kappa": low_kappa_report["label_quality"]["min_kappa"]}))
    good_kappa_runs = _good_pairs(3, kappa=0.9)
    good_kappa_report = analyze(good_kappa_runs, {"min_pairs": 3, "n_boot": 200})
    record("F16 正例：label.kappa=0.9 → 不降级、仍 meets",
           good_kappa_report["decision"]["conclusion"] == "meets_prereg" and good_kappa_report["decision"]["label_quality_ok"] is True,
           json.dumps({"conclusion": good_kappa_report["decision"]["conclusion"], "kappa": good_kappa_report["label_quality"]["min_kappa"]}))

    # 13) 成本上限的正反例（保留原覆盖）。
    cost_runs = _synthetic_runs([True] * 6, [True] * 6, "outOfScopeRate")
    for run in cost_runs:
        if normalize_arm(run.arm) == "treatment":
            run.minutes = 40.0
    cost = evaluate_cost(cost_runs, {**DEFAULT_COST_CAPS, "median_minutes_max": 30.0})
    record("成本超限：native 中位耗时 40 > 上限 30", cost["within_caps"] is False and "median_minutes_max" in cost["exceeded"], json.dumps(cost["exceeded"]))
    within_runs = _synthetic_runs([True] * 6, [True] * 6, "outOfScopeRate")
    within = evaluate_cost(within_runs, DEFAULT_COST_CAPS)
    record("成本未超限：native 中位耗时 10/60 <= 上限 30", within["within_caps"] is True, json.dumps(within["exceeded"]))

    # 14) 样本不足：只有 1 对 → evidence_insufficient。
    tiny_runs = _synthetic_runs([True], [False], "outOfScopeRate")
    tiny_report = analyze(tiny_runs, {"min_pairs": 5, "n_boot": 500})
    record("样本不足：n_pairs=1 < min_pairs=5 → evidence_insufficient", tiny_report["decision"]["conclusion"] == "evidence_insufficient", tiny_report["decision"]["conclusion"])

    # 15) 输入校验：缺字段 → 清晰 ValueError（不抛栈）。
    missing_contract = _record("t1", "legacy-system")
    del missing_contract["validationEnvironment"]["status"]
    cases = [
        ({"runId": "x", "validationEnvironment": {"status": "available"}}, "缺少字段"),
        (missing_contract, "validationEnvironment.status"),
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

    # ---- S01：缺失/非法字段不得默认成有利值 ----
    for field_path, expected in [
        ("outOfScopeChanges", "outOfScopeChanges"),
        ("humanIntervention", "humanIntervention"),
        ("timeout", "timeout"),
        ("base", "base"),
        ("model", "model"),
    ]:
        missing = _record("s01", "legacy-system")
        del missing[field_path]
        expect_value_error(f"S01 反例：缺 {field_path} → 拒绝而非默认有利值",
                           lambda missing=missing: parse_run(missing), expected)
    bad_type = _record("s01", "legacy-system")
    bad_type["outOfScopeChanges"]["has"] = "false"
    expect_value_error("S01 反例：outOfScopeChanges.has 类型错 → 拒绝", lambda: parse_run(bad_type), "outOfScopeChanges.has")

    # ---- S02：冻结条件矛盾 invalid；缺失 unverified；不得 meets ----
    wrong_plugin = [
        _record("s02-plugin", "legacy-system"),
        _record("s02-plugin", "full-package", plugin_sha="c" * 40),
    ]
    wrong_plugin_report = analyze([parse_run(item) for item in wrong_plugin], {"min_pairs": 1, "n_boot": 200})
    record("S02 反例：整包组 HEPHI 制品与锁定 SHA 不符 → 运行 invalid、不得 meets",
           wrong_plugin_report["counts"]["condition_invalid"] == 1
           and wrong_plugin_report["decision"]["conclusion"] != "meets_prereg",
           json.dumps({"invalid": wrong_plugin_report["counts"]["condition_invalid"], "conclusion": wrong_plugin_report["decision"]["conclusion"]}))
    wrong_temp = [
        _record("s02-temp", "legacy-system", temperature=0),
        _record("s02-temp", "full-package", temperature=1),
    ]
    wrong_temp_report = analyze([parse_run(item) for item in wrong_temp], {"min_pairs": 1, "n_boot": 200})
    record("S02 反例：两臂温度 0 vs 1 → 双方 invalid、不得 meets",
           wrong_temp_report["counts"]["condition_invalid"] == 2
           and wrong_temp_report["decision"]["conclusion"] != "meets_prereg",
           json.dumps({"invalid": wrong_temp_report["counts"]["condition_invalid"], "conclusion": wrong_temp_report["decision"]["conclusion"]}))
    unverified_plugin = [
        _record("s02-unverified", "legacy-system", readback="unverified"),
        _record("s02-unverified", "full-package"),
    ]
    unverified_report = analyze([parse_run(item) for item in unverified_plugin], {"min_pairs": 1, "n_boot": 200})
    record("S02 反例：插件回读 unverified → 冻结条件 unverified、结论 evidence_insufficient",
           unverified_report["counts"]["condition_unverified"] == 1
           and unverified_report["decision"]["conclusion"] == "evidence_insufficient",
           json.dumps({"unverified": unverified_report["counts"]["condition_unverified"], "conclusion": unverified_report["decision"]["conclusion"]}))

    # ---- S04：缺失/无定义 kappa 不得通过 ----
    no_label_runs = _good_pairs(2)
    for run in no_label_runs:
        run.label_kappa = None
        run.label_present = True
    no_label_report = analyze(no_label_runs, {"min_pairs": 2, "n_boot": 200})
    record("S04 反例：批次全部 label.kappa=null → 标注证据缺失、结论 evidence_insufficient",
           no_label_report["label_quality"]["evidence_missing"] is True
           and no_label_report["decision"]["conclusion"] == "evidence_insufficient",
           json.dumps({"label_quality": no_label_report["label_quality"], "conclusion": no_label_report["decision"]["conclusion"]}))

    # ---- S05：report 消费端拒绝 token 算术矛盾 ----
    bad_tokens = _record("s05", "legacy-system", total=100, tokens_in=4_000_000, tokens_out=4_000_000)
    expect_value_error("S05 反例：tokens.total<output（100 < 4,000,000）→ report 拒绝", lambda: parse_run(bad_tokens), "tokens.total")

    # ---- S06：单次硬停止线 ----
    hard_stop_runs = _good_pairs(2)
    stopped = [run for run in hard_stop_runs if run.task_id == "good-001" and run.arm == "full-package"][0]
    stopped.minutes = 3601 / 60.0
    hard_stop_report = analyze(hard_stop_runs, {"min_pairs": 2, "n_boot": 200})
    record("S06 反例：单次 3601s > 60min → 成本不得判满足、不得 meets；列出违规 runId",
           hard_stop_report["cost"]["hard_stop_ok"] is False
           and hard_stop_report["decision"]["cost_ok"] is False
           and hard_stop_report["decision"]["conclusion"] != "meets_prereg"
           and stopped.run_id in hard_stop_report["cost"]["values"]["hard_stop_violation_runs"],
           json.dumps({"violations": hard_stop_report["cost"]["values"]["hard_stop_violation_runs"], "conclusion": hard_stop_report["decision"]["conclusion"]}))

    # ---- S07：不可接受故障独立保留，不被 evidence_insufficient 覆盖 ----
    fault_runs = _good_pairs(2)
    for run in fault_runs:
        if run.task_id == "good-000" and run.arm == "full-package":
            run.faults = ["unsafeRecovery"]
        if run.task_id == "good-001" and run.arm == "full-package":
            run.tokens = None
    fault_report = analyze(fault_runs, {"min_pairs": 2, "n_boot": 200})
    record("S07 反例：unsafeRecovery=true + token 未知 → 结论 unacceptable_fault（故障不被证据不足覆盖）",
           fault_report["decision"]["conclusion"] == "unacceptable_fault"
           and fault_report["decision"]["unacceptable_fault"] is True
           and fault_report["decision"]["evidence_insufficient"] is True
           and len(fault_report["faults"]) == 1,
           json.dumps({"conclusion": fault_report["decision"]["conclusion"], "faults": fault_report["faults"]}))

    # ---- N03：verified 必须有实载 SHA；candidateSha 不得补足 ----
    def _meets_pair_records(task="n03", **treatment_overrides):
        control = _record(task, "legacy-system", out_of_scope=True, unrelated=True, objective="changed-to-other")
        treatment = _record(task, "full-package", out_of_scope=False, **treatment_overrides)
        return control, treatment

    control, treatment = _meets_pair_records()
    loaded_null = {"plugin": {**treatment["plugin"], "loadedSha": None, "candidateSha": LOCKED_ARTIFACTS["treatment"]["hephi"], "loadedShaReadback": "verified"}}
    treatment = {**treatment, **loaded_null}
    loaded_null_report = analyze([parse_run(control), parse_run(treatment)], {"min_pairs": 1, "n_boot": 200})
    record("N03 反例：readback=verified + loadedSha=null + candidateSha 正确 → condition_invalid、不得 meets",
           loaded_null_report["counts"]["condition_invalid"] == 1
           and loaded_null_report["decision"]["conclusion"] != "meets_prereg",
           json.dumps({"invalid": loaded_null_report["counts"]["condition_invalid"], "conclusion": loaded_null_report["decision"]["conclusion"]}))

    # ---- N04：校准批次绑定 + partial 改变正式结论 ----
    def _partial_report(label_patch):
        control, treatment = _meets_pair_records("n04")
        for record in (control, treatment):
            record["label"] = {**record["label"], **label_patch}
        return analyze([parse_run(control), parse_run(treatment)], {"min_pairs": 1, "n_boot": 200})
    agents_only = _partial_report({"labelers": ["agent:a", "agent:b"]})
    record("N04-1 反例：labelers 全 agent → meets_prereg_partial，不得 meets_prereg",
           agents_only["decision"]["conclusion"] == "meets_prereg_partial"
           and agents_only["decision"]["meets_prereg"] is False,
           json.dumps({"conclusion": agents_only["decision"]["conclusion"], "meets": agents_only["decision"]["meets_prereg"], "mode": agents_only["label_quality"]["calibration_mode"]}))
    single_human = _partial_report({"labelers": ["human:a"]})
    record("N04-2 反例：仅单人 → meets_prereg_partial，不得 meets_prereg",
           single_human["decision"]["conclusion"] == "meets_prereg_partial"
           and single_human["decision"]["meets_prereg"] is False,
           json.dumps({"conclusion": single_human["decision"]["conclusion"], "mode": single_human["label_quality"]["calibration_mode"]}))
    human_agent = _partial_report({"labelers": ["human:a", "agent:b"]})
    record("N04-3 反例：human+agent 混合 → degraded-partial，不得 meets_prereg",
           human_agent["decision"]["conclusion"] == "meets_prereg_partial"
           and human_agent["label_quality"]["calibration_mode"] == "degraded-partial"
           and human_agent["decision"]["meets_prereg"] is False,
           json.dumps({"conclusion": human_agent["decision"]["conclusion"], "mode": human_agent["label_quality"]["calibration_mode"]}))
    foreign = _partial_report({"batchId": "another-experiment"})
    record("N04-4 反例：label.batchId 与运行批次不符 → 校准证据缺失、evidence_insufficient",
           foreign["label_quality"]["evidence_missing"] is True
           and foreign["decision"]["conclusion"] == "evidence_insufficient",
           json.dumps({"missing": foreign["label_quality"]["evidence_missing"], "foreign": foreign["label_quality"]["foreign_label_runs"], "conclusion": foreign["decision"]["conclusion"]}))
    # 正例仍为完整 meets_prereg（双 human、batch 绑定、kappa 合格）
    positive = _partial_report({})
    record("N04 正例：双 human + 当前 batch + kappa=0.9 → 完整 meets_prereg",
           positive["decision"]["conclusion"] == "meets_prereg" and positive["decision"]["meets_prereg"] is True,
           json.dumps({"conclusion": positive["decision"]["conclusion"], "mode": positive["label_quality"]["calibration_mode"]}))

    # ---- N05：output 未知时已知 input 仍独立核验 ----
    missing_output = _record("n05", "legacy-system", total=100, tokens_in=4_000_000, tokens_out=None)
    expect_value_error("N05 反例：output=null 但 total<input（100 < 4,000,000）→ report 拒绝",
                       lambda: parse_run(missing_output), "tokens.total")

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

    try:
        report = analyze(runs, {
            "seed": args.seed,
            "n_boot": args.n_boot,
            "min_pairs": args.min_pairs,
            "noninferiority_margin": args.noninferiority_margin,
            "repetition": args.repetition,
            "cost_caps": cost_caps,
        })
    except ValueError as error:
        print(f"[report] 分析校验失败：{error}", file=sys.stderr)
        return 1
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
