import logging
import os
import steamback
import decky
from steamback.browser import list_save_files

logger = decky.logger


pinstance = None


def get_engine() -> object:
    # we change logging levels late because if done too early it has no effect
    logger.setLevel(logging.DEBUG)

    global pinstance
    if not pinstance:
        app_data_dir = os.environ["DECKY_PLUGIN_RUNTIME_DIR"]
        # Decky changes the runtime directory with the plugin name. Reuse the
        # existing directory on upgrades so saves and configuration stay intact.
        legacy_data_dir = os.path.join(os.path.dirname(app_data_dir), "Steamback")
        if os.path.basename(app_data_dir) == "UmeYc-SteamBack" and os.path.isdir(legacy_data_dir):
            app_data_dir = legacy_data_dir
        steam_dir = os.path.join(os.path.expanduser(
            "~"), ".local", "share", "Steam")
        config = steamback.Config(logger, app_data_dir, steam_dir)
        pinstance = steamback.Engine(config)
    return pinstance


class Plugin:

    async def list_save_files(self, directory: str):
        return list_save_files(directory)

    async def get_path_context(self):
        engine = get_engine()
        return {"home": os.path.expanduser("~"), "steam_root": engine.get_steam_root(),
                "backup_root": engine._get_savesdir()}

    async def delete_snapshot(self, filename: str):
        return await get_engine().delete_snapshot(filename)

    async def get_custom_games(self):
        return get_engine().get_custom_games()

    async def set_custom_game(self, game_info: dict, paths: list):
        return get_engine().set_custom_game(game_info, paths)

    async def update_snapshot(self, filename: str, pinned: bool, note: str = "", name: str = None):
        return await get_engine().update_snapshot(filename, pinned, note, name)

    async def set_account_id(self, id_num: int):
        # logger.info(f'Setting account id { id_num }')
        if not isinstance(id_num, int) or isinstance(id_num, bool) or not 0 < id_num < 2**32:
            raise ValueError("Steam 账号尚未加载，请稍后点击刷新")
        engine = get_engine()
        # The Decky frontend identifies the current user; don't retain IDs from
        # a previous login when the Steam account changes.
        engine.account_ids = {id_num}
        return None  # Must return something to prevent assertion error logspam in JS

    """
    Backup a particular game.

    Returns a new SaveInfo object or None if no backup was needed or possible
    SaveInfo is a dict with filename, game_id, timestamp, is_undo
    game_info is a dict of game_id and install_root
    """
    async def do_backup(self, game_info: dict, dry_run: bool) -> dict:
        return await get_engine().do_backup(game_info, dry_run)

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
        logger.info("UmeYc-SteamBack已启动")

    # Function called first during the unload process, utilize this to handle your plugin being removed
    async def _unload(self):
        logger.info("UmeYc-SteamBack已退出")
