# money-window-helpers

## 任务
重构 `backend/app/domain/money.py`：把日期窗口解析与含首尾天数计算提取为模块内私有辅助函数，并在 `date_range` / `previous_window` 中复用，算术与返回值等价（行为保持）；同时为倒序窗口、跨年、闰日补 characterization 断言。不得改变公开签名、返回值与 ValueError 行为。

本任务来自本地仓库真实历史提交 `9a8617900471083cd89c60443b5cfcbd90788cc2`（base=`8d2ec5858ed3071eae598e5afb30b069807ce598`，即其父提交）；参考修复 `reference.patch` 为该提交上述文件的 `git diff`，不是人工编造的测试夹具。任务卡不向 Worker 提供参考实现或隐藏测试内容。

## 验收
隐藏测试在固定 base 上必须连续失败 3 次（退出码非 0，且为目标断言失败或目标模块缺失），应用 `reference.patch` 后必须连续通过 3 次且 3 次输出一致；只使用仓库内已有工具链（无联网、无安装、无模型/宿主调用）。base 失败原因：base 的 money.py 没有 `_parse_window` / `_window_day_count` 辅助函数，隐藏测试的结构断言失败（公开行为本身在 base 与参考修复上一致）。

## 合法范围
仅允许改动：`backend/app/domain/money.py`, `backend/tests/test_money.py`。不得改动其他产品文件、运行配置、Skill 或阶段策略；不得删除或弱化既有测试，不得用 mock 替换真实路径。

```hephi-task
{
  "version": 1,
  "goal": "money-window-helpers: money-window-helpers",
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
        "backend/app/domain/money.py",
        "backend/tests/test_money.py"
      ]
    }
  ]
}
```

