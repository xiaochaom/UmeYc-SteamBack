#!python3

import argparse
import logging
import os
import platform
import platformdirs
import asyncio
from . import Engine, Config, test

"""The command line arguments"""
args = None


def main():
    """Perform command line steamback operations"""
    parser = argparse.ArgumentParser(description="UmeYc-SteamBack：手动备份和管理游戏存档")
    parser.add_argument("--debug", "-d", help="显示调试日志",
                        action="store_true")
    parser.add_argument("--test", "-t", help="运行上游集成测试（需要本机 Steam 存档）",
                        action="store_true")
    parser.add_argument("--steampath", "-s",
                        help="指定 Steam 目录，覆盖自动检测")

    global args
    args = parser.parse_args()

    logging.basicConfig(level=logging.DEBUG if args.debug else logging.INFO)
    logger = logging.getLogger()
    logger.info('UmeYc 存档备份正在启动…')

    # FIXME - I bet the following will need tweaking for Windows
    plat_sys = platform.system()
    if plat_sys == "Windows":
        logger.info("使用 Windows Steam 默认目录，可通过 --steampath 指定其他位置")
        steam_dir = os.path.join("c:/", "Program Files (x86)", "Steam")
    elif plat_sys == "Darwin":
        logger.info("使用 macOS Steam 默认目录，可通过 --steampath 指定其他位置")
        steam_dir = os.path.join(os.path.expanduser(
            "~"), "Library", "Application Support", "Steam")
    else:
        steam_deck_dir = os.path.join(os.path.expanduser(
            "~"), ".local", "share", "Steam")
        steam_dir = steam_deck_dir if os.path.exists(steam_deck_dir) else os.path.join(os.path.expanduser(
            "~"), ".steam", "debian-installation")  # the default case
    if args.steampath is not None:
        steam_dir = args.steampath if os.path.isabs(
            args.steampath) else os.path.abspath(args.steampath)

    if not os.path.exists(steam_dir):
        logger.error(
            f'找不到 Steam 目录：{steam_dir}，程序退出。')
        return

    app_name = "steamback"
    app_author = "geeksville"
    app_dir = platformdirs.user_data_dir(app_name, app_author)
    logger.info(f'备份与配置保存目录：{app_dir}')

    config = Config(logger, app_dir, steam_dir)
    e = Engine(config)
    e.auto_set_account_id()

    all_games = e.find_all_game_info()
    # print(f'All installed games: ')
    # for i in all_games:
    #    print(f'  {i}')

    if args.test:
        asyncio.run(test.testImpl(e))
    else:
        from . import gui
        gui.run(e)


if __name__ == "__main__":
    main()
