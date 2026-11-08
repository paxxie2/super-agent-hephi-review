# restore-health-service-id-v3

## 任务
修复健康检查缺少结构化服务描述的问题：本变体要求 `/api/health` 返回结构化服务描述 `service: {id, version}` —— 在 `backend/app/schemas.py` 新增 `ServiceInfo(id, version)` 模型，`Health` 增加 `service: ServiceInfo` 字段；`id` 取自共享常量 `backend/app/constants.py` 的 `SERVICE_ID`，`version` 取自既有 `APP_VERSION`；200 与 503 都返回同一 payload。既有字段与状态码语义不变。

变体卡说明：固定 base `e00f338b098546adc40156dc15b4b6559e19835d` 是本地 site-pnl-diagnosis clone 中真实存在的历史提交（`git cat-file -t` 为 commit）；本卡需求点是全新设计的变体（结构化 service 描述对象），不是历史提交回放，`reference.patch` 为实现该需求点的参考修复。

## 验收
隐藏测试在固定 base 上必须连续失败 3 次（退出码非 0，且为目标断言失败或目标模块缺失），应用 `reference.patch` 后必须连续通过 3 次且输出一致；只使用仓库内已有工具链与 Node/Python 标准库（无联网、无安装、无模型/宿主调用）。base 失败原因：base 没有 `ServiceInfo` 模型、`constants.py` 没有 `SERVICE_ID`、`Health` 没有 `service` 字段，隐藏测试的模型/字段断言失败。

## 合法范围
仅允许改动：`backend/app/constants.py`, `backend/app/schemas.py`, `backend/app/main.py`。不得改动其他产品文件、运行配置、Skill 或阶段策略；不得删除或弱化既有测试，不得用 mock 替换真实路径。
