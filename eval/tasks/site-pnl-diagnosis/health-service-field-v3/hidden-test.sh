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

import app.db as db_mod
import app.main as main_mod

tmp = Path(tempfile.mkdtemp(prefix="health-v3-"))
db_path = tmp / "site.db"
app = None
counts = {"db_status": 0, "connect": 0}
orig_status = main_mod.db_status
orig_connect = db_mod.connect

def counting_status(path):
    counts["db_status"] += 1
    return orig_status(path)

def counting_connect(path):
    counts["connect"] += 1
    return orig_connect(path)

main_mod.db_status = counting_status
db_mod.connect = counting_connect
app = create_app(settings_for(db_path), seed=False)

# 先证明计数 stub 生效：普通 /api/health 会真的访问 DB。
status_health, _ = call(app, "GET", "/api/health")
assert status_health in (200, 503), status_health
assert counts["db_status"] + counts["connect"] > 0, "counter stub must observe real DB access on /api/health"

counts["db_status"] = 0
counts["connect"] = 0

# liveness：恒 200、返回 ok、且零 DB 访问（sync/async 实现均可）。
status, payload = call(app, "GET", "/api/health/live")
data = json_body(payload)
assert status == 200, (status, payload[:300])
assert data.get("status") == "ok", data
assert counts["db_status"] == 0 and counts["connect"] == 0, f"liveness must not access DB: {counts}"

print("PASS: /api/health/live returns 200 with zero DB access (ASGI behavior)")
PY
