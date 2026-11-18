"""只读浏览本地存档路径，供 Decky 内嵌路径选择页面使用。"""
import os
from pathlib import Path


def list_save_files(directory):
    if not isinstance(directory, str) or not Path(directory).expanduser().is_absolute():
        raise ValueError("请选择绝对路径")
    root = Path(directory).expanduser().resolve(strict=True)
    if root.is_file():
        root = root.parent
    if not root.is_dir():
        raise ValueError("请选择普通文件夹")
    entries = []
    truncated = False
    with os.scandir(root) as children:
        for child in children:
            if len(entries) >= 500:
                truncated = True
                break
            try:
                # Don't offer links or devices as backup sources. Users can
                # navigate to a link's actual directory by entering its path.
                if child.is_symlink():
                    continue
                folder = child.is_dir(follow_symlinks=False)
                if folder or child.is_file(follow_symlinks=False):
                    entries.append({"name": child.name, "path": str(root / child.name), "directory": folder})
            except OSError:
                continue
    entries.sort(key=lambda e: (not e["directory"], e["name"].casefold()))
    return {"directory": str(root), "parent": str(root.parent), "entries": entries, "truncated": truncated}
