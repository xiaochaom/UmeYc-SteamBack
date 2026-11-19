import logging
import os
import asyncio
import steamback
import decky
from steamback.browser import list_save_files
from steamback.cloud import CloudService
from steamback.sniff import SaveSniffer

logger = decky.logger


pinstance = None
cloud_instance = None
sniff_instance = None


def get_cloud():
    global cloud_instance
    if cloud_instance is None:
        cloud_instance = CloudService(get_engine())
    return cloud_instance


def get_sniffer():
    global sniff_instance
    if sniff_instance is None:
        sniff_instance = SaveSniffer(get_engine())
    return sniff_instance


def current_account():
    accounts = get_engine().account_ids
    if len(accounts) != 1:
        raise ValueError("Steam 账号尚未加载，请刷新")
    return next(iter(accounts))


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

    async def quark_account(self):
        return await asyncio.to_thread(get_cloud().account_status)

    async def quark_login_start(self):
        service = get_cloud()
        def start():
            with service.lock:
                return service.client.begin_login()
        return await asyncio.to_thread(start)

    async def quark_login_poll(self, session_id: str):
        service = get_cloud()
        def poll():
            with service.lock:
                value = service.client.poll_login(session_id)
                if value.get("state") == "logged_in":
                    service.uid = value["user_id"]
                return value
        return await asyncio.to_thread(poll)

    async def quark_login_cancel(self, session_id: str):
        service = get_cloud()
        def cancel():
            with service.lock:
                service.client.cancel_login(session_id)
        await asyncio.to_thread(cancel)

    async def quark_logout(self):
        service = get_cloud()
        def logout():
            with service.lock:
                service.uid = None
                return service.client.logout()
        return await asyncio.to_thread(logout)

    async def cloud_status(self, game_info: dict):
        return await asyncio.to_thread(get_cloud().status, current_account(), game_info)

    async def cloud_set_auto(self, game_info: dict, enabled: bool):
        return await asyncio.to_thread(get_cloud().set_auto, current_account(), game_info, enabled)

    async def cloud_start(self, game_info: dict, direction: str, revision: str = None):
        return get_cloud().start_job(current_account(), game_info, direction, revision)

    async def cloud_job(self, job_id: str):
        job = get_cloud().jobs.get(job_id)
        if not job or job["account"] != current_account():
            raise ValueError("同步任务不存在或属于其他 Steam 账号")
        return {k: v for k, v in job.items() if k not in ("account", "game_id")}

    async def sync_running_games(self, game_ids: list):
        account = current_account()
        service = get_cloud()
        before = {g for a, g in service.running if a == account}
        after = {int(g) for g in game_ids}
        for game_id in before - after:
            await self.game_lifetime(game_id, False)
        for game_id in after - before:
            await self.game_lifetime(game_id, True)

    async def game_lifetime(self, game_id: int, running: bool):
        account = current_account()
        service = get_cloud()
        key = (account, int(game_id))
        was_running = key in service.running
        if running:
            service.running.add(key)
        else:
            service.running.discard(key)
            if was_running:
                game = await asyncio.to_thread(service.auto_game, account, game_id)
                if game:
                    try:
                        service.start_job(account, game, "upload", automatic=True)
                    except ValueError as error:
                        await asyncio.to_thread(service.record_activity, account, game, {"state": "error", "message": str(error)})

    async def sniff_start(self, game_info: dict):
        account = current_account()
        if (account, int(game_info["game_id"])) in get_cloud().running:
            raise ValueError("请先退出游戏，再开始查找")
        return await asyncio.to_thread(get_sniffer().begin, game_info, account)

    async def sniff_finish(self, game_info: dict):
        account = current_account()
        if (account, int(game_info["game_id"])) in get_cloud().running:
            raise ValueError("请先退出游戏，再完成查找")
        return await asyncio.to_thread(get_sniffer().finish, game_info, account)

    async def sniff_status(self, game_info: dict):
        return await asyncio.to_thread(get_sniffer().status, game_info, current_account())

    async def sniff_cancel(self, game_info: dict):
        return await asyncio.to_thread(get_sniffer().cancel, game_info, current_account())

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
        if cloud_instance:
            cloud_instance.active_account = id_num
        return None  # Must return something to prevent assertion error logspam in JS

    """
    Backup a particular game.

    Returns a new SaveInfo object or None if no backup was needed or possible
    SaveInfo is a dict with filename, game_id, timestamp, is_undo
    game_info is a dict of game_id and install_root
    """
    async def do_backup(self, game_info: dict, dry_run: bool) -> dict:
        service = get_cloud()
        engine = service.isolated_engine(current_account())
        def backup():
            with service.lock:
                return asyncio.run(engine.do_backup(game_info, dry_run))
        return await asyncio.to_thread(backup)

    """
    Restore a particular savegame using the saveinfo object
    """
    async def do_restore(self, save_info: dict):
        service = get_cloud()
        account = current_account()
        engine = service.isolated_engine(account)
        def restore():
            with service.lock:
                engine._validate_filename(save_info["filename"])
                info = engine._file_to_saveinfo(save_info["filename"] + ".json")
                if service.active_account not in (None, account):
                    raise ValueError("Steam 账号已变化，请刷新后重试")
                if (account, int(info["game_info"]["game_id"])) in service.running:
                    raise ValueError("请先退出游戏再恢复存档")
                return asyncio.run(engine.do_restore(save_info))
        return await asyncio.to_thread(restore)

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
        if cloud_instance:
            # In-flight worker I/O owns temporary files until completion.
            # Let it finish before unloading, never cancel half a restore.
            if cloud_instance.tasks:
                await asyncio.gather(*cloud_instance.tasks, return_exceptions=True)
        logger.info("UmeYc-SteamBack已退出")
