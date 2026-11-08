# backend-validation-messages-v2

## 任务
新增纯函数模块 `backend/app/validation_i18n.py`：`bilingual_field_errors(errors)` 消费 FastAPI `RequestValidationError.errors()` 形状的错误字典列表，返回 `{字段: {"zh": 中文提示, "en": 英文提示}}`。支持 missing、int_type/int_parsing、float_finite/finite_number、greater_than_equal（带 `ctx.ge`）、less_than_equal（带 `ctx.le`）、extra_forbidden、literal_error（带 `ctx.expected`）；未知类型回退为中文“参数不合法” + 原始英文 msg；同一字段出现多次时保留第一次的错误。仅标准库，不改既有 schemas/main 或金额公式。

这是为离线准备定义的新增模块任务，不声称来自历史 Issue 或历史提交。

## 验收
隐藏测试必须在固定真实 Git 基线上连续失败 3 次，应用参考补丁后连续通过 3 次。仅使用 Node/Python 标准库，无安装、网络、模型或宿主访问。基线失败必须是目标断言失败（base 上该模块尚不存在，import 即失败），而非依赖故障。

## 合法范围
仅新增 `backend/app/validation_i18n.py`。不得改动其他产品文件、运行配置、Skill 或阶段策略。
