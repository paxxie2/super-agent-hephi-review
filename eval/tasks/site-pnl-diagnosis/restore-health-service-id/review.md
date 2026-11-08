# 合法范围复核（agent 辅助评审）

本任务由 B2 执行者（agent 辅助）从本地真实仓库历史提交 `ab7c8e03b6938df9fc52d486477402db313ae1ca`（`fix: restore data sources and expose fixed health service id`）派生：
固定 base `e00f338b098546adc40156dc15b4b6559e19835d` 为该提交的父提交，`reference.patch` 是该提交对这些文件的真实 `git diff`。

## 合法范围
合法范围仅限 `reference.patch` 中的文件：`.gitignore`, `README.md`, `backend/app/data/__init__.py`, `backend/app/data/loader.py`, `backend/app/data/seed.py`, `backend/app/schemas.py`, `backend/tests/test_health_service.py`。没有加入任何额外的无关修改；`task.json.allowedFiles` 与补丁文件一一对应，full-mode 的 `allowed-scope` 检查确认 `outside=[]`。

## 评审者说明（如实）
**评审者为 agent 辅助评审，非两名人类评审。** 本轮没有第二独立人类复核者、没有评审者签名或裁决记录；本文件不能作为双人人类评审证据。

## 已经实际执行（full-mode，非 dry-run）
`node eval/check-task.mjs <taskDir> --repo <本机仓库> --repeats 3 --json`：base 隐藏测试退出码非 0（目标断言/模块缺失，见 `eval/B2-audit.md` 中记录的 exit code 与 outputSha256），应用 `reference.patch` 后 3/3 通过且 3 次输出一致，范围检查无越界。原始 JSON 由执行者保存在本地临时证据目录，未伪造。

## 未验证项
未做真实模型运行、未做人类双评审、未验证该提交在完整仓库工具链下的全部回归测试（hidden-test 只覆盖本任务目标断言）；污染门槛未达标（见 task.json.contamination）。

## F14 整改（行为覆盖，2026-11-09）

原 hidden test 的核心证明不足（只查文件存在/callable/AST/注入 stub）。本次按 F14 要求加强为真实行为断言；AST/Stub/哈希断言只保留为辅助并在 hidden-test.sh 中注明。

### 加强后的核心行为断言

- 字节一致：恢复的 data 包三个文件 SHA256 与真实历史实现一致（辅助）
- 真实数据行为：seed_database + load_sites(10 站点) + load_site_data('S01') 有真实源记录
- 真实 health 200：ASGI 直驱 /api/health（临时 SQLite）→ 200，payload service='site-pnl-diagnosis'、status/db=ok、seeded=true、dataVersion 非空
- 真实 health 503：数据库不可读时 → 503，同一 Health 结构含 service、status/db=error、detail 非空

### reference.patch

未修改（加强后 full-mode 在 base 失败 3/3、应用参考修复后通过 3/3，说明参考修复本身满足新行为断言）。

### 验证（full-mode，非 dry-run）

`node eval/check-task.mjs eval/tasks/site-pnl-diagnosis/restore-health-service-id --repo /Users/zm/dsh-instances/experiment/sources/site-pnl-diagnosis --json` → `ok: true`；base 退出码 `[1,1,1]`、失败分类三次均为 `target-assertion-failed`（有效 base 失败）；reference 退出码 `[0,0,0]`；scope.outside `[]`。原始 JSON 结果见同目录 `validation.json`。

### 边界（如实）

- 隐藏测试在 check-task 的临时 git worktree 中真跑（真实 SQLite/真实文件/真实 ASGI 直驱），但**不是**真实服务实例或真实 HTTP 网络调用。
- 仍无第二名独立人类评审；本文件不构成双人人类评审证据。
