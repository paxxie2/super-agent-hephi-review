#!/bin/sh
set -eu
python3 -B - <<'PY'
import importlib.util

spec = importlib.util.spec_from_file_location("money", "backend/app/domain/money.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
assert hasattr(m, "window_months"), "missing window_months helper"

assert m.window_months("2024-01-31", "2024-03-01") == ["2024-01", "2024-02", "2024-03"]
assert m.window_months("2024-03-05", "2024-03-31") == ["2024-03"]
assert m.window_months("2024-12-15", "2025-02-02") == ["2024-12", "2025-01", "2025-02"]
assert m.window_months("2024-03-31", "2024-01-01") == []

# 既有窗口函数行为保持不变。
assert m.date_range("2024-03-01", "2024-03-03") == ["2024-03-01", "2024-03-02", "2024-03-03"]
assert m.date_range("2024-03-03", "2024-03-01") == []
assert m.previous_window("2024-03-01", "2024-03-02") == ("2024-02-28", "2024-02-29")
try:
    m.window_months("not-a-date", "2024-03-01")
except ValueError:
    pass
else:
    raise AssertionError("invalid date must raise ValueError")
print("PASS: window_months helper")
PY
