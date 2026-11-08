#!/bin/sh
set -eu
python3 -B - <<'PY'
"""播种路径与忽略规则的真实行为断言：真实调用 seed_database 播种临时 SQLite，
并用真实临时 git 仓库验证 .gitignore 的 check-ignore 语义。"""
import os
import pathlib
import sqlite3
import subprocess
import sys
import tempfile

for path in ["backend/app/data/__init__.py", "backend/app/data/seed.py"]:
    assert os.path.isfile(path), f"missing restored source file {path}"

sys.path.insert(0, "backend")
from app.data.seed import seed_database  # noqa: E402


def counts(db: str) -> dict[str, int]:
    conn = sqlite3.connect(db)
    try:
        return {
            table: int(conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
            for table in ("sites", "orders", "devices", "coverage", "rent_contracts", "share_contracts")
        }
    finally:
        conn.close()


with tempfile.TemporaryDirectory() as tmp:
    db = os.path.join(tmp, "runtime.db")
    seed_database(db)
    assert os.path.isfile(db), "seed_database must create the SQLite database"
    seeded = counts(db)
    assert seeded["sites"] == 10, seeded
    for table in ("orders", "devices", "coverage", "rent_contracts", "share_contracts"):
        assert seeded[table] > 0, (table, seeded)
    conn = sqlite3.connect(db)
    try:
        meta = dict(conn.execute("SELECT key, value FROM app_meta").fetchall())
        assert meta.get("data_version"), meta
        assert meta.get("dataset_start") and meta.get("dataset_end"), meta
    finally:
        conn.close()
    # Idempotent: seeding a non-empty database never resets or duplicates rows.
    seed_database(db)
    assert counts(db) == seeded, (seeded, counts(db))

# Ignore rules are checked by git itself in a real temporary repository.
gitignore = pathlib.Path(".gitignore").read_text(encoding="utf-8")
with tempfile.TemporaryDirectory() as tmp:
    pathlib.Path(tmp, ".gitignore").write_text(gitignore, encoding="utf-8")
    subprocess.run(["git", "-C", tmp, "init", "-q"], check=True)

    def touch(relative: str) -> None:
        file = pathlib.Path(tmp, relative)
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text("x", encoding="utf-8")

    def ignored(relative: str) -> bool:
        result = subprocess.run(
            ["git", "-C", tmp, "check-ignore", "--no-index", "-q", relative],
            capture_output=True,
        )
        return result.returncode == 0

    touch("backend/app/data/seed.py")
    assert not ignored("backend/app/data/seed.py"), "restored source must not be git-ignored"
    touch("backend/app/data/runtime.db")
    assert not ignored("backend/app/data/runtime.db"), "root-anchored rule must not swallow package files"
    for relative in ("data/runtime.db", "data/runtime.db-wal", "data/runtime.db-shm"):
        touch(relative)
        assert ignored(relative), f"runtime database file must be ignored: {relative}"

print("PASS: seed restores empty-db seeding and precise runtime-database ignore rules")
PY
