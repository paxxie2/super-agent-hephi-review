#!/bin/sh
set -eu
python3 -B - <<'PY'
"""F14：数据包恢复的真实行为 + /api/health 真实输出（200/503 都带 service）。

AST/字节哈希只作为辅助；核心证明是真跑 seed/load 与真实 ASGI health 响应。
"""
import asyncio
import hashlib
import json
import pathlib
import sys
import tempfile

sys.path.insert(0, "backend")

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
from app.main import create_app
from app.settings import Settings


def call(app, method, path):
    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": method,
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "root_path": "",
        "headers": [],
        "client": ("127.0.0.1", 12345),
        "server": ("testserver", 80),
        "state": {},
    }
    captured = {"status": None, "body": b""}

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        if message["type"] == "http.response.start":
            captured["status"] = message["status"]
        elif message["type"] == "http.response.body":
            captured["body"] += message.get("body", b"")

    asyncio.run(app(scope, receive, send))
    return int(captured["status"]), json.loads(captured["body"].decode())


def settings_for(dbp):
    return Settings(
        db_path=pathlib.Path(dbp), host="127.0.0.1", port=8000, deepseek_api_key=None,
        deepseek_base_url="https://api.deepseek.com", deepseek_model="deepseek-flash",
        request_timeout_seconds=30.0, message_budget_seconds=90.0,
    )


with tempfile.TemporaryDirectory() as tmp:
    db_path = str(pathlib.Path(tmp) / "site_pnl.db")
    seed.seed_database(db_path)
    assert db.is_seeded(db_path)
    sites = loader.load_sites(db_path)
    assert len(sites) == 10, len(sites)
    loaded = loader.load_site_data("S01", "2026-08-30", "2026-09-28", db_path)
    assert loaded.site.id == "S01" and loaded.orders

    app_ok = create_app(settings=settings_for(db_path), seed=False)
    status_ok, payload_ok = call(app_ok, "GET", "/api/health")
    assert status_ok == 200, (status_ok, payload_ok)
    assert payload_ok["service"] == "site-pnl-diagnosis", payload_ok
    assert payload_ok["status"] == "ok" and payload_ok["db"] == "ok", payload_ok
    assert payload_ok["seeded"] is True and payload_ok["dataVersion"], payload_ok

    # 503：数据库不可读（把目录当数据库文件）仍返回同一 Health 结构，包含 service。
    app_bad = create_app(settings=settings_for(tmp), seed=False)
    status_bad, payload_bad = call(app_bad, "GET", "/api/health")
    assert status_bad == 503, (status_bad, payload_bad)
    assert payload_bad["service"] == "site-pnl-diagnosis", payload_bad
    assert payload_bad["status"] == "error" and payload_bad["db"] == "error", payload_bad
    assert payload_bad["detail"], payload_bad
print("PASS: restored data behaviour and real health 200/503 payloads expose the service id")
PY
