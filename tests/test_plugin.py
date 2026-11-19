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
