# restore-data-package-v2

## 任务
修复基线可运行性缺陷：干净 checkout 缺少播种源码 `backend/app/data/seed.py`（`app.data` 包不存在），无法在空库播种；同时根 `.gitignore` 用宽 `data/` 与全局 `*.db` 规则，会误伤源码包并掩盖真正的运行期数据库范围。本变体要求：**只恢复播种路径**（`backend/app/data/__init__.py` + `seed.py`，不改 loader），并把忽略规则收窄为仓库根运行期数据库文件（`/data/*.db`、`/data/*.db-wal`、`/data/*.db-shm`），移除宽 `data/` 与全局 `*.db` 规则。

变体卡说明：固定 base `e00f338b098546adc40156dc15b4b6559e19835d` 是本地 site-pnl-diagnosis clone 中真实存在的历史提交（`git cat-file -t` 为 commit）；本卡需求点是全新设计的变体（只恢复 seed + 精确忽略规则），不是历史提交回放，`reference.patch` 为实现该需求点的参考修复。

## 验收
隐藏测试在固定 base 上必须连续失败 3 次（退出码非 0，且为目标断言失败或目标模块缺失），应用 `reference.patch` 后必须连续通过 3 次且输出一致；只使用仓库内已有工具链与 Node/Python 标准库（无联网、无安装、无模型/宿主调用）。base 失败原因：base 无 `backend/app/data/seed.py`（文件缺失/import 失败），且 `.gitignore` 仍是宽规则。

## 合法范围
仅允许改动：`.gitignore`, `backend/app/data/__init__.py`, `backend/app/data/seed.py`。不得改动其他产品文件、运行配置、Skill 或阶段策略；不得删除或弱化既有测试，不得用 mock 替换真实路径。
