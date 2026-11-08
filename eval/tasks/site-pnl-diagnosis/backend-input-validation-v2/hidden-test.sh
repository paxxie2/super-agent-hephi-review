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

tmp = Path(tempfile.mkdtemp(prefix="bi-v2-"))
app = create_app(settings_for(tmp / "unused.db"), seed=False)

# AT 1: CreateDiagnosisRequest 拒绝未知字段，并把字段名写进响应。
# （同时缺 siteId，保证 base 上也会走校验错误路径，失败信息指向“没有指出未知字段”本身。）
status, payload = call(
    app, "POST", "/api/diagnoses",
    body={"startDate": "2024-01-01", "endDate": "2024-01-05", "bogusField": 1},
    headers={"Idempotency-Key": "bi-v2-1"},
)
text = payload.decode("utf-8", "replace")
data = json_body(payload)
assert status in (400, 422), (status, text[:300])
assert "bogusField" in text, f"error response must point at the unknown field: {text[:300]}"
assert data.get("code") == "VALIDATION_ERROR", data

# AT 2: ScenarioRequest 拒绝未知字段（写请求；Idempotency-Key 必备）。
status2, payload2 = call(
    app, "POST", "/api/diagnoses/site-1/scenarios",
    body={"kind": "bogus", "bogusField": 1},
    headers={"Idempotency-Key": "bi-v2-2"},
)
text2 = payload2.decode("utf-8", "replace")
data2 = json_body(payload2)
assert status2 in (400, 422), (status2, text2[:300])
assert "bogusField" in text2, f"scenario error response must point at the unknown field: {text2[:300]}"
assert data2.get("code") == "VALIDATION_ERROR", data2

# AT 3: 已知字段的请求不被“未知字段”误拒（只缺必填字段，不触发未知字段错误）。
status3, payload3 = call(
    app, "POST", "/api/diagnoses",
    body={"startDate": "2024-01-01", "endDate": "2024-01-05"},
    headers={"Idempotency-Key": "bi-v2-3"},
)
text3 = payload3.decode("utf-8", "replace")
assert status3 in (400, 422), (status3, text3[:300])
assert "不支持的字段" not in text3 and "bogus" not in text3, f"known fields must not be reported as unknown: {text3[:300]}"

print("PASS: unknown request fields are rejected and named (ASGI behavior)")
PY
