# 开发说明

## 项目结构

- `src/index.tsx`：Decky 中文界面、游戏分组、开关和游戏生命周期监听。
- `main.py`：Decky Python RPC 入口。
- `defaults/py_modules/steamback/__init__.py`：云存档识别、备份、恢复与滚动保留。
- `defaults/py_modules/steamback/custom.py`：自定义路径、游戏开关、内容校验及原子配置写入。
- `defaults/py_modules/steamback/gui.py`：中文桌面界面。
- `tests/test_backups.py`：临时目录真实文件回归测试。
- `bin/package-plugin.py`：生成 Decky 安装 ZIP，不包含依赖、缓存或玩家数据。

## 构建与测试

需要 Node.js 20、npm 及 Python 3.11。

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run test:frontend
python3.11 bin/package-plugin.py
```

CI 会执行相同检查并上传安装 ZIP。测试无需 Steam 登录或云存档网络连接，不操作真实存档。

## 保留策略

每个游戏最多保留 10 份未固定普通备份。固定备份完全排除在滚动统计外，撤销备份单独保留一份。解除固定、修改备注和改变开关只更新元数据，不执行清理。只有成功备份或恢复后才清理。

自动入口必须传递 `automatic=True`，引擎从磁盘读取游戏开关后决定是否执行；默认全关。手动入口不需要自动开关。

## 文件安全与兼容

快照复制完成后才原子写入元数据；目录后缀精确匹配，不能用前缀通配符删除，以免误删其他快照。固定状态与备注写入原快照的元数据，不改变备份时间。恢复和删除只接受已持久化的快照标识，恢复路径不信任调用端传值。

自定义备份使用文件内容摘要判断变化，不依赖游戏文件的修改时间。快照保留自己的文件清单，后续配置变更或云清单变化不会改变新快照的恢复内容。恢复为覆盖语义，相关行为见主使用说明。

插件名称为 `UmeYc-SteamBack`；若存在旧的 `Steamback` 运行数据目录，继续使用它，否则使用 Decky 分配的新目录。保留 `saves2` 数据结构，兼容上游旧元数据。不要重写或覆盖玩家历史备份来迁移固定状态。

## 真机验证

在 Steam Deck 上安装 ZIP 后，建议选择一款有云存档的游戏和一款需要自选路径的游戏，验证文件选择器、手柄焦点、逐游戏开关、退出自动备份、固定备注、解除固定后的滚动清理以及删除确认。自动回归不能替代 Steam CEF 和 Decky 的完整界面实测。
