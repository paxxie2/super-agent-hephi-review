# backend-validation-messages-v3

## 任务
新增纯函数模块 `backend/app/validation_summary.py`：`summarize_validation_errors(errors)` 把 FastAPI `RequestValidationError.errors()` 形状的错误字典列表压成稳定单行摘要。字段名去掉 `body` 前缀后按 `.` 连接、去重并按字典序排序；错误总数按条目计（重复字段重复计数）；无错误返回 `"0 validation errors"`；只有 `body` 位置的错误字段名记为 `body`；输入不是错误字典列表时抛 `TypeError`。仅标准库，不改既有 schemas/main 或业务口径。

这是为离线准备定义的新增模块任务，不声称来自历史 Issue 或历史提交。

## 验收
隐藏测试必须在固定真实 Git 基线上连续失败 3 次，应用参考补丁后连续通过 3 次。仅使用 Node/Python 标准库，无安装、网络、模型或宿主访问。基线失败必须是目标断言失败（base 上该模块尚不存在，import 即失败），而非依赖故障。

## 合法范围
仅新增 `backend/app/validation_summary.py`。不得改动其他产品文件、运行配置、Skill 或阶段策略。
