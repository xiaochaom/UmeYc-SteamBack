# 桌面版使用说明

桌面版与 Decky 插件共用备份引擎，提供中文界面、逐游戏开关、自选存档路径、固定、备注、时间和手动删除。

## 安装与启动

需要 Python 3.11 或以上版本及系统 Tk 支持。请从本仓库安装；PyPI 上的 `steamback` 是上游版本，不包含本项目的改造。

```bash
python3.11 -m venv .venv
source .venv/bin/activate
python -m pip install .
steamback
```

Windows 激活命令为 `.venv\Scripts\activate`。Linux 如缺少 Tk，请通过发行版安装 `python3-tk` 或与 Python 版本对应的 Tk 包。

如果 Steam 安装在其他位置：

```bash
steamback --steampath /你的/Steam/目录
```

`steamback --help` 显示中文参数说明。`steamback --daemon` 在后台监测已开启的游戏，不显示界面；开关和路径可以先在界面中配置。

## 操作

左侧选择游戏，可以开关自动备份、选择多个存档文件或目录，也可以立即备份。自动识别不到时先选择路径，再开启备份；所有游戏默认关闭。

右侧显示备份名称、完整本地时间、是否固定及备注。选中后可以恢复、固定或解除固定、编辑备注和删除。固定备份不占每款游戏 10 个普通备份的名额，解除固定后在下一次滚动清理时才处理。

恢复采用文件覆盖，保留备份中没有的其他文件。恢复前自动保存一份撤销备份。恢复和删除均需要确认。

## 平台限制

本项目自动回归覆盖文件引擎，Steam 游戏进程监测沿用上游 Linux 实现。Windows 和 macOS 的自动退出监测尚未实现完整适配，可手动备份和恢复。桌面图形界面需要在有显示环境的系统中运行。
