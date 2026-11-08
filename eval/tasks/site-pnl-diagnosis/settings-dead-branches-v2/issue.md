# settings-dead-branches-v2

## 任务
重构 `backend/app/settings.py`：`Settings.from_env` 中 body 与 orelse 完全相同的 if/else 是死分支，删除它；删除策略是把 dotenv 入口收敛为一个参数化函数 `_read_dotenv(env_file: str | None = None)`：显式传入的文件优先加载，缺省时仍读取 `SITE_PNL_ENV_FILE`，随后加载仓库根 `.env`（不覆盖已有环境变量）。`from_env` 无条件调用该入口一次。环境变量解析、默认值与脱敏视图等行为保持不变。

变体卡说明：固定 base `8d2ec5858ed3071eae598e5afb30b069807ce598` 是本地 site-pnl-diagnosis clone 中真实存在的历史提交（`git cat-file -t` 为 commit）；本卡需求点是全新设计的变体（参数化 dotenv 入口的删除策略），不是历史提交回放，`reference.patch` 为实现该需求点的参考修复。

## 验收
隐藏测试在固定 base 上必须连续失败 3 次（退出码非 0，且为目标断言失败或目标模块缺失），应用 `reference.patch` 后必须连续通过 3 次且输出一致；只使用仓库内已有工具链与 Node/Python 标准库（无联网、无安装、无模型/宿主调用）。base 失败原因：base 的 `from_env` 仍含 body/orelse 完全相同的 if/else（AST 断言失败），且 `_read_dotenv` 没有 `env_file` 参数。

## 合法范围
仅允许改动：`backend/app/settings.py`。不得改动其他产品文件、运行配置、Skill 或阶段策略；不得删除或弱化既有测试，不得用 mock 替换真实路径。
