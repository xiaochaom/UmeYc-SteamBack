# 开发说明

## 项目结构

- `src/index.tsx`：Decky 中文界面、路径分组和逐行存档管理。
- `main.py`：Decky Python RPC 入口。
- `defaults/py_modules/steamback/__init__.py`：云存档识别、手动备份、恢复与元数据管理。
- `defaults/py_modules/steamback/custom.py`：自定义路径、内容校验及原子配置写入。
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

所有普通、固定和撤销备份持续保留，没有滚动清理或数量上限。固定只影响显示顺序。引擎不读取旧自动备份开关，前端不注册游戏生命周期监听，桌面不启动后台监测。

每次 `do_backup` 调用都生成新快照，即使内容没有变化。新建失败时只清理本次未完成快照，不影响已提交的历史记录。只有 `delete_snapshot` 手动入口可以删除已完成记录。

## 文件安全与兼容

快照复制完成后才原子写入元数据；目录后缀精确匹配，不能用前缀通配符删除，以免误删其他快照。固定状态与备注写入原快照的元数据，不改变备份时间。恢复和删除只接受已持久化的快照标识，恢复路径不信任调用端传值。

自定义备份使用文件内容摘要判断变化，不依赖游戏文件的修改时间。快照保留自己的文件清单，后续配置变更或云清单变化不会改变新快照的恢复内容。恢复为覆盖语义，相关行为见主使用说明。

插件名称为 `UmeYc-SteamBack`；若存在旧的 `Steamback` 运行数据目录，继续使用它，否则使用 Decky 分配的新目录。保留 `saves2` 数据结构，兼容上游旧元数据。不要重写或覆盖玩家历史备份来迁移固定状态。

## 真机验证

在 Steam Deck 上安装 ZIP 后，建议选择一款有云存档的游戏和一款需要自选路径的游戏，验证文件选择器、手柄焦点、手动备份、固定置顶、重命名及备注以及删除确认。自动回归不能替代 Steam CEF 和 Decky 的完整界面实测。
