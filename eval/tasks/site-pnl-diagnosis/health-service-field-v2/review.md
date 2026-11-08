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


## F14 整改（Stream D2，外部审查）

- **原缺口**：hidden-test 只查固定字符串/日志调用形状，未验证 DB 故障时真实 503 响应是否泄漏内部错误文本。
- **现行为覆盖**：用标准库 `asyncio` 的 ASGI 直驱真实请求（临时目录；无 mock/无外部服务）：
  1. 构造真实 SQLite 故障（DB 父路径是普通文件）→ `GET /api/health` 必须返回 **503**，`status="error"`、`db="error"`；
  2. 取得真实内部错误文本 `db_status(...)["error"]`，断言它**不出现在**响应体中，且 `detail` 是非空字符串（不指定唯一文案，等价实现可通过）；
  3. 健康 DB 时 `GET /api/health` 返回 **200**，原有字段语义保持。
  请求路径/响应均为真实进程内 HTTP ASGI 调用；只有 app 与临时 DB 是本地测试夹具，已在代码中注明。
- **reference.patch 改动**：无（现有补丁已满足行为；未改语义）。
- **full-mode 结果**：`ok:true`；base 3/3 失败（`503 must not leak the internal DB error text: "数据库不可访问: [Errno 20] Not a directory: ..."`，即 base 泄漏内部文本），reference 3/3 通过；`outside=[]`。
- **限制**：AST 已移除；未启动真实宿主/实例、未做真实模型运行。
- **校验分类（F15 后的 check-task）**：base 3/3 均为 `target-assertion-failed`（非 environment-error），3 次 `normalizedSha256` 相同；reference 3/3 `codes=[0,0,0]` 且输出一致。

## R7b 整改（第九轮外部审查，2026-11-09）

- **原问题**：本卡 hidden-test 第 93 行附近只断言 `detail` 为非空字符串且不泄漏内部错误；`issue.md` 要求 503 的 detail **固定为 `database unavailable`**。其他非空错误文本也能通过，属于断言减弱（R7b）。
- **整改**：`hidden-test.sh` 恢复固定值断言 `detail == "database unavailable"`，同时**保留**原有“内部 DB 错误文本不得出现在响应体”的不泄漏断言；未修改 `issue.md`、`reference.patch`（需求与参考实现不变）。
- **重跑**：`node eval/check-task.mjs <本卡> --repo /Users/zm/dsh-instances/experiment/sources/site-pnl-diagnosis --json` → `ok:true`；base 3/3 `target-assertion-failed`（base 503 泄漏内部错误文本，被“不泄漏”断言拦下，退出码 1×3），reference 3/3 通过（输出 `PASS: 503 detail is fixed 'database unavailable' ...`），scope `outside=[]`。
- `validation.json` 已用上述 full-mode 运行结果覆盖（同一次运行生成，非手写）。
