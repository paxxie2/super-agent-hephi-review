#!/bin/sh
set -eu
python3 -B - <<'PY'
"""F14：恢复包的字节一致性 + 真实播种/加载行为（临时目录真跑 SQLite）。

AST/文件存在断言只作为辅助；核心证明是下方真实调用 seed_database/load_sites/load_site_data。
"""
import hashlib
import pathlib
import subprocess
import sys
import tempfile

sys.path.insert(0, "backend")

# 辅助：恢复内容必须与参考修复（真实历史提交 91e4bc5 的实现）字节一致。
EXPECTED = {
    "backend/app/data/__init__.py": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "backend/app/data/loader.py": "d6e8b0ffa6aa7abc19be17c73166e6c7ee01dc00d2bb3591378837cc956918fc",
    "backend/app/data/seed.py": "c4ba0d931f432c71bd7d3baa4054bb1bb546a1d1b4a9c1f2da2cdea8609f1fff",
}
for path, digest in EXPECTED.items():
    file = pathlib.Path(path)
    assert file.is_file(), f"missing restored source file: {path}"
    actual = hashlib.sha256(file.read_bytes()).hexdigest()
    assert actual == digest, f"{path} is not the byte-identical restored file: {actual}"

import app.db as db
import app.data.loader as loader
import app.data.seed as seed

with tempfile.TemporaryDirectory() as tmp:
    db_path = str(pathlib.Path(tmp) / "site_pnl.db")
    # 真实播种：空库 → 90 天固定种子数据。
    seed.seed_database(db_path)
    assert db.is_seeded(db_path), "seed_database must seed an empty database"
    sites = loader.load_sites(db_path)
    assert len(sites) == 10, f"seed must create 10 sites, got {len(sites)}"
    assert [site.id for site in sites] == [f"S{index:02d}" for index in range(1, 11)], [site.id for site in sites]
    site = loader.get_site_info("S01", db_path)
    assert site is not None and site.id == "S01" and site.name, site
    assert loader.get_site_info("S99", db_path) is None
    loaded = loader.load_site_data("S01", "2026-08-30", "2026-09-28", db_path)
    assert loaded.site.id == "S01"
    assert loaded.range_start == "2026-08-30" and loaded.range_end == "2026-09-28"
    assert loaded.orders, "restored loader must return real source records"
    bounds = loader.dataset_bounds(db_path)
    assert bounds == ("2026-07-01", "2026-09-28"), bounds
    # 幂等：再次播种不重置已有数据。
    before = len(loader.load_sites(db_path))
    seed.seed_database(db_path)
    assert len(loader.load_sites(db_path)) == before

# 辅助：源码包不被忽略（gitignore 规则）。
result = subprocess.run(["git", "check-ignore", "backend/app/data/loader.py"], capture_output=True, text=True)
assert result.returncode == 1, "backend/app/data/loader.py must not be git-ignored: " + result.stdout
lines = [line.strip() for line in pathlib.Path(".gitignore").read_text(encoding="utf-8").splitlines()]
assert "/data/" in lines and "data/" not in lines, lines
print("PASS: byte-identical data package restored; real seed/load behavior verified")
PY
