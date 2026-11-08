#!/bin/sh
set -eu
python3 -B - <<'PY'
import importlib.util

spec = importlib.util.spec_from_file_location("money", "backend/app/domain/money.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
assert hasattr(m, "clamp_window"), "missing clamp_window helper"

assert m.clamp_window("2024-01-01", "2024-01-10", 20) == ("2024-01-01", "2024-01-10")
assert m.clamp_window("2024-01-01", "2024-01-10", 5) == ("2024-01-01", "2024-01-05")
assert m.clamp_window("2024-01-01", "2024-01-01", 1) == ("2024-01-01", "2024-01-01")
assert m.clamp_window("2024-01-31", "2024-02-02", 2) == ("2024-01-31", "2024-02-01")
assert m.clamp_window("2024-03-10", "2024-03-01", 5) == ("2024-03-10", "2024-03-10")
for bad in [0, -1, 2.5, True, "5"]:
    try:
        m.clamp_window("2024-01-01", "2024-01-05", bad)
    except ValueError:
        pass
    else:
        raise AssertionError(f"max_days={bad!r} must raise ValueError")

# 既有窗口函数行为保持不变。
assert m.date_range("2024-03-01", "2024-03-03") == ["2024-03-01", "2024-03-02", "2024-03-03"]
assert m.in_window("2024-03-02", ("2024-03-01", "2024-03-03"))
print("PASS: clamp_window helper")
PY
