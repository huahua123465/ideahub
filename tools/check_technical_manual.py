"""Detect structural drift that may require technical-manual updates.

This script uses only the Python standard library so it can run before project
dependencies are installed. It never imports application modules and therefore
does not load secrets, open the database, or create runtime directories.
"""
from __future__ import annotations

import argparse
import ast
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
SNAPSHOT_PATH = ROOT / "docs" / "TECHNICAL_MANUAL.snapshot.json"
EXCLUDED_PARTS = {
    ".venv", ".pytest_cache", "__pycache__", ".codex-tmp",
    "data", "output", "build", "dist",
}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def python_files() -> list[Path]:
    result = []
    for path in ROOT.rglob("*.py"):
        if any(part in EXCLUDED_PARTS for part in path.relative_to(ROOT).parts):
            continue
        result.append(path)
    return sorted(result)


def literal(node: ast.AST | None) -> Any:
    try:
        return ast.literal_eval(node) if node is not None else None
    except (ValueError, TypeError):
        return None


def route_inventory(tree: ast.AST) -> list[dict[str, Any]]:
    routes: list[dict[str, Any]] = []
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for decorator in node.decorator_list:
            if not isinstance(decorator, ast.Call):
                continue
            func = decorator.func
            if not (
                isinstance(func, ast.Attribute)
                and isinstance(func.value, ast.Name)
                and func.value.id == "app"
                and func.attr == "route"
            ):
                continue
            path = literal(decorator.args[0]) if decorator.args else None
            methods = ["GET"]
            for keyword in decorator.keywords:
                if keyword.arg == "methods":
                    value = literal(keyword.value)
                    if isinstance(value, (list, tuple)):
                        methods = sorted(str(item) for item in value)
            routes.append({"path": path, "methods": methods, "handler": node.name})
    return sorted(routes, key=lambda item: (str(item["path"]), item["methods"], item["handler"]))


def environment_inventory(config_text: str) -> list[dict[str, str]]:
    pattern = re.compile(
        r'(?P<name>[A-Z][A-Z0-9_]*)\s*=\s*(?:int\(|float\()?os\.getenv\('
        r'\s*["\'](?P<env>[A-Z][A-Z0-9_]*)["\']\s*,\s*(?P<default>[^\)\n]+)'
    )
    items = []
    for match in pattern.finditer(config_text):
        default = match.group("default").strip().rstrip(")").strip()
        items.append({
            "constant": match.group("name"),
            "environment": match.group("env"),
            "default_expression": default,
        })
    # Multi-line os.getenv calls are semantically important even when the
    # default is not captured by the compact pattern above.
    captured = {item["environment"] for item in items}
    for env_name in re.findall(r'os\.getenv\(\s*["\']([A-Z][A-Z0-9_]*)["\']', config_text):
        if env_name not in captured:
            items.append({
                "constant": env_name,
                "environment": env_name,
                "default_expression": "<multiline-or-derived>",
            })
    return sorted(items, key=lambda item: item["environment"])


def top_level_symbols(path: Path) -> dict[str, list[str]]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    functions = []
    classes = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and not node.name.startswith("_"):
            functions.append(node.name)
        elif isinstance(node, ast.ClassDef) and not node.name.startswith("_"):
            classes.append(node.name)
    return {"functions": sorted(functions), "classes": sorted(classes)}


def database_inventory(db_text: str) -> dict[str, list[str]]:
    tables: dict[str, list[str]] = {}
    for table_name, body in re.findall(
        r"CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\((.*?)\);",
        db_text,
        flags=re.S | re.I,
    ):
        columns = []
        for raw_line in body.splitlines():
            line = raw_line.strip().rstrip(",")
            if not line or line.upper().startswith(("UNIQUE", "PRIMARY", "FOREIGN", "CONSTRAINT")):
                continue
            match = re.match(r"([A-Za-z_]\w*)\s+", line)
            if match:
                columns.append(match.group(1))
        tables[table_name] = columns
    for column in re.findall(r"ALTER TABLE\s+tasks\s+ADD COLUMN\s+(\w+)", db_text, flags=re.I):
        if column not in tables.get("tasks", []):
            tables.setdefault("tasks", []).append(column)
    return dict(sorted(tables.items()))


def assignment_value(tree: ast.Module, name: str) -> Any:
    for node in tree.body:
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id == name:
                    return literal(node.value)
    return None


def collect() -> dict[str, Any]:
    app_path = ROOT / "app.py"
    config_path = ROOT / "config.py"
    db_path = ROOT / "db.py"
    requirements_path = ROOT / "requirements.txt"
    app_tree = ast.parse(app_path.read_text(encoding="utf-8"), filename=str(app_path))
    config_text = config_path.read_text(encoding="utf-8")
    db_text = db_path.read_text(encoding="utf-8")

    modules = {}
    test_count = 0
    for path in python_files():
        relative = path.relative_to(ROOT).as_posix()
        symbols = top_level_symbols(path)
        if symbols["functions"] or symbols["classes"]:
            modules[relative] = symbols
        if relative.startswith("tests/"):
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            test_count += sum(
                1 for node in ast.walk(tree)
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                and node.name.startswith("test_")
            )

    requirements = [
        line.strip() for line in requirements_path.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]
    return {
        "snapshot_schema": 1,
        "key_constants": {
            name: assignment_value(app_tree, name)
            for name in (
                "MAX_CONCURRENT_TASKS", "COLLECTION_MODE", "COLLECTION_MODE_LABEL",
                "STORAGE_POLICY", "CONTENT_SCHEMA_VERSION",
            )
        },
        "routes": route_inventory(app_tree),
        "environment": environment_inventory(config_text),
        "requirements": requirements,
        "requirements_sha256": sha256(requirements_path),
        "database": database_inventory(db_text),
        "modules": dict(sorted(modules.items())),
        "test_count": test_count,
    }


def describe_diff(expected: Any, actual: Any, prefix: str = "") -> list[str]:
    if expected == actual:
        return []
    if isinstance(expected, dict) and isinstance(actual, dict):
        lines = []
        for key in sorted(set(expected) | set(actual)):
            child = f"{prefix}.{key}" if prefix else key
            if key not in expected:
                lines.append(f"新增：{child}")
            elif key not in actual:
                lines.append(f"删除：{child}")
            else:
                lines.extend(describe_diff(expected[key], actual[key], child))
        return lines
    if isinstance(expected, list) and isinstance(actual, list):
        return [f"变化：{prefix}（原 {len(expected)} 项，现 {len(actual)} 项）"]
    return [f"变化：{prefix}（{expected!r} -> {actual!r}）"]


def main() -> int:
    parser = argparse.ArgumentParser(description="检查技术手册与代码结构是否漂移")
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--check", action="store_true", help="与已确认快照比较")
    action.add_argument("--update-snapshot", action="store_true", help="评审手册后确认当前快照")
    action.add_argument("--print", dest="print_snapshot", action="store_true", help="打印当前快照")
    args = parser.parse_args()

    current = collect()
    if args.print_snapshot:
        print(json.dumps(current, ensure_ascii=False, indent=2))
        return 0
    if args.update_snapshot:
        SNAPSHOT_PATH.write_text(
            json.dumps(current, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        print(f"已更新技术手册快照：{SNAPSHOT_PATH.relative_to(ROOT)}")
        return 0
    if not SNAPSHOT_PATH.is_file():
        print("未找到技术手册快照，请在完成手册评审后运行 --update-snapshot。", file=sys.stderr)
        return 1

    expected = json.loads(SNAPSHOT_PATH.read_text(encoding="utf-8"))
    differences = describe_diff(expected, current)
    if differences:
        print("检测到可能影响技术手册的结构变化：", file=sys.stderr)
        for line in differences:
            print(f"- {line}", file=sys.stderr)
        print("请评审并更新手册；确认后再运行 --update-snapshot。", file=sys.stderr)
        return 1
    print("技术手册结构快照与当前代码一致。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

