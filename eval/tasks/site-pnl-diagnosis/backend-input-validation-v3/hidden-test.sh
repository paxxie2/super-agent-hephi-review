#!/bin/sh
set -eu
python3 -B - <<'PY'
"""415/404/405/兜底错误码的真实 HTTP 行为断言。

不联网、不装依赖、不起实例：直接以 ASGI 接口驱动仓库内 app，标准库 asyncio/json
构造请求与解析响应。415 通过真实的非 JSON Content-Type 请求触发。
"""
import asyncio
import json
import os
import sys

sys.path.insert(0, "backend")

from app.main import app  # noqa: E402  (repo 内应用；导入需要仓库自身依赖)
from fastapi import Request  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402
from fastapi.routing import APIRoute  # noqa: E402
from starlette.exceptions import HTTPException as StarletteHTTPException  # noqa: E402


def call(method: str, path: str, headers: dict[str, str] | None = None, body: bytes = b"") -> tuple[int, dict]:
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
        "headers": [(key.lower().encode(), value.encode()) for key, value in (headers or {}).items()],
        "client": ("127.0.0.1", 12345),
        "server": ("testserver", 80),
        "state": {},
    }
    captured = {"status": None, "body": b""}
    pending = {"body": body}

    async def receive() -> dict:
        data = pending["body"]
        pending["body"] = b""
        return {"type": "http.request", "body": data, "more_body": False}

    async def send(message: dict) -> None:
        if message["type"] == "http.response.start":
            captured["status"] = message["status"]
        elif message["type"] == "http.response.body":
            captured["body"] += message.get("body", b"")

    asyncio.run(app(scope, receive, send))
    return int(captured["status"]), json.loads(captured["body"].decode())


# 404：未知 API 路由走统一错误体。
status, payload = call("GET", "/api/definitely-not-a-route")
assert status == 404, status
assert payload["code"] == "NOT_FOUND", payload
# 405：已知路由的错误方法。
status, payload = call("POST", "/api/health")
assert status == 405, status
assert payload["code"] == "METHOD_NOT_ALLOWED", payload
# 415：真实的非 JSON Content-Type 请求（写入类 API）必须返回统一 415 错误体。
status, payload = call("POST", "/api/diagnoses", {"Content-Type": "text/plain"}, b"not json")
assert status == 415, (status, payload)
assert payload["code"] == "UNSUPPORTED_MEDIA_TYPE", payload
assert payload.get("fieldErrors") == {} and payload.get("requestId"), payload
# 兜底：未知 HTTP 状态（测试后注入路由）映射为 HTTP_ERROR，不影响真实路由。
async def teapot(request: Request) -> JSONResponse:
    raise StarletteHTTPException(status_code=418, detail="teapot")

# 插入到 SPA catch-all 之前，保证测试注入的探针路由能匹配。
app.router.routes.insert(0, APIRoute("/api/f4-probe-teapot", teapot, methods=["GET"]))
status, payload = call("GET", "/api/f4-probe-teapot")
assert status == 418, status
assert payload["code"] == "HTTP_ERROR", payload
# 415 的 handler 映射同样为 UNSUPPORTED_MEDIA_TYPE（注入 415 抛出处，验证映射本身）。
async def unsupported(request: Request) -> JSONResponse:
    raise StarletteHTTPException(status_code=415, detail="Unsupported Media Type")

app.router.routes.insert(0, APIRoute("/api/f4-probe-415", unsupported, methods=["GET"]))
status, payload = call("GET", "/api/f4-probe-415")
assert status == 415, status
assert payload["code"] == "UNSUPPORTED_MEDIA_TYPE", payload
print("PASS: 415/404/405/fallback HTTP error bodies")
PY
