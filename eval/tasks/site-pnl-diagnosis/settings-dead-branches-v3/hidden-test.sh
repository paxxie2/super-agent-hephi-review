#!/bin/sh
set -eu
python3 -B - <<'PY'
"""F14：真实 .env 文件行为 + SITE_PNL_ENV_FILE 空白路径规范化（不再只靠 stub）。

AST 断言（死分支删除）保留为辅助；核心证明是真实文件读取行为。
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


spec = importlib.util.spec_from_file_location("settings_f14_v3", "backend/app/settings.py")
module = importlib.util.module_from_spec(spec)
sys.modules["settings_f14_v3"] = module
spec.loader.exec_module(module)
repo_root = pathlib.Path(module.REPO_ROOT)
env_path = repo_root / ".env"
backup = env_path.read_text(encoding="utf-8") if env_path.exists() else None

try:
    with tempfile.TemporaryDirectory() as tmp:
        explicit = pathlib.Path(tmp, "explicit.env")
        explicit.write_text("SITE_PNL_HOST=10.3.3.3\nSITE_PNL_PORT=9303\n", encoding="utf-8")

        # 1) SITE_PNL_ENV_FILE 带首尾空白：真实文件仍必须被读取（路径规范化）。
        clear_managed()
        os.environ["SITE_PNL_ENV_FILE"] = f"  {explicit}  "
        settings = module.Settings.from_env()
        assert settings.host == "10.3.3.3" and settings.port == 9303, (settings.host, settings.port)

        # 2) 纯空白：视为未设置，回退仓库根真实 .env。
        clear_managed()
        env_path.write_text("SITE_PNL_PORT=9393\n", encoding="utf-8")
        os.environ["SITE_PNL_ENV_FILE"] = "   "
        settings = module.Settings.from_env()
        assert settings.port == 9393 and settings.host == "127.0.0.1", (settings.host, settings.port)

        # 3) 空字符串同样回退。
        clear_managed()
        os.environ["SITE_PNL_ENV_FILE"] = ""
        settings = module.Settings.from_env()
        assert settings.port == 9393, settings.port

        # 4) 已有进程环境变量优先于 .env。
        clear_managed()
        os.environ["SITE_PNL_HOST"] = "env-wins"
        os.environ["SITE_PNL_ENV_FILE"] = f"\t{explicit}\t"
        settings = module.Settings.from_env()
        assert settings.host == "env-wins", settings.host

        # 5) 默认值不变。
        clear_managed()
        env_path.unlink()
        settings = module.Settings.from_env()
        assert settings.host == "127.0.0.1" and settings.port == 8000
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
print("PASS: dead branch removed and SITE_PNL_ENV_FILE is normalised using real .env files")
PY
