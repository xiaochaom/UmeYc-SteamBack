import logging
import os
import steamback
import decky

logger = decky.logger


pinstance = None


def get_engine() -> object:
    # we change logging levels late because if done too early it has no effect
    logger.setLevel(logging.DEBUG)

    global pinstance
    if not pinstance:
        app_data_dir = os.environ["DECKY_PLUGIN_RUNTIME_DIR"]
        steam_dir = os.path.join(os.path.expanduser(
            "~"), ".local", "share", "Steam")
        config = steamback.Config(logger, app_data_dir, steam_dir)
        pinstance = steamback.Engine(config)
    return pinstance


class Plugin:

    async def get_enabled_games(self):
        return get_engine().get_enabled_games()

    async def set_game_enabled(self, game_id: int, enabled: bool):
        return get_engine().set_game_enabled(game_id, enabled)

    async def get_path_context(self):
        return {"home": os.path.expanduser("~"), "steam_root": get_engine().get_steam_root()}

    async def delete_snapshot(self, filename: str):
        return await get_engine().delete_snapshot(filename)

    async def get_custom_games(self):
        return get_engine().get_custom_games()

    async def set_custom_game(self, game_info: dict, paths: list):
        return get_engine().set_custom_game(game_info, paths)

    async def update_snapshot(self, filename: str, pinned: bool, note: str = ""):
        return await get_engine().update_snapshot(filename, pinned, note)

    async def set_account_id(self, id_num: int):
        # logger.info(f'Setting account id { id_num }')
        get_engine().add_account_id(id_num)
        return None  # Must return something to prevent assertion error logspam in JS

    """
    Backup a particular game.

    Returns a new SaveInfo object or None if no backup was needed or possible
    SaveInfo is a dict with filename, game_id, timestamp, is_undo
    game_info is a dict of game_id and install_root
    """
    async def do_backup(self, game_info: dict, dry_run: bool, automatic: bool = False) -> dict:
        return await get_engine().do_backup(game_info, dry_run, automatic)

    """
    Restore a particular savegame using the saveinfo object
    """
    async def do_restore(self, save_info: dict):
        return await get_engine().do_restore(save_info)

    """
    Given a list of game_infos, return a list of game_infos which are supported for backups
    """
    async def find_supported(self, game_infos: list) -> list[dict]:
        return await get_engine().find_supported(game_infos)

    """
    Given a list of directory names, return a list of directories that are actually mounted
    """
    async def find_mounted(self, dirs: list) -> list[dict]:
        return await get_engine().find_mounted(dirs)

    """
    Return all available saves, newest save first and undo as the absolute first

    Returns an array of SaveInfo objects
    """
    async def get_saveinfos(self) -> list[dict]:
        return await get_engine().get_saveinfos()

    # Asyncio-compatible long-running code, executed in a task when the plugin is loaded
    async def _main(self):
        logger.info("UmeYc 存档备份已启动")

    # Function called first during the unload process, utilize this to handle your plugin being removed
    async def _unload(self):
        logger.info("UmeYc 存档备份已退出")
