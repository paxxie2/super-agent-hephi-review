# 合法范围复核（agent 辅助评审）

本卡为 B5 变体批次 3 的新需求点变体，由执行 Agent（agent 辅助）按批次要求定义，**不是**从某条历史提交派生：`reference.patch` 是针对需求点编写的最小实现补丁，`base e00f338b098546adc40156dc15b4b6559e19835d` 为本地只读 site-pnl clone 中真实存在的提交（不属于本卡补丁）。

## 合法范围
合法范围仅限 `reference.patch` 中的文件：`backend/app/main.py`。没有加入任何额外的无关修改；`task.json.allowedFiles` 与补丁文件一一对应，full-mode 的 `allowed-scope` 检查确认 `outside=[]`。

## 评审者说明（如实）
**评审者为 agent 辅助评审，非两名人类评审。** 本轮没有第二独立人类复核者、没有评审者签名或裁决记录；本文件不能作为双人人类评审证据。本卡是**新定义需求点**，不是历史故障宣称，也不是已准入的正式样本。

## 已经实际执行（full-mode）
`node eval/check-task.mjs <taskDir> --repo <本机 site-pnl-diagnosis clone> --repeats 3 --json`：base 隐藏测试连续 3 次退出码非 0，应用 `reference.patch` 后连续 3 次通过且输出一致，范围检查无越界。原始报告保存在本目录 `validation.json`（由同一次 full-mode 运行生成），未伪造。

## 未验证项
未做真实模型运行、未做人类双评审、未验证该补丁在完整仓库工具链下的全部回归测试（hidden-test 只覆盖本任务目标断言）；污染门槛未达标（见 task.json.contamination）。

## F4 整改记录（外部审查）
原 hidden-test 只对 `main.py` 源码做 `415: "UNSUPPORTED_MEDIA_TYPE"` 文本存在性检查；F4 整改改为直接以标准库 asyncio/json 驱动真实 ASGI 应用：404（未知 API 路由）、405（错误方法）、415（真实非 JSON Content-Type 的 `POST /api/diagnoses`）与兜底（测试注入 418 路由 → `HTTP_ERROR`）都断言状态码与响应体 `code`，并额外断言 415 的 handler 映射。
整改中发现原 reference.patch 只加错误码映射、应用没有任何真实路径会产生 415（非 JSON 请求先被 body 解析成 400/422），因此参考补丁补充了写入类 API 的 Content-Type 守卫（仍在 `allowedFiles: backend/app/main.py` 内，返回与 404/405 一致的错误体），需求点语义（415 → UNSUPPORTED_MEDIA_TYPE 统一错误体）不变、范围不变。

## C02 确定性整改（失败输出去除随机 requestId）

- **问题**：base 3 次运行的失败诊断原样打印错误响应体 `payload`（含随机 `requestId`），C02 归一化严格化后三次 stderr 不一致 → `consistent=false`。
- **整改（仅 hidden-test.sh）**：新增 `stable()` 辅助函数；断言失败时打印剔除 `requestId`/`request_id`、排序键后的确定性摘要。断言语义不变：仍断言 404/405/415/418 状态码与 `NOT_FOUND`/`METHOD_NOT_ALLOWED`/`UNSUPPORTED_MEDIA_TYPE`/`HTTP_ERROR` 错误码、`fieldErrors` 与 `requestId` 存在性；只有失败消息脱敏。
- **证据**：base 3 次 stderr 一致（sha256 前缀 `ca67c03a88e2cefc`），reference 3 次 stdout 一致（前缀 `c1265a602f5fd1d9`）；full-mode `ok:true`，base 3×`target-assertion-failed`、consistent，reference 3×0，`outside=[]`。
- **未改**：`issue.md`、`reference.patch`、`task.json`。
