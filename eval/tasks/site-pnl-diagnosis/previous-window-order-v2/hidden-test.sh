#!/bin/sh
set -eu
python3 -B - <<'PY'
import importlib.util
spec = importlib.util.spec_from_file_location("money", "backend/app/domain/money.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

# Two equal-length windows immediately before 2024-03-01..02, earliest first.
assert m.previous_windows("2024-03-01", "2024-03-02", 2) == [
    ("2024-02-26", "2024-02-27"),
    ("2024-02-28", "2024-02-29"),
]
# One single-day window across the year boundary.
assert m.previous_windows("2025-01-01", "2025-01-01", 1) == [("2024-12-31", "2024-12-31")]
# Leap-year sequence stays aligned on single days, earliest first.
assert m.previous_windows("2024-03-01", "2024-03-01", 3) == [
    ("2024-02-27", "2024-02-27"),
    ("2024-02-28", "2024-02-28"),
    ("2024-02-29", "2024-02-29"),
]
for args in [
    ("2024-03-02", "2024-03-01", 1),   # reversed window
    ("2024-03-01", "2024-03-02", 0),   # count below one
    ("2024-03-01", "2024-03-02", True),  # bool is not an integer count
]:
    try:
        m.previous_windows(*args)
    except ValueError:
        pass
    else:
        raise AssertionError("expected ValueError for %r" % (args,))
print("previous_windows sequence checks PASS")
PY
