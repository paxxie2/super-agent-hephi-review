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

- **原缺口**：hidden-test 只查同步函数装饰器与返回字面量，未验证路由真实 200、是否间接访问 DB，且会误拒合法的 `async def` 实现。
- **现行为覆盖**：用标准库 `asyncio` 的 ASGI 直驱真实请求：
  1. 计数 stub 包住 `app.main.db_status` 与 `app.db.connect`（明确标注为测试 stub）；
  2. 对照调用 `GET /api/health` → 计数增加，证明 stub 能观测真实 DB 访问；
  3. 清零后调用 `GET /api/health/live` → 断言 **200**、`{"status":"ok"}`，且两个计数均为 **0**（零 DB 访问）；
  4. ASGI 驱动对 `async def` 路由同样 `await`，合法的 async 实现不会被误拒；不依赖装饰器写法/函数名。
- **reference.patch 改动**：无。
- **full-mode 结果**：`ok:true`；base 3/3 失败（`(404, {"code":"NOT_FOUND"...})`，即端点不存在），reference 3/3 通过；`outside=[]`。
- **限制**：stub 仅用于观测 DB 调用次数并在代码中注明；AST 已移除；未启动真实宿主/实例。
- **校验分类（F15 后的 check-task）**：base 3/3 均为 `target-assertion-failed`（非 environment-error），3 次 `normalizedSha256` 相同；reference 3/3 `codes=[0,0,0]` 且输出一致。
