#!/bin/sh
set -eu
python3 -B - <<'PY'
"""dotenv 入口的真实文件系统行为：参数化读取、优先级、缺省回退均为真实 .env 文件。"""
import ast
import importlib.util
import os
import pathlib
import sys
import tempfile

MANAGED = ("SITE_PNL_ENV_FILE", "SITE_PNL_LOAD_DOTENV", "SITE_PNL_HOST", "SITE_PNL_PORT")


def clear_managed() -> None:
    for key in MANAGED:
        os.environ.pop(key, None)


def load_module():
    spec = importlib.util.spec_from_file_location("settings_f4_card", "backend/app/settings.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules["settings_f4_card"] = module
    spec.loader.exec_module(module)
    return module


clear_managed()
src = pathlib.Path("backend/app/settings.py").read_text(encoding="utf-8")
tree = ast.parse(src)
cls = [node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "Settings"][0]
fn = [node for node in cls.body if isinstance(node, ast.FunctionDef) and node.name == "from_env"][0]
assert not [node for node in ast.walk(fn) if isinstance(node, ast.If)], "from_env must call the dotenv entry point unconditionally"
calls = [node for node in ast.walk(fn) if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "_read_dotenv"]
assert len(calls) == 1, f"from_env must call _read_dotenv exactly once, found {len(calls)}"
reader = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "_read_dotenv"][0]
assert [arg.arg for arg in reader.args.args] == ["env_file"], "dotenv entry must be _read_dotenv(env_file)"
assert reader.args.defaults and isinstance(reader.args.defaults[0], ast.Constant) and reader.args.defaults[0].value is None

module = load_module()
repo_root = pathlib.Path(module.REPO_ROOT)
original_env_file = None
if (repo_root / ".env").exists():
    original_env_file = (repo_root / ".env").read_text(encoding="utf-8")
try:
    with tempfile.TemporaryDirectory() as tmp:
        first = pathlib.Path(tmp, "first.env")
        first.write_text("SITE_PNL_HOST=10.0.0.1\nSITE_PNL_PORT=9101\n", encoding="utf-8")
        second = pathlib.Path(tmp, "second.env")
        second.write_text("SITE_PNL_HOST=10.0.0.2\nSITE_PNL_PORT=9202\n", encoding="utf-8")

        # 1) The parameterised entry point reads the given file.
        clear_managed()
        module._read_dotenv(str(first))
        assert os.environ["SITE_PNL_HOST"] == "10.0.0.1", os.environ.get("SITE_PNL_HOST")
        assert os.environ["SITE_PNL_PORT"] == "9101"

        # 2) The explicit parameter wins over SITE_PNL_ENV_FILE.
        clear_managed()
        os.environ["SITE_PNL_ENV_FILE"] = str(second)
        module._read_dotenv(str(first))
        assert os.environ["SITE_PNL_HOST"] == "10.0.0.1", os.environ.get("SITE_PNL_HOST")

        # 3) Without the parameter, SITE_PNL_ENV_FILE is still honoured.
        clear_managed()
        os.environ["SITE_PNL_ENV_FILE"] = str(second)
        module._read_dotenv()
        assert os.environ["SITE_PNL_HOST"] == "10.0.0.2", os.environ.get("SITE_PNL_HOST")

        # 4) Existing environment variables are never overwritten.
        clear_managed()
        os.environ["SITE_PNL_HOST"] = "env-wins"
        module._read_dotenv(str(first))
        assert os.environ["SITE_PNL_HOST"] == "env-wins", os.environ.get("SITE_PNL_HOST")

        # 5) Default fallback loads the repository-root .env, and from_env() applies it.
        clear_managed()
        (repo_root / ".env").write_text("SITE_PNL_PORT=9099\n", encoding="utf-8")
        module._read_dotenv()
        assert os.environ["SITE_PNL_PORT"] == "9099", os.environ.get("SITE_PNL_PORT")
        clear_managed()
        settings = module.Settings.from_env()
        assert settings.port == 9099, settings.port
        assert settings.host == "127.0.0.1", settings.host

        # 6) from_env() also honours SITE_PNL_ENV_FILE through the same parameterised entry.
        clear_managed()
        os.environ["SITE_PNL_ENV_FILE"] = str(second)
        assert module.Settings.from_env().port == 9202
finally:
    clear_managed()
    env_path = repo_root / ".env"
    if original_env_file is None:
        if env_path.exists():
            env_path.unlink()
    else:
        env_path.write_text(original_env_file, encoding="utf-8")

print("PASS: dotenv entry reads real files with correct priority and fallbacks")
PY
