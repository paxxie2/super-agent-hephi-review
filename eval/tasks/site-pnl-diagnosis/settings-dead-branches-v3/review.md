# 合法范围复核（变体任务卡，agent 辅助评审）

本卡是 **B5 边界增强 fixture 的变体卡**（需求点为全新设计，不是历史提交回放）：固定 base 是 site-pnl-diagnosis 本地 clone（`/Users/zm/dsh-instances/experiment/sources/site-pnl-diagnosis`）中真实存在的提交，`reference.patch` 是实现本卡新需求点的参考修复（由本次执行者编写并在 check-task 完整模式中验证），不是真实历史 commit 的 diff。

## 合法范围
合法范围仅限 `reference.patch` 改动的文件：`backend/app/settings.py`。`task.json.allowedFiles` 与补丁文件一一对应，check-task 完整模式的 `scope.outside=[]` 已确认没有越界改动。

## 需求点（与开发集已曝光需求点的区别）
开发集只是删除死分支。本变体在清理死分支之外改考**配置缺陷**：`SITE_PNL_ENV_FILE` 带首尾空白时原实现按原样传给 dotenv，路径不规范化导致加载失败；要求删除死分支并把该开关规范化为路径配置（strip；空/纯空白视为未设置，回退仓库根 `.env`），环境解析行为不变。清理对象同族但需求点（空白路径缺陷）是新的。

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

- 真实空白规范化：SITE_PNL_ENV_FILE='  <真实文件>  ' 时仍读取该文件（strip）
- 纯空白/空串：视为未设置，回退仓库根真实 .env
- 优先级：'\t<真实文件>\t' 与进程 env 同时存在时进程 env 优先；默认值不变
- AST 死分支删除断言降为辅助

### reference.patch

未修改（加强后 full-mode 在 base 失败 3/3、应用参考修复后通过 3/3，说明参考修复本身满足新行为断言）。

### 验证（full-mode，非 dry-run）

`node eval/check-task.mjs eval/tasks/site-pnl-diagnosis/settings-dead-branches-v3 --repo /Users/zm/dsh-instances/experiment/sources/site-pnl-diagnosis --json` → `ok: true`；base 退出码 `[1,1,1]`、失败分类三次均为 `target-assertion-failed`（有效 base 失败）；reference 退出码 `[0,0,0]`；scope.outside `[]`。原始 JSON 结果见同目录 `validation.json`。

### 边界（如实）

- 隐藏测试在 check-task 的临时 git worktree 中真跑（真实 SQLite/真实文件/真实 ASGI 直驱），但**不是**真实服务实例或真实 HTTP 网络调用。
- 仍无第二名独立人类评审；本文件不构成双人人类评审证据。
