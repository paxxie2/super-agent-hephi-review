#!/bin/sh
set -eu
python3 -B - <<'PY'
import asyncio, json, sqlite3, sys, tempfile
from pathlib import Path

sys.path.insert(0, "backend")

from app.main import create_app
from app.settings import Settings

def settings_for(db_path):
    return Settings(
        db_path=db_path,
        host="127.0.0.1",
        port=8000,
        deepseek_api_key=None,
        deepseek_base_url="https://api.deepseek.com",
        deepseek_model="deepseek-flash",
        request_timeout_seconds=30.0,
        message_budget_seconds=90.0,
    )

def call(app, method, path, query="", body=None, headers=None):
    async def run():
        raw = b"" if body is None else json.dumps(body).encode("utf-8")
        hdrs = [(b"host", b"testserver")]
        if body is not None:
            hdrs.append((b"content-type", b"application/json"))
        for key, value in (headers or {}).items():
            hdrs.append((key.lower().encode("latin-1"), value.encode("latin-1")))
        scope = {
            "type": "http",
            "asgi": {"version": "3.0", "spec_version": "2.3"},
            "http_version": "1.1",
            "method": method,
            "scheme": "http",
            "path": path,
            "raw_path": path.encode("utf-8"),
            "query_string": query.encode("latin-1"),
            "root_path": "",
            "headers": hdrs,
            "server": ("testserver", 80),
            "client": ("127.0.0.1", 12345),
        }
        sent = []
        async def receive():
            return {"type": "http.request", "body": raw, "more_body": False}
        async def send(message):
            sent.append(message)
        try:
            await app(scope, receive, send)
        except Exception:
            # 与真实 ASGI server 一致：未处理异常按 500 返回，不中断请求链。
            return 500, b""
        status = next(m["status"] for m in sent if m["type"] == "http.response.start")
        payload = b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")
        return status, payload
    return asyncio.run(run())

def json_body(payload):
    try:
        return json.loads(payload.decode("utf-8"))
    except Exception:
        return {}

def has_chinese(value):
    return isinstance(value, str) and any("\u4e00" <= ch <= "\u9fff" for ch in value)

import logging

from app.db import db_status

# 本测试只断言 HTTP 行为；把产品内部的日志/Warning 静音，避免临时路径进入
# hidden-test 的 stderr 造成“三次输出不一致”（日志内容本身不是验收对象）。
logging.disable(logging.CRITICAL)

tmp = Path(tempfile.mkdtemp(prefix="health-v2-"))
blocker = tmp / "not-a-dir"
blocker.write_text("x", encoding="utf-8")
db_path = blocker / "nested" / "site.db"  # 父路径是文件：SQLite 连接必然失败
app = create_app(settings_for(db_path), seed=False)

status, payload = call(app, "GET", "/api/health")
text = payload.decode("utf-8", "replace")
data = json_body(payload)
assert status == 503, (status, text[:300])
assert data.get("status") == "error" and data.get("db") == "error", data

internal = db_status(db_path).get("error") or ""
assert internal, "fixture must produce a real internal database error"
assert internal not in text, "503 must not leak the internal DB error text"
detail = data.get("detail")
assert detail == "database unavailable", f"503 detail must be the fixed public message 'database unavailable': {detail!r}"

# 健康时 detail 不应出现内部错误；200 路径保持。
healthy = tmp / "healthy.db"
from app.db import init_db
init_db(healthy)
app_ok = create_app(settings_for(healthy), seed=False)
status_ok, payload_ok = call(app_ok, "GET", "/api/health")
data_ok = json_body(payload_ok)
assert status_ok == 200, (status_ok, payload_ok[:300])
assert data_ok.get("status") == "ok" and data_ok.get("db") == "ok", data_ok

print("PASS: 503 detail is fixed 'database unavailable' and does not leak internal DB error (ASGI behavior)")
PY
