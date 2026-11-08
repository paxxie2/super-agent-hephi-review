#!/bin/sh
set -eu
python3 -B - <<'PY'
import importlib.util
spec = importlib.util.spec_from_file_location("money", "backend/app/domain/money.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

assert m.window_length_days("2024-03-01", "2024-03-02") == 2
assert m.window_length_days("2024-02-01", "2024-02-29") == 29   # leap February
assert m.window_length_days("2025-01-01", "2025-01-01") == 1
try:
    m.window_length_days("2024-03-02", "2024-03-01")
except ValueError:
    pass
else:
    raise AssertionError("reversed window must raise ValueError for window_length_days")

assert m.windows_adjacent(("2024-02-28", "2024-02-29"), ("2024-03-01", "2024-03-02"))
assert m.windows_adjacent(("2024-12-31", "2024-12-31"), ("2025-01-01", "2025-01-01"))
assert not m.windows_adjacent(("2024-02-01", "2024-02-28"), ("2024-03-01", "2024-03-02"))
assert not m.windows_adjacent(("2024-03-01", "2024-03-02"), ("2024-03-01", "2024-03-02"))
try:
    m.windows_adjacent(("2024-03-02", "2024-03-01"), ("2024-03-03", "2024-03-04"))
except ValueError:
    pass
else:
    raise AssertionError("reversed window must raise ValueError for windows_adjacent")
try:
    m.windows_adjacent(["2024-02-28", "2024-02-29"], ("2024-03-01", "2024-03-02"))
except TypeError:
    pass
else:
    raise AssertionError("non-tuple window must raise TypeError")
print("window length/adjacency checks PASS")
PY
