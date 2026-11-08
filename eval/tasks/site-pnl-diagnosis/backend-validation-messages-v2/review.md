# 任务范围复核（backend-validation-messages-v2）

状态：fixture 准备；正式实验与真实端到端未验证。

## 合法范围
参考补丁只新增 `backend/app/validation_i18n.py`，未改 `main.py`、`schemas.py`、既有 `validation_messages.py` 或其他产品文件、运行配置、Skill 或阶段策略。`task.json.allowedFiles` 与补丁改动文件一致。

## 基线与验证
base `e00f338b098546adc40156dc15b4b6559e19835d` 真实存在于本地 `site-pnl-diagnosis` clone。新需求点“双语文档化字段提示模块”与同族既有卡（`validation_messages.py` 的中文字段提示接入）不同：函数名、返回结构、覆盖类型集合均不同。
`node eval/check-task.mjs eval/tasks/site-pnl-diagnosis/backend-validation-messages-v2 --repo /Users/zm/dsh-instances/experiment/sources/site-pnl-diagnosis --json`：base 连续 3 次非零（目标模块缺失），参考补丁后连续 3 次通过且范围检查 `outside=[]`。完整模式结果见 `validation.json`。

## 未验证
未做真实模型运行、未做人类双评审、未跑全仓回归；隐藏测试只覆盖本卡目标行为。污染门槛未达标声明。
