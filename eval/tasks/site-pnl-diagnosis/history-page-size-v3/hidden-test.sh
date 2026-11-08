#!/bin/sh
set -eu
python3 -B - <<'PY'
"""GET /api/diagnoses 可选 siteId 过滤的服务层与 HTTP 路由行为断言。

真实临时 SQLite + 真实服务函数；并用标准库 asyncio/json 直接驱动仓库 ASGI 应用
（不联网、不起服务），断言 HTTP 路由把 siteId query 参数正确传给服务层。
"""
import asyncio
import json
import os
import sqlite3
import sys
import tempfile
import urllib.parse

sys.path.insert(0, "backend")
from app.db import init_db  # noqa: E402
from app.services import diagnoses as service  # noqa: E402
from app.main import app  # noqa: E402

COMPLETENESS = json.dumps({"sources": {}, "unknownComponents": [], "comparisonComplete": None, "notes": []})
EMPTY_LIST = "[]"


def call_get(params: dict[str, str] | None = None) -> tuple[int, dict]:
    """直接以 ASGI 接口发起 GET /api/diagnoses 请求，返回 (status, JSON body)。"""
    query = urllib.parse.urlencode(params or {}).encode()
    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": "/api/diagnoses",
        "raw_path": b"/api/diagnoses",
        "query_string": query,
        "root_path": "",
        "headers": [(b"accept", b"application/json")],
        "client": ("127.0.0.1", 12345),
        "server": ("testserver", 80),
        "state": {},
    }
    captured = {"status": None, "body": b""}

    async def receive() -> dict:
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message: dict) -> None:
        if message["type"] == "http.response.start":
            captured["status"] = message["status"]
        elif message["type"] == "http.response.body":
            captured["body"] += message.get("body", b"")

    asyncio.run(app(scope, receive, send))
    return int(captured["status"]), json.loads(captured["body"].decode())


def insert_site(conn: sqlite3.Connection, site_id: str, name: str) -> None:
    conn.execute(
        "INSERT INTO sites (id, name, city, address, case_label, planned_capacity, data_version) "
        "VALUES (?, ?, '上海', '测试地址', '正常盈利', 6, 'data-test')",
        (site_id, name),
    )


def insert_diagnosis(conn: sqlite3.Connection, diagnosis_id: str, site_id: str, created_at: str) -> None:
    conn.execute(
        "INSERT INTO diagnoses (id, site_id, start_date, end_date, comparison_start, comparison_end, "
        "data_version, rule_version, completeness_json, pnl_json, daily_json, findings_json, "
        "suggestions_json, created_at) "
        "VALUES (?, ?, '2026-08-30', '2026-09-28', NULL, NULL, 'data-test', 'rule-test', ?, '{}', ?, ?, ?, ?)",
        (diagnosis_id, site_id, COMPLETENESS, EMPTY_LIST, EMPTY_LIST, EMPTY_LIST, created_at),
    )


with tempfile.TemporaryDirectory() as tmp:
    db = os.path.join(tmp, "runtime.db")
    init_db(db)
    conn = sqlite3.connect(db)
    try:
        insert_site(conn, "S01", "静安寺地铁店")
        insert_site(conn, "S02", "陆家嘴商城店")
        # Mixed sites; S01 has two diagnoses, S02 one. Latest first for S01.
        insert_diagnosis(conn, "d_s01_old", "S01", "2026-09-01T10:00:00+08:00")
        insert_diagnosis(conn, "d_s02", "S02", "2026-09-02T10:00:00+08:00")
        insert_diagnosis(conn, "d_s01_new", "S01", "2026-09-03T10:00:00+08:00")
        conn.commit()
    finally:
        conn.close()

    # Unfiltered behavior is unchanged (still returns every site).
    items, total = service.list_diagnoses(db, 10, 0)
    assert total == 3, total
    assert {item.siteId for item in items} == {"S01", "S02"}, [item.siteId for item in items]
    page = service.get_diagnosis_page(db, 10, 0)
    assert page.total == 3 and len(page.items) == 3, (page.total, len(page.items))

    # siteId narrows both count and page rows, preserving the created_at DESC order.
    items, total = service.list_diagnoses(db, 10, 0, "S01")
    assert total == 2, total
    assert [item.id for item in items] == ["d_s01_new", "d_s01_old"], [item.id for item in items]
    assert all(item.siteId == "S01" for item in items)
    filtered = service.get_diagnosis_page(db, 10, 0, "S01")
    assert filtered.total == 2 and [item.id for item in filtered.items] == ["d_s01_new", "d_s01_old"]

    # A site without diagnoses returns an empty page, not the unfiltered page.
    missing = service.get_diagnosis_page(db, 10, 0, "S99")
    assert missing.total == 0 and missing.items == [], (missing.total, missing.items)

    # Pagination stays consistent with the filter.
    first = service.get_diagnosis_page(db, 1, 0, "S01")
    second = service.get_diagnosis_page(db, 1, 1, "S01")
    assert [item.id for item in first.items] == ["d_s01_new"] and first.total == 2
    assert [item.id for item in second.items] == ["d_s01_old"] and second.total == 2

    # ---- HTTP route: the real GET /api/diagnoses passes siteId to the service ----
    app.state.db_path = db

    status, body = call_get()
    assert status == 200, (status, body)
    assert body["total"] == 3 and len(body["items"]) == 3, body
    assert {item["siteId"] for item in body["items"]} == {"S01", "S02"}
    assert body["limit"] == 20 and body["offset"] == 0, body

    status, body = call_get({"siteId": "S01"})
    assert status == 200, (status, body)
    assert body["total"] == 2 and len(body["items"]) == 2, body
    assert [item["id"] for item in body["items"]] == ["d_s01_new", "d_s01_old"], body
    assert all(item["siteId"] == "S01" for item in body["items"])

    status, body = call_get({"siteId": "S99"})
    assert status == 200, (status, body)
    assert body["total"] == 0 and body["items"] == [], body

    status, body = call_get({"siteId": "S01", "limit": "1", "offset": "1"})
    assert status == 200, (status, body)
    assert body["total"] == 2 and len(body["items"]) == 1, body
    assert body["items"][0]["id"] == "d_s01_old", body
    assert body["limit"] == 1 and body["offset"] == 1, body

print("PASS: optional siteId filtering (service and HTTP route) with unchanged unfiltered behavior")
PY
