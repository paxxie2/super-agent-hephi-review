# 任务范围复核（previous-window-order-v2）

状态：fixture 准备；正式实验与真实端到端未验证。

## 合法范围
仅 `backend/app/domain/money.py`；参考补丁只在该文件追加 `previous_windows`，未改既有函数或其他产品文件、运行配置、Skill 或阶段策略。`task.json.allowedFiles` 与补丁改动文件一致。

## 基线与验证
base `1e166fbe2217ac378e5bb7062cd34a2da1e75e6f` 真实存在于本地 `site-pnl-diagnosis` clone；新需求点为“连续前序等长窗口序列”，与同族既有卡（单个 previous_window 的倒序 ValueError）不重复。
`node eval/check-task.mjs eval/tasks/site-pnl-diagnosis/previous-window-order-v2 --repo /Users/zm/dsh-instances/experiment/sources/site-pnl-diagnosis --json`：base 连续 3 次非零（目标属性缺失），参考补丁后连续 3 次通过且范围检查 `outside=[]`。完整模式结果见 `validation.json`。

## 未验证
未做真实模型运行、未做人类双评审、未跑全仓回归；隐藏测试只覆盖本卡目标行为。污染门槛未达标声明。
