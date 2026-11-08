# 合法范围复核（agent 辅助评审）

本卡为 B5 变体批次 3 的新需求点变体，由执行 Agent（agent 辅助）按批次要求定义，**不是**从某条历史提交派生：`reference.patch` 是针对需求点编写的最小实现补丁，`base e00f338b098546adc40156dc15b4b6559e19835d` 为本地只读 site-pnl clone 中真实存在的提交（不属于本卡补丁）。

## 合法范围
合法范围仅限 `reference.patch` 中的文件：`backend/app/schemas.py`。没有加入任何额外的无关修改；`task.json.allowedFiles` 与补丁文件一一对应，full-mode 的 `allowed-scope` 检查确认 `outside=[]`。

## 评审者说明（如实）
**评审者为 agent 辅助评审，非两名人类评审。** 本轮没有第二独立人类复核者、没有评审者签名或裁决记录；本文件不能作为双人人类评审证据。本卡是**新定义需求点**，不是历史故障宣称，也不是已准入的正式样本。

## 已经实际执行（full-mode）
`node eval/check-task.mjs <taskDir> --repo <本机 site-pnl-diagnosis clone> --repeats 3 --json`：base 隐藏测试连续 3 次退出码非 0，应用 `reference.patch` 后连续 3 次通过且输出一致，范围检查无越界。原始报告保存在本目录 `validation.json`（由同一次 full-mode 运行生成），未伪造。

## 未验证项
未做真实模型运行、未做人类双评审、未验证该补丁在完整仓库工具链下的全部回归测试（hidden-test 只覆盖本任务目标断言）；污染门槛未达标（见 task.json.contamination）。


## F14 整改（Stream D2，外部审查）

- **原缺口**：hidden-test 仅 AST 检查 `ConfigDict(extra="forbid")`，未验证真实请求会被拒绝，也无法区分“形状正确但行为错误”的实现，且会误拒等价实现。
- **现行为覆盖**：用标准库 `asyncio` 的极简 ASGI 直驱（临时目录/临时 app，无外部服务）实际发送写请求：
  1. `POST /api/diagnoses` 带未知字段 `bogusField` → 断言 400/422、`code=VALIDATION_ERROR`、响应文本包含 `bogusField`；
  2. `POST /api/diagnoses/{id}/scenarios` 带未知字段 → 同样断言响应指向未知字段；
  3. 仅含已知字段（只缺必填项）的请求 → 断言不被报成“不支持的字段”。
  等价实现（不用 ConfigDict、行为正确）可通过；AST 已完全移除，不再作为判据。
- **reference.patch 改动（需求修订，负责人已批准 2026-11-09——非『语义不变』）**：原卡仅要求拒绝未知字段；加强后的验收（响应含 code 与字段名）超出原语义，属任务修订：原补丁用 `ConfigDict(extra="forbid")`，但 pydantic 的 `extra_forbidden` 错误 `loc` 只有 `body`，响应不携带未知字段名，无法满足 issue“错误指向未知字段”。现补丁改为 `StrictRequestModel`（`ConfigDict(extra="forbid")` + before `model_validator` 显式列出未知字段并写入中文消息），行为仍是“拒绝未知字段”，仅补齐字段名定位；补丁已重新生成。
- **full-mode 结果**：`ok:true`；base 3/3 失败（`error response must point at the unknown field: {"fieldErrors":{"siteId":"Field required"}...}`，即 base 不报未知字段），reference 3/3 通过且退出码一致；`outside=[]`。
- **限制**：AST 不再使用；未做变异测试、未做真实模型运行。
- **校验分类（F15 后的 check-task）**：base 3/3 均为 `target-assertion-failed`（非 environment-error），3 次 `normalizedSha256` 相同；reference 3/3 `codes=[0,0,0]` 且输出一致。
