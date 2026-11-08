# restore-data-package-v3

## 任务
修复基线可运行性缺陷：干净 checkout 缺少只读加载源码 `backend/app/data/loader.py`（`app.data` 包不存在），诊断无法读取源数据；同时根 `.gitignore` 的宽 `data/` 规则会把源码包一并忽略。本变体要求：**只恢复只读加载路径**（`backend/app/data/__init__.py` + `loader.py`，不恢复 seed），采用**否定规则**保留运行期 `data/` 宽忽略，同时用 `!/backend/app/data/` 与 `!/backend/app/data/**/*.py` 重新纳入源码包；并保留 loader 的两条错误/缺失分支：`get_site_info` 对未知点位返回 `None`、`load_site_data` 对未知点位抛 `ValueError`。

变体卡说明：固定 base `e00f338b098546adc40156dc15b4b6559e19835d` 是本地 site-pnl-diagnosis clone 中真实存在的历史提交（`git cat-file -t` 为 commit）；本卡需求点是全新设计的变体（loader-only + 否定规则忽略策略），不是历史提交回放，`reference.patch` 为实现该需求点的参考修复。

## 验收
隐藏测试在固定 base 上必须连续失败 3 次（退出码非 0，且为目标断言失败或目标模块缺失），应用 `reference.patch` 后必须连续通过 3 次且输出一致；只使用仓库内已有工具链与 Node/Python 标准库（无联网、无安装、无模型/宿主调用）。base 失败原因：base 无 `backend/app/data/loader.py`（文件缺失/import 失败），且 `.gitignore` 没有源码包否定规则。

## 合法范围
仅允许改动：`.gitignore`, `backend/app/data/__init__.py`, `backend/app/data/loader.py`。不得改动其他产品文件、运行配置、Skill 或阶段策略；不得删除或弱化既有测试，不得用 mock 替换真实路径。
