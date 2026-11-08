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

tmp = Path(tempfile.mkdtemp(prefix="bvm-"))
app = create_app(settings_for(tmp / "unused.db"), seed=False)

def post(body, key):
    return call(
        app, "POST", "/api/diagnoses/site-1/scenarios",
        body=body, headers={"Idempotency-Key": key},
    )

# 1) 必填错误：经 RequestValidationError → 中文“为必填”（新模块字段标签）。
status1, payload1 = post({"monthlyRentCents": 100}, "bvm-1")
data1 = json_body(payload1)
errors1 = data1.get("fieldErrors") or {}
assert status1 == 400, (status1, payload1[:300])
assert data1.get("code") == "VALIDATION_ERROR", data1
assert "kind" in errors1, errors1
assert "测算类型" in errors1["kind"] and "必填" in errors1["kind"], errors1
assert all(has_chinese(value) for value in errors1.values()), errors1

# 2) 枚举错误：中文可操作提示，不再出现 Pydantic 英文默认消息。
status2, payload2 = post({"kind": "bogus"}, "bvm-2")
data2 = json_body(payload2)
errors2 = data2.get("fieldErrors") or {}
assert status2 == 400, (status2, payload2[:300])
assert "kind" in errors2 and has_chinese(errors2["kind"]), errors2
assert "Input should be" not in payload2.decode("utf-8", "replace"), "English pydantic default must not leak"

# 3) 类型错误：字段级中文“必须为整数”（自定义校验器路径）。
status3, payload3 = post({"kind": "rent", "monthlyRentCents": "30000"}, "bvm-3")
data3 = json_body(payload3)
errors3 = data3.get("fieldErrors") or {}
assert status3 == 400, (status3, payload3[:300])
assert "monthlyRentCents" in errors3, errors3
assert "整数" in errors3["monthlyRentCents"], errors3

# 4) 统一错误体结构保持不变。
assert {"code", "message", "fieldErrors", "requestId"} <= set(data3), sorted(data3)

print("PASS: Chinese field-level messages produced by the HTTP validation path (ASGI behavior)")
PY
