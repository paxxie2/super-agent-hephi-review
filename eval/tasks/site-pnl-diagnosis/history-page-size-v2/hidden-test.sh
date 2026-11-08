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

from app.db import init_db

tmp = Path(tempfile.mkdtemp(prefix="history-v2-"))
db_path = tmp / "site.db"
init_db(db_path)

completeness = '{"sources": {}, "unknownComponents": [], "comparisonComplete": null, "notes": []}'
conn = sqlite3.connect(db_path)
conn.execute(
    "INSERT INTO sites (id, name, city, address, case_label, planned_capacity, data_version) "
    "VALUES ('S1', '测试点位', '上海', '地址', '正常', 1, 'v1')"
)
for index in range(3):
    conn.execute(
        "INSERT INTO diagnoses (id, site_id, start_date, end_date, comparison_start, comparison_end, "
        "data_version, rule_version, completeness_json, pnl_json, daily_json, findings_json, "
        "suggestions_json, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (f"d{index + 1}", "S1", "2024-01-01", "2024-01-01", None, None, "v1", "r1",
         completeness, "{}", "[]", "[]", "[]", f"2024-02-0{index + 1}T00:00:00Z"),
    )
conn.commit()
conn.close()

app = create_app(settings_for(db_path), seed=False)

def fetch(limit, offset):
    status, payload = call(app, "GET", "/api/diagnoses", query=f"limit={limit}&offset={offset}")
    data = json_body(payload)
    assert status == 200, (status, payload[:300])
    assert "hasMore" in data, f"response must expose hasMore, got keys {sorted(data)}"
    items = data.get("items") or []
    total = data.get("total")
    assert len(items) == len(data.get("items") or []), data
    assert data["hasMore"] == (offset + len(items) < total), (limit, offset, data.get("hasMore"), len(items), total)
    return data

# 非末页：hasMore=True；末页/空页/更远 offset/整页取完：False。
first = fetch(2, 0)
assert first["hasMore"] is True and len(first["items"]) == 2 and first["total"] == 3, first
assert fetch(2, 2)["hasMore"] is False          # 末页只剩 1 条
assert fetch(2, 3)["hasMore"] is False          # 空页
assert fetch(2, 4)["hasMore"] is False          # 越界 offset
assert fetch(3, 0)["hasMore"] is False          # 一次取完
assert fetch(2, 1)["hasMore"] is False          # 偏移推移后正好到末尾
assert fetch(1, 1)["hasMore"] is True           # 偏移后仍有下一页

print("PASS: hasMore pagination behavior over HTTP (ASGI behavior)")
PY
