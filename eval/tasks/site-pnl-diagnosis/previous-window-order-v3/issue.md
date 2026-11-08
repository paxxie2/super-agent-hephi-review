# previous-window-order-v3

## 任务
在 `backend/app/domain/money.py` 新增两个纯函数：`window_length_days(start, end)` 返回窗口内自然日数量（含首尾，倒序窗口抛 `ValueError`）；`windows_adjacent(left, right)` 判断 `right` 窗口是否紧邻 `left` 之后（右首日 = 左末日 + 1 天），参数不是两元素元组时抛 `TypeError`、任一窗口倒序时抛 `ValueError`。不得改变既有函数行为。

这是为离线准备定义的边界增强任务，不声称原设计已有这些函数，也不声称来自历史 Issue。

## 验收
隐藏测试必须在固定真实 Git 基线上连续失败 3 次，应用参考补丁后连续通过 3 次。仅使用 Node/Python 标准库，无安装、网络、模型或宿主访问。基线失败必须是目标断言失败（base 上函数不存在，取属性即失败），而非导入或依赖故障。

## 合法范围
仅 `backend/app/domain/money.py`。不得改变其他产品文件、运行配置、Skill 或阶段策略。
