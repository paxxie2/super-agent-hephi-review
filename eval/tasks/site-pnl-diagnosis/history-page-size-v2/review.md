# 合法范围复核（agent 辅助评审）

本卡为 B5 变体批次 3 的新需求点变体，由执行 Agent（agent 辅助）按批次要求定义，**不是**从某条历史提交派生：`reference.patch` 是针对需求点编写的最小实现补丁，`base bd816e9eb019b0520b98dbc1bd53bdf0c85010d4` 为本地只读 site-pnl clone 中真实存在的提交（不属于本卡补丁）。

## 合法范围
合法范围仅限 `reference.patch` 中的文件：`backend/app/schemas.py`、`backend/app/services/diagnoses.py`。没有加入任何额外的无关修改；`task.json.allowedFiles` 与补丁文件一一对应，full-mode 的 `allowed-scope` 检查确认 `outside=[]`。

## 评审者说明（如实）
**评审者为 agent 辅助评审，非两名人类评审。** 本轮没有第二独立人类复核者、没有评审者签名或裁决记录；本文件不能作为双人人类评审证据。本卡是**新定义需求点**，不是历史故障宣称，也不是已准入的正式样本。

## 已经实际执行（full-mode）
`node eval/check-task.mjs <taskDir> --repo <本机 site-pnl-diagnosis clone> --repeats 3 --json`：base 隐藏测试连续 3 次退出码非 0，应用 `reference.patch` 后连续 3 次通过且输出一致，范围检查无越界。原始报告保存在本目录 `validation.json`（由同一次 full-mode 运行生成），未伪造。

## 未验证项
未做真实模型运行、未做人类双评审、未验证该补丁在完整仓库工具链下的全部回归测试（hidden-test 只覆盖本任务目标断言）；污染门槛未达标（见 task.json.contamination）。


## F14 整改（Stream D2，外部审查）

- **原缺口**：hidden-test 只做 AST/正则（要求特定 `has_more` 写法），未验证 HTTP 响应中 `hasMore` 在末页/空页/offset 推移下的行为，也会误拒等价实现。
- **现行为覆盖**：真实临时 SQLite（`init_db` + 插入 3 条 diagnosis，临时目录）上，用标准库 `asyncio` 的 ASGI 直驱 `GET /api/diagnoses`：
  - `limit=2,offset=0` → `hasMore=true`；`offset=2`（末页剩 1 条）→ `false`；`offset=3/4`（空页/越界）→ `false`；`limit=3,offset=0`（一次取完）→ `false`；`offset=1` 推移后 → 按实际条数正确；
  - 每个响应都按中性不变量断言 `hasMore == (offset + len(items) < total)`，不绑定实现写法；等价实现可通过对 DB/路由/服务/序列化的真实链路。
- **reference.patch 改动**：无。
- **full-mode 结果**：`ok:true`；base 3/3 失败（`response must expose hasMore, got keys ['items','limit','offset','total']`），reference 3/3 通过；`outside=[]`。
- **限制**：使用临时 DB 夹具（已注明），未启动真实宿主；AST/正则已移除。
- **校验分类（F15 后的 check-task）**：base 3/3 均为 `target-assertion-failed`（非 environment-error），3 次 `normalizedSha256` 相同；reference 3/3 `codes=[0,0,0]` 且输出一致。
