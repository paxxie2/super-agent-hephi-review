# backend-input-validation-v3

## 任务
统一错误码：HTTP 415 映射为 UNSUPPORTED_MEDIA_TYPE（与 404/405 一致的错误体）。写入类 API（`POST`/`PUT`/`PATCH` 且路径以 `/api/` 开头）在请求 `Content-Type` 不是 JSON 时返回该 415 错误体，使 415 成为可通过真实请求触发的行为，而不只是错误码表里的一行映射。

本卡是 B5 变体批次 3 新定义的**需求点变体**（非 G1/G2 已用需求点：不涉及 limit 默认值/上限、offset le=10000、health 服务标识字段、money 窗口辅助函数抽取、后端输入校验中文错误复用）。base `e00f338b098546adc40156dc15b4b6559e19835d` 是本地只读 site-pnl clone 中**真实存在的提交**；`reference.patch` 是按本需求点编写的**最小实现补丁**（不是历史提交 diff），任务卡不向 Worker 提供参考实现或隐藏测试内容。

## 验收
隐藏测试在固定 base 上必须连续失败 3 次（退出码非 0，且为目标断言失败或目标符号缺失），应用 `reference.patch` 后必须连续通过 3 次且 3 次输出一致；只使用仓库内已有工具链（Python 标准库 asyncio/json 直接驱动 ASGI 应用，无联网、无安装、无模型/宿主调用）。隐藏测试对 404/405/415/兜底分别发起真实 HTTP 请求并断言状态码与响应体 `code`。base 失败原因：base 上 415 要么没有映射、要么非 JSON Content-Type 请求不会返回 415，隐藏测试的目标断言直接失败。

## 合法范围
仅允许改动：`backend/app/main.py`。不得改动其他产品文件、运行配置、Skill 或阶段策略；不得删除或弱化既有测试，不得用 mock 替换真实路径。
