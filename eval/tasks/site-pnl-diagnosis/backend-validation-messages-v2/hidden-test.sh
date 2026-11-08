#!/bin/sh
set -eu
python3 -B - <<'PY'
import importlib.util
spec = importlib.util.spec_from_file_location("validation_i18n", "backend/app/validation_i18n.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

errors = [
    {"type": "missing", "loc": ("body", "monthlyRentCents")},
    {"type": "int_type", "loc": ("body", "shareBps")},
    {"type": "float_finite", "loc": ("body", "monthlyRentCents")},  # duplicate: first error wins
    {"type": "greater_than_equal", "loc": ("body", "recoveryBps"), "ctx": {"ge": 0}},
    {"type": "less_than_equal", "loc": ("body", "repairCostCents"), "ctx": {"le": 10000}},
    {"type": "extra_forbidden", "loc": ("body", "bogus")},
    {"type": "literal_error", "loc": ("body", "kind"), "ctx": {"expected": "'rent' or 'share'"}},
    {"type": "unexpected_kind", "loc": ("body", "note"), "msg": "invalid note"},
    {"type": "missing", "loc": ("body",)},
]
out = m.bilingual_field_errors(errors)
expected_fields = {"monthlyRentCents", "shareBps", "recoveryBps", "repairCostCents", "bogus", "kind", "note", "body"}
assert expected_fields <= set(out), out
for field in expected_fields:
    assert set(out[field]) == {"zh", "en"}, (field, out[field])
    assert any("\u4e00" <= ch <= "\u9fff" for ch in out[field]["zh"]), (field, out[field])
    assert out[field]["en"], (field, out[field])
assert out["monthlyRentCents"] == {"zh": "必填", "en": "is required"}, out["monthlyRentCents"]
assert "整数" in out["shareBps"]["zh"] and "integer" in out["shareBps"]["en"], out["shareBps"]
assert "0" in out["recoveryBps"]["zh"] and "0" in out["recoveryBps"]["en"], out["recoveryBps"]
assert "10000" in out["repairCostCents"]["zh"] and "10000" in out["repairCostCents"]["en"], out["repairCostCents"]
assert out["bogus"] == {"zh": "不支持字段", "en": "is not allowed"}, out["bogus"]
assert "rent" in out["kind"]["zh"] and "rent" in out["kind"]["en"], out["kind"]
assert out["note"] == {"zh": "参数不合法", "en": "invalid note"}, out["note"]
assert out["body"] == {"zh": "必填", "en": "is required"}, out["body"]
for bad in ({}, "not-a-list", [1]):
    try:
        m.bilingual_field_errors(bad)
    except TypeError:
        pass
    else:
        raise AssertionError("expected TypeError for %r" % (bad,))
print("bilingual field messages PASS")
PY
