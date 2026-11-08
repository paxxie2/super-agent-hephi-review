# 合法范围复核（变体任务卡，agent 辅助评审）

本卡是 **B5 边界增强 fixture 的变体卡**（需求点为全新设计，不是历史提交回放）：固定 base 是 site-pnl-diagnosis 本地 clone（`/Users/zm/dsh-instances/experiment/sources/site-pnl-diagnosis`）中真实存在的提交，`reference.patch` 是实现本卡新需求点的参考修复（由本次执行者编写并在 check-task 完整模式中验证），不是真实历史 commit 的 diff。

## 合法范围
合法范围仅限 `reference.patch` 改动的文件：`backend/app/constants.py`, `backend/app/schemas.py`, `backend/app/main.py`。`task.json.allowedFiles` 与补丁文件一一对应，check-task 完整模式的 `scope.outside=[]` 已确认没有越界改动。

## 需求点（与开发集已曝光需求点的区别）
开发集 restore-health-service-id 在 Health 里直接写死字面量 `service="site-pnl-diagnosis"`。本变体改考**从共享常量注入固定 serviceId**（constants.SERVICE_ID 单一来源，schema 不写字面量），并保持 200/503 响应同一 payload 字段。字段名、来源与校验方式都与开发集不同。

## 已经实际执行（full-mode，非 dry-run）
`node eval/check-task.mjs <taskDir> --repo /Users/zm/dsh-instances/experiment/sources/site-pnl-diagnosis --json`：隐藏测试在 base 上连续 3 次非 0 退出（目标断言失败/目标模块缺失），应用 `reference.patch` 后连续 3 次 0 退出且输出一致，范围检查无越界。原始 JSON 结果与退出码见同目录 `validation.json`。

## 未验证项（如实）
- 评审者为 agent 辅助评审，**没有第二名独立人类评审**，本文件不构成双人人类评审证据。
- hidden test 只做源码/AST 级目标断言，不执行完整仓库工具链，也不证明全仓库回归通过。
- 污染门槛未达标（见 task.json.contamination）。
- 真实模型运行、宿主/实例路径未参与本卡校验。

## F14 整改（行为覆盖，2026-11-09）

原 hidden test 的核心证明不足（只查文件存在/callable/AST/注入 stub）。本次按 F14 要求加强为真实行为断言；AST/Stub/哈希断言只保留为辅助并在 hidden-test.sh 中注明。

### 加强后的核心行为断言

- 运行时证明：先注入 constants.SERVICE_ID='runtime-injected-service-id-f14' 再导入 app.main；真实 ASGI 200/503 的 payload.serviceId 都等于注入值
- schemas.py 不含 serviceId 字面量（辅助），main.py 使用 serviceId=SERVICE_ID 构造 Health（辅助）
- 真实 503：目录当数据库文件时返回 503 且仍带注入的 serviceId

### reference.patch

未修改（加强后 full-mode 在 base 失败 3/3、应用参考修复后通过 3/3，说明参考修复本身满足新行为断言）。

### 验证（full-mode，非 dry-run）

`node eval/check-task.mjs eval/tasks/site-pnl-diagnosis/restore-health-service-id-v2 --repo /Users/zm/dsh-instances/experiment/sources/site-pnl-diagnosis --json` → `ok: true`；base 退出码 `[1,1,1]`、失败分类三次均为 `target-assertion-failed`（有效 base 失败）；reference 退出码 `[0,0,0]`；scope.outside `[]`。原始 JSON 结果见同目录 `validation.json`。

### 边界（如实）

- 隐藏测试在 check-task 的临时 git worktree 中真跑（真实 SQLite/真实文件/真实 ASGI 直驱），但**不是**真实服务实例或真实 HTTP 网络调用。
- 仍无第二名独立人类评审；本文件不构成双人人类评审证据。
