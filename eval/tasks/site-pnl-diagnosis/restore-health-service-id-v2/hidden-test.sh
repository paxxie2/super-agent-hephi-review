#!/bin/sh
set -eu
python3 -B - <<'PY'
"""F14：真实 200/503 payload + serviceId 来自共享常量的运行时证明。

做法：先导入 app.constants 并把 SERVICE_ID 改成运行时注入值，再导入 app.main；
真实 ASGI /api/health 返回的 serviceId 必须等于注入值，从而证明它来自共享常量而不是 schema 字面量。
AST/源码断言只作为辅助。
"""
import asyncio
import json
import pathlib
import sys
import tempfile

sys.path.insert(0, "backend")

import app.constants as constants

INJECTED = "runtime-injected-service-id-f14"
constants.SERVICE_ID = INJECTED

import app.db as db
from app.main import APP_VERSION, create_app
from app.settings import Settings

# 辅助：schema 不得写死 service id 字面量；main 必须使用 SERVICE_ID 构造 Health。
schemas_src = pathlib.Path("backend/app/schemas.py").read_text(encoding="utf-8")
assert "site-pnl-diagnosis-api" not in schemas_src, "serviceId must not be a schema literal"
assert "runtime-injected-service-id-f14" not in schemas_src
main_src = pathlib.Path("backend/app/main.py").read_text(encoding="utf-8")
assert "serviceId=SERVICE_ID" in main_src, "main.py must build Health with serviceId=SERVICE_ID"


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

def settings(dbp):
    return Settings(
        db_path=pathlib.Path(dbp), host="127.0.0.1", port=8000, deepseek_api_key=None,
        deepseek_base_url="https://api.deepseek.com", deepseek_model="deepseek-flash",
        request_timeout_seconds=30.0, message_budget_seconds=90.0,
    )

with tempfile.TemporaryDirectory() as tmp:
    db_path = str(pathlib.Path(tmp) / "site_pnl.db")
    db.init_db(db_path)
    app_ok = create_app(settings=settings(db_path), seed=False)
    status_ok, payload_ok = call(app_ok, "GET", "/api/health")
    assert status_ok == 200, (status_ok, payload_ok)
    assert payload_ok["serviceId"] == INJECTED == constants.SERVICE_ID, payload_ok
    assert payload_ok["status"] == "ok" and payload_ok["db"] == "ok"

    app_bad = create_app(settings=settings(tmp), seed=False)  # 目录当数据库文件 → 503
    status_bad, payload_bad = call(app_bad, "GET", "/api/health")
    assert status_bad == 503, (status_bad, payload_bad)
    assert payload_bad["serviceId"] == INJECTED, payload_bad
    assert payload_bad["status"] == "error" and payload_bad["db"] == "error"
    assert payload_bad["detail"]
print("PASS: serviceId is injected from the shared constant on real 200/503 payloads")
PY
