#!/usr/bin/env python3
"""构建 Decky 安装包；必须先执行 npm run build。"""
import json
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

root = Path(__file__).resolve().parents[1]
version = json.loads((root / "package.json").read_text())["version"]
if not (root / "dist/index.js").is_file():
    raise SystemExit("缺少前端构建产物，请先执行 npm run build")
output = root / "artifacts" / f"UmeYc-SteamBack-{version}.zip"
output.parent.mkdir(exist_ok=True)
files = [root / name for name in ("main.py", "plugin.json", "package.json", "README.md", "LICENSE", "dist/index.js")]
files.extend(p for p in (root / "defaults").rglob("*") if p.is_file() and "__pycache__" not in p.parts and p.suffix != ".pyc")
with ZipFile(output, "w", ZIP_DEFLATED) as archive:
    for path in files:
        relative = path.relative_to(root).as_posix()
        if relative.startswith("defaults/py_modules/"):
            relative = relative.removeprefix("defaults/")
        archive.write(path, "UmeYc-SteamBack/" + relative)
print(output)
