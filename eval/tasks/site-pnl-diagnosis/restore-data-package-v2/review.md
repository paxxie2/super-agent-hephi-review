# 合法范围复核（变体任务卡，agent 辅助评审）

本卡是 **B5 边界增强 fixture 的变体卡**（需求点为全新设计，不是历史提交回放）：固定 base 是 site-pnl-diagnosis 本地 clone（`/Users/zm/dsh-instances/experiment/sources/site-pnl-diagnosis`）中真实存在的提交，`reference.patch` 是实现本卡新需求点的参考修复（由本次执行者编写并在 check-task 完整模式中验证），不是真实历史 commit 的 diff。

## 合法范围
合法范围仅限 `reference.patch` 改动的文件：`.gitignore`, `backend/app/data/__init__.py`, `backend/app/data/seed.py`。`task.json.allowedFiles` 与补丁文件一一对应，check-task 完整模式的 `scope.outside=[]` 已确认没有越界改动。

## 需求点（与开发集已曝光需求点的区别）
开发集 restore-data-package 只考“恢复完整 data 源码包 + 把 data/ 收窄为 /data/”。本变体改考**只恢复播种路径**（seed）并用**精确运行期数据库文件规则**（/data/*.db* 替代全局 *.db 与宽 data/ 目录规则），恢复路径与清理策略都与开发集不同。

## 已经实际执行（full-mode，非 dry-run）
`node eval/check-task.mjs <taskDir> --repo /Users/zm/dsh-instances/experiment/sources/site-pnl-diagnosis --json`：隐藏测试在 base 上连续 3 次非 0 退出（目标断言失败/目标模块缺失），应用 `reference.patch` 后连续 3 次 0 退出且输出一致，范围检查无越界。原始 JSON 结果与退出码见同目录 `validation.json`。

## 未验证项（如实）
- 评审者为 agent 辅助评审，**没有第二名独立人类评审**，本文件不构成双人人类评审证据。
- hidden test 只做源码/AST 级目标断言，不执行完整仓库工具链，也不证明全仓库回归通过。
- 污染门槛未达标（见 task.json.contamination）。
- 真实模型运行、宿主/实例路径未参与本卡校验。

## F4 整改记录（外部审查）
原 hidden-test 只做静态/桩断言（文件存在与 callable、AST/SQL 字符串计数、dotenv 模块 stub）。F4 整改改为真实行为断言：真实临时 SQLite + 真实服务/播种函数调用、真实临时 git 仓库的 `git check-ignore`、真实临时 `.env` 文件；断言覆盖参数化读取、优先级、缺省回退与幂等。需求点语义与 allowedFiles 未变，reference.patch 未改动。
