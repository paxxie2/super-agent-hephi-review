# previous-window-order-v2

## 任务
在 `backend/app/domain/money.py` 新增 `previous_windows(start, end, count)`：从当前自然日窗口向前连续返回 `count` 个紧邻的等长窗口（含首尾），结果按时间从早到晚排序。窗口倒序（`start` 晚于 `end`）、`count < 1` 或 `count` 不是整数（含布尔值）时抛 `ValueError`。不得改变 `previous_window`、`date_range` 等既有函数的行为。

这是为离线准备定义的边界增强任务，不声称原设计已有该函数，也不声称来自历史 Issue。

## 验收
隐藏测试必须在固定真实 Git 基线上连续失败 3 次，应用参考补丁后连续通过 3 次。仅使用 Node/Python 标准库，无安装、网络、模型或宿主访问。基线失败必须是目标断言失败（base 上 `previous_windows` 尚不存在，import 后取属性即失败），而非导入或依赖故障。

## 合法范围
仅 `backend/app/domain/money.py`。不得改变其他产品文件、运行配置、Skill 或阶段策略。
