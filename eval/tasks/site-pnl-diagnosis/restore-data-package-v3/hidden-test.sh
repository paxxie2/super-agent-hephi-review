#!/bin/sh
set -eu
python3 -B - <<'PY'
"""F14：loader-only 变体的真实加载行为与未知点位错误分支（临时目录真跑 SQLite）。

AST/文件存在断言只作为辅助；核心证明是真实 init_db + load_sites/get_site_info/load_site_data。
"""
import hashlib
import pathlib
import subprocess
import sys
import tempfile

sys.path.insert(0, "backend")

# 辅助：参考修复恢复的 loader 与真实历史实现字节一致。
EXPECTED_LOADER = "d6e8b0ffa6aa7abc19be17c73166e6c7ee01dc00d2bb3591378837cc956918fc"
loader_path = pathlib.Path("backend/app/data/loader.py")
assert loader_path.is_file(), "missing restored source file: backend/app/data/loader.py"
assert hashlib.sha256(loader_path.read_bytes()).hexdigest() == EXPECTED_LOADER

import app.db as db
import app.data.loader as loader

with tempfile.TemporaryDirectory() as tmp:
    db_path = str(pathlib.Path(tmp) / "empty.db")
    db.init_db(db_path)  # 真实 schema，但没有播种数据
    assert loader.load_sites(db_path) == [], "an initialized empty database must load as an empty site list"
    assert loader.get_site_info("S99", db_path) is None, "unknown site must return None, not raise"
    try:
        loader.load_site_data("S99", "2026-08-30", "2026-09-28", db_path)
    except ValueError as exc:
        assert "unknown site: S99" in str(exc), exc
    else:
        raise AssertionError("load_site_data must raise ValueError for an unknown site")
    assert loader.dataset_bounds(db_path) == ("2026-07-01", "2026-09-28")

    # 可用加载路径：插入一个最小站点后，真实读取路径返回该站点。
    import sqlite3
    conn = sqlite3.connect(db_path)
    conn.execute(
        "INSERT INTO sites (id, name, city, address, case_label, planned_capacity, data_version) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        ("S01", "F14 站点", "上海", "地址", "正常盈利", 6, "sim-v1-2026-07-01_2026-09-28"),
    )
    conn.commit()
    conn.close()
    sites = loader.load_sites(db_path)
    assert [site.id for site in sites] == ["S01"], [site.id for site in sites]
    assert loader.get_site_info("S01", db_path).name == "F14 站点"
    loaded = loader.load_site_data("S01", "2026-08-30", "2026-09-28", db_path)
    assert loaded.site.id == "S01" and loaded.range_start == "2026-08-30"

# 辅助：否定规则让源码包可跟踪。
result = subprocess.run(["git", "check-ignore", "backend/app/data/loader.py"], capture_output=True, text=True)
assert result.returncode == 1, "backend/app/data/loader.py must not be git-ignored: " + result.stdout
lines = [line.strip() for line in pathlib.Path(".gitignore").read_text(encoding="utf-8").splitlines()]
assert "data/" in lines and "!/backend/app/data/" in lines and "!/backend/app/data/**/*.py" in lines
print("PASS: loader read/error paths behave on a real database")
PY
