"""验证 Decky 的当前账号切换，不接触真实 Steam 数据。"""
import importlib.util
import logging
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch


class PluginAccount(unittest.IsolatedAsyncioTestCase):
    async def test_invalid_startup_account_is_rejected_and_login_switch_replaces_old_account(self):
        spec = importlib.util.spec_from_file_location(
            "plugin_account_test", Path(__file__).resolve().parents[1] / "main.py")
        module = importlib.util.module_from_spec(spec)
        with patch.dict("sys.modules", {"decky": SimpleNamespace(logger=logging.getLogger("test"))}):
            spec.loader.exec_module(module)
        engine = SimpleNamespace(account_ids={123})
        module.pinstance = engine
        plugin = module.Plugin()
        for invalid in (0, -1, True, "443765038", 2**32, None):
            with self.subTest(account=invalid), self.assertRaises(ValueError):
                await plugin.set_account_id(invalid)
            self.assertEqual(engine.account_ids, {123})
        await plugin.set_account_id(443765038)
        self.assertEqual(engine.account_ids, {443765038})

    async def test_game_exit_upload_only_when_enabled_and_only_once(self):
        from unittest.mock import AsyncMock, Mock
        from steamback import Config, Engine
        from steamback.cloud import CloudService
        import tempfile
        from test_cloud import MemoryQuark
        spec = importlib.util.spec_from_file_location(
            "plugin_cloud_test", Path(__file__).resolve().parents[1] / "main.py")
        module = importlib.util.module_from_spec(spec)
        with patch.dict("sys.modules", {"decky": SimpleNamespace(logger=logging.getLogger("test"))}):
            spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as temp:
            engine = Engine(Config(logging.getLogger('test'), temp, temp+'/Steam'))
            engine.account_ids = {123}
            service = CloudService(engine, MemoryQuark())
            module.pinstance, module.cloud_instance = engine, service
            game = {'game_id': 42, 'game_name': 'test', 'install_root': temp+'/Steam'}
            plugin = module.Plugin()
            with patch.object(service, 'start_job') as start:
                await plugin.game_lifetime(42, True)
                await plugin.game_lifetime(42, False)
                start.assert_not_called()
                service.set_auto(123, game, True)
                await plugin.game_lifetime(42, True)
                await plugin.game_lifetime(42, False)
                await plugin.game_lifetime(42, False)
                start.assert_called_once_with(123, game, 'upload', automatic=True)
                start.reset_mock()
                await plugin.sync_running_games([42])
                await plugin.sync_running_games([])
                start.assert_called_once_with(123, game, 'upload', automatic=True)
                start.reset_mock()
                service.set_auto(123, game, False)
                await plugin.game_lifetime(42, True)
                await plugin.game_lifetime(42, False)
                start.assert_not_called()
