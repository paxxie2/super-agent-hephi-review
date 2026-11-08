#!/bin/sh
set -eu
python3 -B - <<'PY'
import importlib.util
spec = importlib.util.spec_from_file_location("validation_summary", "backend/app/validation_summary.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

assert m.summarize_validation_errors([]) == "0 validation errors"
assert m.summarize_validation_errors([{"type": "missing", "loc": ("body", "monthlyRentCents")}]) \
    == "1 validation error: monthlyRentCents"
errors = [
    {"type": "missing", "loc": ("body", "monthlyRentCents")},
    {"type": "extra_forbidden", "loc": ("body", "bogus")},
    {"type": "missing", "loc": ("body", "shareBps")},
    {"type": "int_type", "loc": ("body", "monthlyRentCents")},  # duplicate field, still a separate error
]
assert m.summarize_validation_errors(errors) == "4 validation errors: bogus, monthlyRentCents, shareBps"
assert m.summarize_validation_errors([{"type": "x", "loc": ("body",)}]) == "1 validation error: body"
assert m.summarize_validation_errors([
    {"type": "missing", "loc": ("body", "zField")},
    {"type": "missing", "loc": ("body", "aField")},
]) == "2 validation errors: aField, zField"
for bad in ({}, "errors", [1], None):
    try:
        m.summarize_validation_errors(bad)
    except TypeError:
        pass
    else:
        raise AssertionError("expected TypeError for %r" % (bad,))
print("validation summary checks PASS")
PY
