# 合法范围复核（agent 辅助评审）

本任务由 B2 执行者（agent 辅助）从本地真实仓库历史提交 `abdef2f3de6ffd936735694e85dcc25a35516fa6`（`HEPHI stage backend-validation: 完善租金/分成/故障恢复测算的后端输入校验：缺失、错误类型、非有限数、负数、越界比例均返回 400 字段级中文错误；不修改金额公式与业务口径；补充后端回归测试。`）派生：
固定 base `e00f338b098546adc40156dc15b4b6559e19835d` 为该提交的父提交，`reference.patch` 是该提交对这些文件的真实 `git diff`。

## 合法范围
合法范围仅限 `reference.patch` 中的文件：`backend/app/main.py`, `backend/app/schemas.py`, `backend/app/services/chat.py`, `backend/app/services/scenarios.py`, `backend/app/validation_messages.py`, `backend/tests/test_scenario_api.py`。没有加入任何额外的无关修改；`task.json.allowedFiles` 与补丁文件一一对应，full-mode 的 `allowed-scope` 检查确认 `outside=[]`。

## 评审者说明（如实）
**评审者为 agent 辅助评审，非两名人类评审。** 本轮没有第二独立人类复核者、没有评审者签名或裁决记录；本文件不能作为双人人类评审证据。

## 已经实际执行（full-mode，非 dry-run）
`node eval/check-task.mjs <taskDir> --repo <本机仓库> --repeats 3 --json`：base 隐藏测试退出码非 0（目标断言/模块缺失，见 `eval/B2-audit.md` 中记录的 exit code 与 outputSha256），应用 `reference.patch` 后 3/3 通过且 3 次输出一致，范围检查无越界。原始 JSON 由执行者保存在本地临时证据目录，未伪造。

## 未验证项
未做真实模型运行、未做人类双评审、未验证该提交在完整仓库工具链下的全部回归测试（hidden-test 只覆盖本任务目标断言）；污染门槛未达标（见 task.json.contamination）。


## F14 整改（Stream D2，外部审查）

- **原缺口**：hidden-test 只调用 `validation_messages.py` 的纯函数，未验证 issue 要求的 `schemas.py` / `main.py` 接入路径（真实校验失败 → 响应含该模块消息）。
- **现行为覆盖**：用标准库 `asyncio` 的 ASGI 直驱真实 HTTP 请求到 `POST /api/diagnoses/{id}/scenarios`（写请求；临时 app，无外部服务）：
  1. 缺 `kind` → 400 `VALIDATION_ERROR`，`fieldErrors.kind` 含中文“测算类型为必填”；
  2. 非法 `kind` → `fieldErrors.kind` 为中文且响应不出现 Pydantic 英文默认 `Input should be`；
  3. `monthlyRentCents` 传字符串 → `fieldErrors.monthlyRentCents` 含“必须为整数”（自定义校验器经 `value_error` 路径）；
  4. 统一错误体结构 `{code,message,fieldErrors,requestId}` 保持。
  端点校验在真实 FastAPI 请求链中执行（`RequestValidationError` 处理器经新模块转换），非直接调用纯函数。
- **reference.patch 改动**：无（历史补丁已含接入路径；未改语义）。
- **full-mode 结果**：`ok:true`；base 3/3 失败（`{'kind': 'Field required'}`，即 base 无中文消息/模块），reference 3/3 通过；`outside=[]`。
- **限制**：ASGI 直驱为进程内真实请求，但不是真实部署端到端；AST 已移除；未做真实模型运行。
- **校验分类（F15 后的 check-task）**：base 3/3 均为 `target-assertion-failed`（非 environment-error），3 次 `normalizedSha256` 相同；reference 3/3 `codes=[0,0,0]` 且输出一致。
