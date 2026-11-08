# backend-input-validation

## 任务
跨模块完善测算后端输入校验：`main.py` 的 `RequestValidationError` 处理器、`schemas.py` 字段校验、`services/scenarios.py` 与 `services/chat.py` 的手工请求构造统一复用 `validation_messages.chinese_field_errors`，非法输入返回 400 字段级中文错误且不写测算记录、不改变源数据。

本任务来自本地仓库真实历史提交 `418af9a671c30cc6e7ceaea70f53be47335c8b88`（base=`e00f338b098546adc40156dc15b4b6559e19835d`，即其父提交）；参考修复 `reference.patch` 为该提交上述文件的 `git diff`，不是人工编造的测试夹具。任务卡不向 Worker 提供参考实现或隐藏测试内容。

## 验收
隐藏测试在固定 base 上必须连续失败 3 次（退出码非 0，且为目标断言失败或目标模块缺失），应用 `reference.patch` 后必须连续通过 3 次且 3 次输出一致；只使用仓库内已有工具链（无联网、无安装、无模型/宿主调用）。base 失败原因：base 上 `backend/app/validation_messages.py` 尚不存在，隐藏测试 import 即失败（目标模块缺失）。

## 合法范围
仅允许改动：`backend/app/main.py`, `backend/app/schemas.py`, `backend/app/services/chat.py`, `backend/app/services/scenarios.py`, `backend/app/validation_messages.py`, `backend/tests/test_scenario_schema_validation.py`。不得改动其他产品文件、运行配置、Skill 或阶段策略；不得删除或弱化既有测试，不得用 mock 替换真实路径。

```hephi-task
{
  "version": 1,
  "goal": "backend-input-validation: backend-input-validation",
  "outOfScope": [
    "不得修改合法范围之外的文件",
    "不得合并 PR，失败如实报告 blocked"
  ],
  "acceptance": [
    {
      "id": "AC1",
      "text": "任务隐藏测试通过；改动仅落在 task.json 的 allowedFiles 内。",
      "check": "project-regression",
      "paths": [
        "backend/app/main.py",
        "backend/app/schemas.py",
        "backend/app/services/chat.py",
        "backend/app/services/scenarios.py",
        "backend/app/validation_messages.py",
        "backend/tests/test_scenario_schema_validation.py"
      ]
    }
  ]
}
```

