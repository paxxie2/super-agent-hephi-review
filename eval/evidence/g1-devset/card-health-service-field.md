# health-service-field

## 任务
新增健康响应的固定服务标识：`Health` schema 增加 `service: Literal["site-pnl-diagnosis"] = "site-pnl-diagnosis"`，200 与数据库不可用的 503 响应都序列化该字段；既有七个字段与状态码语义不变，并在 README 记录该固定标识与测试边界。

本任务来自本地仓库真实历史提交 `c062e790e55da09d007a0570bc5a797a6562e159`（base=`e00f338b098546adc40156dc15b4b6559e19835d`，即其父提交）；参考修复 `reference.patch` 为该提交上述文件的 `git diff`，不是人工编造的测试夹具。任务卡不向 Worker 提供参考实现或隐藏测试内容。

## 验收
隐藏测试在固定 base 上必须连续失败 3 次（退出码非 0，且为目标断言失败或目标模块缺失），应用 `reference.patch` 后必须连续通过 3 次且 3 次输出一致；只使用仓库内已有工具链（无联网、无安装、无模型/宿主调用）。base 失败原因：base 的 `Health` schema 没有 `service` 字段，隐藏测试的 AST 断言失败。

## 合法范围
仅允许改动：`README.md`, `backend/app/schemas.py`, `backend/tests/test_health_service.py`。不得改动其他产品文件、运行配置、Skill 或阶段策略；不得删除或弱化既有测试，不得用 mock 替换真实路径。

```hephi-task
{
  "version": 1,
  "goal": "health-service-field: health-service-field",
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
        "README.md",
        "backend/app/schemas.py",
        "backend/tests/test_health_service.py"
      ]
    }
  ]
}
```

