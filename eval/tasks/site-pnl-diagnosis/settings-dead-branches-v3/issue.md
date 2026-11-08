# settings-dead-branches-v3

## 任务
修复 `backend/app/settings.py` 的配置缺陷并清理死分支：`Settings.from_env` 中 body 与 orelse 完全相同的 if/else 是死分支，删除它；同时 `SITE_PNL_ENV_FILE` 语义应为路径配置——去除首尾空白，空或纯空白视为未设置并回退到仓库根 `.env`。既有环境变量解析、默认值与脱敏视图行为不变。

变体卡说明：固定 base `8d2ec5858ed3071eae598e5afb30b069807ce598` 是本地 site-pnl-diagnosis clone 中真实存在的历史提交（`git cat-file -t` 为 commit）；本卡需求点是全新设计的变体（死分支清理 + env 文件路径规范化缺陷），不是历史提交回放，`reference.patch` 为实现该需求点的参考修复。

## 验收
隐藏测试在固定 base 上必须连续失败 3 次（退出码非 0，且为目标断言失败或目标模块缺失），应用 `reference.patch` 后必须连续通过 3 次且输出一致；只使用仓库内已有工具链与 Node/Python 标准库（无联网、无安装、无模型/宿主调用）。base 失败原因：base 的 `from_env` 仍含 body/orelse 完全相同的 if/else（AST 断言失败），且带空白的 `SITE_PNL_ENV_FILE` 会原样传给 dotenv（路径断言失败）。

## 合法范围
仅允许改动：`backend/app/settings.py`。不得改动其他产品文件、运行配置、Skill 或阶段策略；不得删除或弱化既有测试，不得用 mock 替换真实路径。
