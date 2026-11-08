#!/bin/sh
set -eu
python3 -B - <<'PY'
"""F14：真实 .env 文件的读取/优先级/回退行为（不再只靠 dotenv stub）。

AST 断言（from_env 无相同 body/orelse 的 if/else）保留为辅助；核心证明是真实文件行为。
"""
import ast
import importlib.util
import os
import pathlib
import sys
import tempfile

MANAGED = ("SITE_PNL_ENV_FILE", "SITE_PNL_HOST", "SITE_PNL_PORT")


def clear_managed():
    for key in MANAGED:
        os.environ.pop(key, None)


spec = importlib.util.spec_from_file_location("settings_f14_dev", "backend/app/settings.py")
module = importlib.util.module_from_spec(spec)
sys.modules["settings_f14_dev"] = module
spec.loader.exec_module(module)
repo_root = pathlib.Path(module.REPO_ROOT)
env_path = repo_root / ".env"
backup = env_path.read_text(encoding="utf-8") if env_path.exists() else None

try:
    with tempfile.TemporaryDirectory() as tmp:
        first = pathlib.Path(tmp, "first.env")
        first.write_text("SITE_PNL_HOST=10.1.1.1\nSITE_PNL_PORT=9101\n", encoding="utf-8")
        second = pathlib.Path(tmp, "second.env")
        second.write_text("SITE_PNL_HOST=10.2.2.2\nSITE_PNL_PORT=9202\n", encoding="utf-8")

        # 1) SITE_PNL_ENV_FILE 指向真实文件时，from_env 真实读取并生效。
        clear_managed()
        os.environ["SITE_PNL_ENV_FILE"] = str(first)
        settings = module.Settings.from_env()
        assert settings.host == "10.1.1.1" and settings.port == 9101, (settings.host, settings.port)

        # 2) 未设置 SITE_PNL_ENV_FILE 时回退到仓库根真实 .env。
        clear_managed()
        env_path.write_text("SITE_PNL_PORT=9199\n", encoding="utf-8")
        settings = module.Settings.from_env()
        assert settings.port == 9199 and settings.host == "127.0.0.1", (settings.host, settings.port)

        # 3) 已有进程环境变量优先于 .env（override=False）。
        clear_managed()
        os.environ["SITE_PNL_HOST"] = "env-wins"
        os.environ["SITE_PNL_ENV_FILE"] = str(first)
        settings = module.Settings.from_env()
        assert settings.host == "env-wins", settings.host

        # 4) 显式文件优先于仓库 .env（真实两个文件同时存在）。
        clear_managed()
        env_path.write_text("SITE_PNL_PORT=9999\n", encoding="utf-8")
        os.environ["SITE_PNL_ENV_FILE"] = str(second)
        settings = module.Settings.from_env()
        assert settings.port == 9202, settings.port

        # 5) 默认值不变。
        clear_managed()
        env_path.unlink()
        settings = module.Settings.from_env()
        assert settings.host == "127.0.0.1" and settings.port == 8000
        assert settings.db_path.name == "site_pnl.db"
finally:
    clear_managed()
    if backup is None:
        if env_path.exists():
            env_path.unlink()
    else:
        env_path.write_text(backup, encoding="utf-8")

# 辅助：死分支已删除（AST），真实行为断言已在上方完成。
src = pathlib.Path("backend/app/settings.py").read_text(encoding="utf-8")
tree = ast.parse(src)
cls = [node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "Settings"][0]
fn = [node for node in cls.body if isinstance(node, ast.FunctionDef) and node.name == "from_env"][0]
def norm(block):
    return ast.dump(ast.Module(body=block, type_ignores=[]))
assert not [node for node in ast.walk(fn) if isinstance(node, ast.If) and node.body and norm(node.body) == norm(node.orelse)]
print("PASS: dead branch removed and real .env loading/priority/fallback behaviour verified")
PY
